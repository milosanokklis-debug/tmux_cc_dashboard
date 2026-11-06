'use strict';
// Web Push: VAPID keys and browser subscriptions in <webDir>/push.json (0600), and the notifier.
// A push carries only { project, status } (never prompt text, tool names or inputs). web-push
// always talks https to the browser vendor's push service (there is no plain-http mode).
const fs = require('node:fs');
const path = require('node:path');
const webpush = require('web-push');
const { writeFileAtomic } = require('./authstore');
const { proxyUrl } = require('./proxy');

const MAX_SUBS = 20;
const MAX_ENDPOINT = 2048;
const B64URL = /^[A-Za-z0-9_-]+$/;
const KINDS = ['approval', 'error', 'finished'];
const STATUS_OF = { approval: 'needs_approval', error: 'error', finished: 'waiting' };
const SEND_TIMEOUT_MS = 10000;
const DEFAULT_SUBJECT = 'mailto:ccdash@localhost';

class PushError extends Error {}

const defaultPrefs = () => ({ approval: true, error: true, finished: true });

// Strict prefs: absent -> keep `base`; present keys must be booleans. Unknown keys are refused.
function parsePrefs(p, base = defaultPrefs()) {
  if (p === undefined) return { ...base };
  if (p === null || typeof p !== 'object' || Array.isArray(p)) throw new PushError('prefs must be an object');
  const out = { ...base };
  for (const [k, v] of Object.entries(p)) {
    if (!KINDS.includes(k) || typeof v !== 'boolean') throw new PushError('prefs: approval, error and finished must be booleans');
    out[k] = v;
  }
  return out;
}

const b64urlLen = (s) => Buffer.from(s, 'base64url').length;

// Only the browser vendors' push services are accepted: the server POSTs an encrypted body to the
// subscription's URL, so an open list would be an SSRF primitive for any logged-in user. Always
// enforced (egress on or off). Exact host match, https, default port. Chrome/Edge-on-FCM, Firefox
// and Safari are covered; Edge's *.notify.windows.com is not (add it with CCDASH_PUSH_HOSTS_EXTRA,
// and to the egress allowlist). CCDASH_PUSH_HOSTS_EXTRA (comma-separated host[:port]) is for test
// stacks and unusual setups; each entry also has to be in the egress allowlist to be reachable.
const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
const extraPushHosts = (env = process.env) => String(env.CCDASH_PUSH_HOSTS_EXTRA || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

function parseSubscription(s, extra = extraPushHosts()) {
  if (s === null || typeof s !== 'object' || Array.isArray(s)) throw new PushError('subscription must be an object');
  const { endpoint, keys } = s;
  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT) throw new PushError('bad endpoint');
  let u;
  try { u = new URL(endpoint); } catch { throw new PushError('bad endpoint'); }
  if (u.protocol !== 'https:' || u.username || u.password) throw new PushError('endpoint must be an https URL');
  const known = PUSH_HOSTS.includes(u.hostname) && u.port === '';
  if (!known && !extra.includes(u.host) && !extra.includes(u.hostname)) throw new PushError('endpoint host is not an allowed push service');
  if (keys === null || typeof keys !== 'object' || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string'
    || !B64URL.test(keys.p256dh) || !B64URL.test(keys.auth)
    || b64urlLen(keys.p256dh) !== 65 || b64urlLen(keys.auth) !== 16) throw new PushError('bad keys');
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

// send(subscription, payloadString, options) -> Promise; injectable for tests.
function createPush({
  dir, subject = process.env.CCDASH_PUSH_SUBJECT || DEFAULT_SUBJECT, log = console.error,
  send = (sub, payload, opts) => webpush.sendNotification(sub, payload, opts), now = () => Date.now(),
  proxy = proxyUrl(), pushHosts = extraPushHosts(),
} = {}) {
  const file = path.join(dir, 'push.json');
  let vapid = null;
  let subs = [];

  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof d?.vapid?.publicKey === 'string' && typeof d.vapid.privateKey === 'string') {
      vapid = { publicKey: d.vapid.publicKey, privateKey: d.vapid.privateKey };
      for (const x of Array.isArray(d.subscriptions) ? d.subscriptions : []) {
        try {
          subs.push({ ...parseSubscription(x, pushHosts), sk: String(x.sk), prefs: parsePrefs(x.prefs), created: Number(x.created) || 0 });
        } catch { /* drop an invalid entry */ }
      }
    }
  } catch (e) { if (e.code !== 'ENOENT') log('push.json unreadable; generating new keys'); }
  if (!vapid) { vapid = webpush.generateVAPIDKeys(); subs = []; save(); }
  try { webpush.setVapidDetails(subject, vapid.publicKey, vapid.privateKey); } catch {
    log('CCDASH_PUSH_SUBJECT must be a mailto: or https: URL; using the default');
    subject = DEFAULT_SUBJECT;
  }

  function save() {
    try { writeFileAtomic(file, JSON.stringify({ vapid, subscriptions: subs })); } catch (e) { log('could not save push.json:', e.code || e.message); }
  }
  const drop = (fn) => { const n = subs.length; subs = subs.filter((s) => !fn(s)); if (subs.length !== n) save(); return n - subs.length; };

  // Per-conversation state for the triggers.
  let prev = null; // sid -> status of the previous snapshot; null until the first one
  const approvalPushed = new Map(); // sid -> ms when a request push went out (de-dupes the reconciler's view of it)

  function notify(kind, project) {
    const payload = JSON.stringify({ project: String(project ?? '(unknown)').slice(0, 200), status: STATUS_OF[kind] });
    for (const s of subs.filter((x) => x.prefs[kind])) {
      const opts = { TTL: 60, urgency: kind === 'approval' ? 'high' : 'normal', timeout: SEND_TIMEOUT_MS, vapidDetails: { subject, ...vapid }, ...(proxy ? { proxy } : {}) };
      Promise.resolve().then(() => send({ endpoint: s.endpoint, keys: s.keys }, payload, opts)).catch((e) => {
        const code = e?.statusCode;
        if (code === 404 || code === 410) drop((x) => x.endpoint === s.endpoint);
        else log(`push send failed (${code ?? e?.code ?? e?.message ?? 'error'})`);
      });
    }
  }

  return {
    publicKey: () => vapid.publicKey,
    count: () => subs.length,
    get: (sk) => subs.find((s) => s.sk === sk) ?? null,
    subscribe(sk, subscription, prefs) {
      const sub = parseSubscription(subscription, pushHosts);
      const mine = subs.find((s) => s.sk === sk);
      const p = parsePrefs(prefs, mine?.prefs);
      const others = subs.filter((s) => s.sk !== sk && s.endpoint !== sub.endpoint).length;
      if (others >= MAX_SUBS) throw new PushError('too many subscriptions');
      subs = subs.filter((s) => s.sk !== sk && s.endpoint !== sub.endpoint); // one per browser; same endpoint replaced
      subs.push({ ...sub, sk, prefs: p, created: now() });
      save();
      return p;
    },
    setPrefs(sk, prefs) {
      const s = subs.find((x) => x.sk === sk);
      if (!s) return null;
      s.prefs = parsePrefs(prefs, s.prefs);
      save();
      return s.prefs;
    },
    removeSession: (sk) => drop((s) => s.sk === sk),
    prune: (alive) => drop((s) => !alive(s.sk)), // sessions that ended without a logout
    clear: () => drop(() => true),
    notify,

    // Reconciler pass: status transitions. The first snapshot only records.
    onSnapshot(snapshot, startedAt) {
      if (!snapshot) return;
      const before = prev;
      prev = new Map();
      for (const [sid, e] of snapshot) {
        prev.set(sid, e.status);
        if (e.status !== 'needs_approval' && approvalPushed.has(sid) && startedAt > approvalPushed.get(sid)) approvalPushed.delete(sid);
        if (!before) continue;
        const was = before.get(sid);
        if (e.status === was || e.status === 'sleeping' || e.status === 'ended') continue;
        if (e.status === 'needs_approval') {
          if (!approvalPushed.has(sid)) notify('approval', e.project);
          approvalPushed.set(sid, startedAt);
        } else if (e.status === 'error') notify('error', e.project);
        else if (e.status === 'waiting' && was === 'working') notify('finished', e.project);
      }
      for (const sid of approvalPushed.keys()) if (!snapshot.has(sid)) approvalPushed.delete(sid);
    },
    // A new accepted permission request: immediate, and remembered so the reconciler does not repeat it.
    onApproval(view) {
      if (approvalPushed.has(view.sid)) return;
      approvalPushed.set(view.sid, now());
      notify("approval", view.project);
    },
  };
}

module.exports = { createPush, PushError, parseSubscription, defaultPrefs };
