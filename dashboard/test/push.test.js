'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFile, execFileSync } = require('node:child_process');
const { createPush, parseSubscription } = require('../lib/push');
const authstore = require('../lib/authstore');
const { createBroker } = require('../lib/broker');
const { authed, req, POST_HEADERS, fakeServices, FAST, USER, PASS, loginCookie } = require('./helpers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-push-'));

// A browser-like subscription with real keys; `ecdh` and `auth` let the e2e decrypt what arrives.
function makeSub(endpoint = `https://push.example.com/send/${crypto.randomBytes(6).toString('hex')}`) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { sub: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } }, ecdh, auth };
}

function recorder(over = {}) {
  const sent = [];
  const send = async (sub, payload, opts) => { sent.push({ sub, payload, opts }); if (over.fail) throw over.fail; };
  return { sent, send };
}
const flush = () => new Promise((r) => setTimeout(r, 20));
const snap = (o) => new Map(Object.entries(o).map(([sid, status]) => [sid, { sid, status, project: 'demo' }]));
const jsonOf = (r) => r.headers.get('content-type')?.includes('json') ? r.json() : r.text();

test('store: 0600, VAPID persists across restart, subscriptions reload', () => {
  const dir = tmp();
  const a = createPush({ dir, log: () => {} });
  assert.strictEqual(fs.statSync(path.join(dir, 'push.json')).mode & 0o777, 0o600);
  const { sub } = makeSub();
  a.subscribe('k1', sub);
  const b = createPush({ dir, log: () => {} });
  assert.strictEqual(b.publicKey(), a.publicKey());
  assert.strictEqual(b.get('k1').endpoint, sub.endpoint);
  assert.strictEqual(fs.statSync(path.join(dir, 'push.json')).mode & 0o777, 0o600);
});

test('corrupt push.json is replaced with new keys, never crashes', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'push.json'), '{nope');
  const p = createPush({ dir, log: () => {} });
  assert.ok(p.publicKey());
});

test('subscription validation', () => {
  const ok = makeSub().sub;
  assert.ok(parseSubscription(ok));
  const bad = [
    { ...ok, endpoint: 'http://push.example.com/x' },
    { ...ok, endpoint: `https://push.example.com/${'a'.repeat(2100)}` },
    { ...ok, endpoint: 'https://u:p@push.example.com/x' },
    { ...ok, endpoint: 'not a url' },
    { endpoint: ok.endpoint, keys: { p256dh: 'AAAA', auth: ok.keys.auth } },
    { endpoint: ok.endpoint, keys: { p256dh: ok.keys.p256dh, auth: 'a b' } },
    { endpoint: ok.endpoint },
    null,
  ];
  for (const b of bad) assert.throws(() => parseSubscription(b), /./);
});

test('max 20 subscriptions; same endpoint replaced; one per session', () => {
  const p = createPush({ dir: tmp(), log: () => {} });
  for (let i = 0; i < 20; i++) p.subscribe(`k${i}`, makeSub().sub);
  assert.strictEqual(p.count(), 20);
  assert.throws(() => p.subscribe('k20', makeSub().sub), /too many/);
  const same = makeSub().sub;
  p.subscribe('k0', same);
  assert.strictEqual(p.count(), 20);
  p.subscribe('k1', same); // same endpoint from another session: replaced, not duplicated
  assert.strictEqual(p.count(), 19);
  assert.strictEqual(p.get('k0'), null);
});

test('routes need a session, Origin and X-CCDash', async () => {
  const push = createPush({ dir: tmp(), log: () => {} });
  const s = await authed(fakeServices({ push }));
  try {
    const body = { subscription: makeSub().sub };
    for (const [headers, cookie, want] of [
      [POST_HEADERS, undefined, 401],
      [{ 'x-ccdash': '1' }, s.cookie, 403],
      [{ origin: POST_HEADERS.origin }, s.cookie, 403],
      [{ origin: 'https://evil.example', 'x-ccdash': '1' }, s.cookie, 403],
    ]) {
      const r = await req(s.base, '/api/push/subscribe', { method: 'POST', headers, cookie, json: body });
      assert.strictEqual(r.status, want);
    }
    assert.strictEqual(push.count(), 0);
    assert.strictEqual((await req(s.base, '/api/push/config')).status, 401);
    const ok = await req(s.base, '/api/push/subscribe', { method: 'POST', headers: POST_HEADERS, cookie: s.cookie, json: body });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(push.count(), 1);
    const bad = await req(s.base, '/api/push/subscribe', { method: 'POST', headers: POST_HEADERS, cookie: s.cookie, json: { subscription: { endpoint: 'http://x/y', keys: {} } } });
    assert.strictEqual(bad.status, 400);
  } finally { await s.stop(); }
});

test('config never serves the private key; ownership per session; logout removes only that one', async () => {
  const push = createPush({ dir: tmp(), log: () => {} });
  const s = await authed(fakeServices({ push }));
  try {
    const c2 = await loginCookie(s.base);
    const post = (path_, cookie, json) => req(s.base, path_, { method: 'POST', headers: POST_HEADERS, cookie, json });
    const cfg = async (cookie) => (await req(s.base, '/api/push/config', { cookie })).json();
    const before = await cfg(s.cookie);
    assert.deepStrictEqual(Object.keys(before).sort(), ['prefs', 'publicKey', 'subscribed']);
    assert.strictEqual(before.subscribed, false);
    await post('/api/push/subscribe', s.cookie, { subscription: makeSub().sub });
    assert.strictEqual((await cfg(s.cookie)).subscribed, true);
    assert.strictEqual((await cfg(c2)).subscribed, false); // not the other browser's
    assert.strictEqual((await post('/api/push/prefs', c2, { approval: false })).status, 409);
    await post('/api/push/subscribe', c2, { subscription: makeSub().sub });
    assert.strictEqual(push.count(), 2);
    await post('/logout', s.cookie, {});
    assert.strictEqual(push.count(), 1);
    assert.strictEqual((await cfg(c2)).subscribed, true);
    assert.strictEqual((await post('/api/push/unsubscribe', c2, {})).status, 200);
    assert.strictEqual(push.count(), 0);
  } finally { await s.stop(); }
});

test('private key is not in any API response', async () => {
  const dir = tmp();
  const push = createPush({ dir, log: () => {} });
  const priv = JSON.parse(fs.readFileSync(path.join(dir, 'push.json'), 'utf8')).vapid.privateKey;
  const s = await authed(fakeServices({ push }));
  try {
    const r = await req(s.base, '/api/push/config', { cookie: s.cookie });
    assert.ok(!(await r.text()).includes(priv));
  } finally { await s.stop(); }
});

test('expiry sweep removes subscriptions of ended sessions', async () => {
  const push = createPush({ dir: tmp(), log: () => {} });
  const s = await authed(fakeServices({ push }));
  try {
    await req(s.base, '/api/push/subscribe', { method: 'POST', headers: POST_HEADERS, cookie: s.cookie, json: { subscription: makeSub().sub } });
    assert.strictEqual(push.count(), 1);
    s.app.tick();
    assert.strictEqual(push.count(), 1);
    s.clock.advance(13 * 3600 * 1000);
    s.app.tick();
    assert.strictEqual(push.count(), 0);
  } finally { await s.stop(); }
});

test('password change deletes every subscription', async () => {
  const push = createPush({ dir: tmp(), log: () => {} });
  const s = await authed(fakeServices({ push }));
  try {
    await req(s.base, '/api/push/subscribe', { method: 'POST', headers: POST_HEADERS, cookie: s.cookie, json: { subscription: makeSub().sub } });
    assert.strictEqual(push.count(), 1);
    await authstore.setCredentials({ dir: s.dir, username: USER, password: `${PASS} changed`, hashOptions: FAST });
    s.app.refreshAuth();
    assert.strictEqual(push.count(), 0);
  } finally { await s.stop(); }
});

test('a session survives a restart, so its subscription key stays valid', async () => {
  const s = await authed(fakeServices({ push: createPush({ dir: tmp(), log: () => {} }) }));
  try {
    const { SessionStore } = require('../lib/sessions');
    const gen = s.app.sessions.generation;
    const again = new SessionStore({ dir: s.dir, clock: s.clock, generation: gen });
    assert.deepStrictEqual([...again.map.keys()], [...s.app.sessions.map.keys()]);
  } finally { await s.stop(); }
});

test('prefs are honoured, payload is exactly {project,status}', async () => {
  const r = recorder();
  const p = createPush({ dir: tmp(), send: r.send, log: () => {} });
  p.subscribe('a', makeSub().sub, { approval: true, error: false, finished: false });
  p.subscribe('b', makeSub().sub, { approval: false, error: true, finished: true });
  p.notify('approval', 'demo');
  p.notify('error', 'demo');
  p.notify('finished', 'demo');
  await flush();
  assert.strictEqual(r.sent.length, 3);
  const by = (kind) => r.sent.filter((x) => JSON.parse(x.payload).status === kind).length;
  assert.deepStrictEqual([by('needs_approval'), by('error'), by('waiting')], [1, 1, 1]);
  for (const x of r.sent) {
    assert.deepStrictEqual(Object.keys(JSON.parse(x.payload)).sort(), ['project', 'status']);
    assert.strictEqual(x.opts.TTL, 60);
    assert.strictEqual(x.opts.timeout, 10000);
  }
  assert.strictEqual(r.sent.find((x) => JSON.parse(x.payload).status === 'needs_approval').opts.urgency, 'high');
  assert.notStrictEqual(r.sent.find((x) => JSON.parse(x.payload).status === 'error').opts.urgency, 'high');
});

test('a request with secret prompt text, tool and input pushes only project and status', async () => {
  const r = recorder();
  const p = createPush({ dir: tmp(), send: r.send, log: () => {} });
  p.subscribe('a', makeSub().sub);
  const SECRET = 'hunter2-SECRET';
  const sock = path.join(tmp(), 'b.sock');
  const b = createBroker({
    sock, waitSec: 5, log: () => {},
    readRecord: () => ({ sid: 's1', state: 'needs_approval', pane: '%1', project: '/workspace/demo' }),
  });
  b.onRequest((v) => p.onApproval(v));
  await b.start();
  const ac = new AbortController();
  const body = JSON.stringify({ session_id: 's1', tool_name: `Bash-${SECRET}`, tool_input: { command: `echo ${SECRET}` }, pane: '%1' });
  const call = new Promise((resolve) => {
    const q = require('node:http').request({ socketPath: sock, path: '/permission', method: 'POST', headers: { 'content-type': 'application/json' }, signal: ac.signal }, resolve);
    q.on('error', () => resolve(null)); q.end(body);
  });
  await flush(); await flush();
  assert.strictEqual(r.sent.length, 1);
  assert.deepStrictEqual(JSON.parse(r.sent[0].payload), { project: 'demo', status: 'needs_approval' });
  assert.ok(!JSON.stringify(r.sent[0]).includes(SECRET));
  ac.abort(); await call; b.stop();
});

test('transitions: first snapshot silent, working->waiting yes, waiting->waiting no, error yes', async () => {
  const r = recorder();
  const p = createPush({ dir: tmp(), send: r.send, log: () => {} });
  p.subscribe('a', makeSub().sub);
  const statuses = () => r.sent.map((x) => JSON.parse(x.payload).status);
  p.onSnapshot(snap({ s1: 'working', s2: 'waiting', s3: 'needs_approval' }), 1);
  await flush(); assert.deepStrictEqual(statuses(), []);
  p.onSnapshot(snap({ s1: 'waiting', s2: 'waiting', s3: 'needs_approval' }), 2);
  await flush(); assert.deepStrictEqual(statuses(), ['waiting']);
  p.onSnapshot(snap({ s1: 'waiting', s2: 'waiting', s3: 'needs_approval' }), 3);
  await flush(); assert.deepStrictEqual(statuses(), ['waiting']);
  p.onSnapshot(snap({ s1: 'working', s2: 'error', s3: 'needs_approval' }), 4);
  await flush(); assert.deepStrictEqual(statuses(), ['waiting', 'error']);
  p.onSnapshot(snap({ s1: 'sleeping', s2: 'error', s3: 'ended' }), 5);
  p.onSnapshot(snap({ s1: 'waiting', s2: 'error', s3: 'ended' }), 6); // sleeping -> waiting is not a finished turn
  await flush(); assert.deepStrictEqual(statuses(), ['waiting', 'error']);
});

test('broker request and reconciler push approval once per transition', async () => {
  const r = recorder();
  const p = createPush({ dir: tmp(), send: r.send, log: () => {} });
  p.subscribe('a', makeSub().sub);
  p.onSnapshot(snap({ s1: 'working' }), 1);
  p.onApproval({ sid: 's1', project: 'demo' }); // request first
  p.onSnapshot(snap({ s1: 'working' }), 2); // stale pass (read before the request) must not reset the flag
  p.onSnapshot(snap({ s1: 'needs_approval' }), 10);
  await flush();
  assert.strictEqual(r.sent.length, 1);
  p.onSnapshot(snap({ s1: 'working' }), 20); // approved, moved on
  p.onSnapshot(snap({ s1: 'needs_approval' }), 30); // a new transition pushes again
  await flush();
  assert.strictEqual(r.sent.length, 2);
  // reconciler first, then the (late) broker view for the same transition
  p.onSnapshot(snap({ s1: 'working' }), 40);
  p.onSnapshot(snap({ s1: 'needs_approval' }), 50);
  p.onApproval({ sid: 's1', project: 'demo' });
  await flush();
  assert.strictEqual(r.sent.length, 3);
});

test('404/410 remove the subscription; other failures keep it and log no endpoint or payload', async () => {
  for (const code of [404, 410]) {
    const r = recorder({ fail: Object.assign(new Error('gone'), { statusCode: code }) });
    const p = createPush({ dir: tmp(), send: r.send, log: () => {} });
    p.subscribe('a', makeSub().sub);
    p.notify('error', 'demo');
    await flush();
    assert.strictEqual(p.count(), 0);
  }
  const logs = [];
  const r = recorder({ fail: Object.assign(new Error('boom https://push.example.com/x {"project"'), { statusCode: 500 }) });
  const p = createPush({ dir: tmp(), send: r.send, log: (...a) => logs.push(a.join(' ')) });
  p.subscribe('a', makeSub().sub);
  p.notify('error', 'demo');
  await flush();
  assert.strictEqual(p.count(), 1);
  assert.ok(logs.length === 1 && !/push\.example|project/.test(logs[0]), logs.join('|'));
});

test('a hanging send does not block the caller', () => {
  const p = createPush({ dir: tmp(), send: () => new Promise(() => {}), log: () => {} });
  p.subscribe('a', makeSub().sub);
  const t = Date.now();
  p.notify('error', 'demo');
  assert.ok(Date.now() - t < 100);
});

test('/sw.js needs a session and is served as javascript, no-cache', async () => {
  const s = await authed(fakeServices({ push: createPush({ dir: tmp(), log: () => {} }) }));
  try {
    const anon = await req(s.base, '/sw.js');
    assert.strictEqual(anon.status, 302);
    const r = await req(s.base, '/sw.js', { cookie: s.cookie });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/javascript/);
    assert.strictEqual(r.headers.get('cache-control'), 'no-cache');
    assert.match(await r.text(), /addEventListener\('push'/);
  } finally { await s.stop(); }
});

test('sw.js shows fixed text for known statuses and ignores bad payloads', () => {
  const vm = require('node:vm');
  const handlers = {};
  const shown = [];
  const self = {
    addEventListener: (n, f) => { handlers[n] = f; },
    registration: { showNotification: (t, o) => { shown.push([t, o]); return Promise.resolve(); } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8'), { self, URL });
  const fire = (data) => handlers.push({ data: { json: () => { if (data instanceof Error) throw data; return data; } }, waitUntil: () => {} });
  fire({ project: 'demo', status: 'needs_approval', body: 'EVIL' });
  fire({ project: 'demo', status: 'bogus' });
  fire(new Error('bad json'));
  fire(null);
  assert.deepStrictEqual(shown.map(([t, o]) => [t, o.body]), [['demo', 'Needs your approval']]);
  assert.strictEqual(shown[0][1].tag, 'demo:needs_approval');
});

// End to end: real web-push encryption to a local HTTPS push service (self-signed, trusted through
// NODE_EXTRA_CA_CERTS in a child process), decrypted with the subscriber's keys.
test('e2e: encrypted POST arrives and decrypts to exactly {project,status}', async (t) => {
  let have = true;
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { have = false; }
  if (!have) return t.skip('openssl not available');
  const dir = tmp();
  const key = path.join(dir, 'k.pem'); const crt = path.join(dir, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', crt,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  const got = [];
  const srv = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(crt) }, (rq, rs) => {
    const chunks = [];
    rq.on('data', (c) => chunks.push(c));
    rq.on('end', () => { got.push({ headers: rq.headers, url: rq.url, body: Buffer.concat(chunks) }); rs.writeHead(201); rs.end(); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const { sub, ecdh, auth } = makeSub(`https://127.0.0.1:${srv.address().port}/push/abc`);
    const child = `
      const { createPush } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'push.js'))});
      const p = createPush({ dir: ${JSON.stringify(dir)}, log: console.error });
      p.subscribe('k', ${JSON.stringify(sub)});
      p.notify('finished', 'demo');
      setTimeout(() => process.exit(0), 1500);`;
    const res = await new Promise((resolve) => execFile(process.execPath, ['-e', child],
      { env: { ...process.env, NODE_EXTRA_CA_CERTS: crt }, timeout: 15000 }, (err, stdout, stderr) => resolve({ err, stderr })));
    assert.ok(!res.err, res.stderr);
    assert.strictEqual(got.length, 1, res.stderr);
    assert.strictEqual(got[0].headers.ttl, '60');
    assert.match(got[0].headers.authorization, /^vapid /);
    assert.strictEqual(got[0].headers['content-encoding'], 'aes128gcm');
    const plain = require('http_ece').decrypt(got[0].body, { version: 'aes128gcm', privateKey: ecdh, authSecret: auth });
    assert.deepStrictEqual(JSON.parse(plain.toString()), { project: 'demo', status: 'waiting' });
  } finally { srv.close(); srv.closeAllConnections(); }
});
