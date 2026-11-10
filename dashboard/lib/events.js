'use strict';
// The single /events WebSocket: the hub pushes state, usage and token payloads when they
// change, and terminal previews for the cards a client says it is looking at. See NOTES.md
// "/events protocol". Authentication is the caller's (guardUpgrade) and happens before the handshake.
const fs = require('node:fs');

const MAX_CLIENTS = 32;
const MAX_BUFFERED = 1024 * 1024;
const MAX_WATCH = 50;
const MAX_PER_SESSION = 8;
const SID_RE = /^[0-9a-f-]{36}$/;

// Values that change with the clock alone must not make a payload look changed.
const VOLATILE = new Set(['now', 'elapsed', 'countdown']);
const fingerprint = (v) => JSON.stringify(v, (k, x) => (VOLATILE.has(k) ? undefined : x));

// deps: { wss, registry, api (handleApi with the payload helpers), reconciler, watchDir,
//         debounceMs?, previewMs?, pingMs?, rewatchMs?, log? }
function createEvents(deps) {
  const { wss, registry, api, reconciler, broker, watchDir, log = console.error } = deps;
  const debounceMs = deps.debounceMs ?? 100;
  const previewMs = deps.previewMs ?? 1000;
  const pingMs = deps.pingMs ?? 30000;
  const rewatchMs = deps.rewatchMs ?? 5000;
  const clients = new Set();
  const last = new Map(); // type -> { hash, msg } of what clients were last told
  let watcher = null;
  let rewatchTimer = null;
  let debounceTimer = null;
  let running = false;
  let again = false;
  let closed = false;

  const send = (ws, msg) => {
    if (ws.readyState !== 1) return;
    if (ws.bufferedAmount > MAX_BUFFERED) { ws.terminate(); return; } // a client that does not read
    ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  };

  function stateMessage() {
    const snap = reconciler.snapshot?.();
    if (!snap) return null;
    const states = {};
    for (const r of snap.values()) {
      if (r.hidden) continue;
      states[r.sid] = { status: r.status, idle: r.idle, quiet: r.quiet };
      const a = r.status === 'needs_approval' ? broker?.forSid(r.sid) : null; // the card shows only while the conversation really waits
      if (a) states[r.sid].approval = { id: a.id, tool: a.tool_name, input: a.tool_input, truncated: a.truncated, since: a.since };
    }
    return { type: 'state', states };
  }

  // One pass: build each payload; whatever differs from last time goes to every client.
  async function compute() {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        const parts = [
          ['state', async () => stateMessage()],
          ['usage', async () => ({ type: 'usage', usage: api.usagePayload() })],
          ['tokens', async () => ({ type: 'tokens', tokens: await api.tokensPayload() })],
        ];
        for (const [type, build] of parts) {
          let msg;
          try { msg = await build(); } catch { continue; } // tmux down etc.: keep the last answer
          if (!msg) continue;
          const hash = fingerprint(msg);
          const prev = last.get(type);
          if (prev && prev.hash === hash) continue;
          const text = JSON.stringify(msg);
          last.set(type, { hash, text });
          for (const c of clients) send(c.ws, text);
        }
      } while (again && !closed);
    } finally { running = false; }
  }
  const kick = () => { compute().catch((e) => log('events:', e.message)); };

  function schedule() {
    if (debounceTimer || closed || !clients.size) return;
    debounceTimer = setTimeout(() => { debounceTimer = null; kick(); }, debounceMs);
    debounceTimer.unref();
  }

  function arm() {
    if (closed || watcher) return;
    try {
      watcher = fs.watch(watchDir, { recursive: true }, schedule);
      watcher.on('error', () => { try { watcher.close(); } catch { /* gone */ } watcher = null; rearm(); });
    } catch { // directory not there yet: look again later
      watcher = null;
      rearm();
    }
  }
  function rearm() {
    if (rewatchTimer || closed) return;
    rewatchTimer = setTimeout(() => { rewatchTimer = null; arm(); }, rewatchMs);
    rewatchTimer.unref();
  }
  arm();
  reconciler.onTick?.(() => schedule()); // the backstop: a change nobody saw on disk still arrives

  // Previews: only for ids the client watches, each at most once per previewMs, and only when changed.
  async function sendPreviews(c) {
    if (c.busy) return;
    c.busy = true;
    try {
      for (const sid of c.watch) {
        const t = Date.now();
        if (t - (c.sentAt.get(sid) ?? 0) < previewMs) continue;
        let text;
        try { ({ text } = await api.preview(sid)); } catch { continue; }
        if (!c.watch.has(sid) || typeof text !== 'string' || c.sentText.get(sid) === text) continue;
        c.sentAt.set(sid, Date.now());
        c.sentText.set(sid, text);
        send(c.ws, { type: 'preview', id: sid, text });
      }
    } finally { c.busy = false; }
  }

  function onMessage(c, data) {
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (!m || typeof m !== 'object' || !Array.isArray(m.ids)) return;
    const ids = m.ids.filter((x) => typeof x === 'string' && SID_RE.test(x));
    if (m.type === 'watch') {
      for (const id of ids) if (c.watch.size < MAX_WATCH) c.watch.add(id);
      sendPreviews(c).catch(() => {});
    } else if (m.type === 'unwatch') {
      for (const id of ids) { c.watch.delete(id); c.sentAt.delete(id); c.sentText.delete(id); }
    }
  }

  function connect(ws, key) {
    const c = { key, ws, watch: new Set(), sentAt: new Map(), sentText: new Map(), busy: false, alive: true };
    clients.add(c);
    const pinger = setInterval(() => {
      if (!c.alive) { ws.terminate(); return; }
      c.alive = false;
      try { ws.ping(); } catch { /* closing */ }
    }, pingMs);
    const previewer = setInterval(() => { if (c.watch.size) sendPreviews(c).catch(() => {}); }, previewMs);
    pinger.unref(); previewer.unref();
    const drop = () => { clients.delete(c); clearInterval(pinger); clearInterval(previewer); };
    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (data) => onMessage(c, data));
    ws.on('close', drop);
    ws.on('error', drop);
    for (const { text } of last.values()) send(ws, text); // catch up, then follow
    kick(); // bring a stale cache up to date (nothing is computed while no client listens)
  }

  // Called after guardUpgrade accepted the request.
  function handleUpgrade(req, socket, head, { key }, reject) {
    if (clients.size >= MAX_CLIENTS) return reject(503, 'Service Unavailable');
    let mine = 0;
    for (const c of clients) if (c.key === key) mine++;
    if (mine >= MAX_PER_SESSION) return reject(503, 'Service Unavailable');
    registry.add(key, socket); // logout, expiry or a password change close it
    wss.handleUpgrade(req, socket, head, (ws) => connect(ws, key));
    return undefined;
  }

  function close() {
    closed = true;
    clearTimeout(debounceTimer); clearTimeout(rewatchTimer);
    try { watcher?.close(); } catch { /* gone */ }
    watcher = null;
    for (const c of clients) c.ws.terminate();
    clients.clear();
  }

  return { handleUpgrade, close, get clients() { return clients.size; } };
}

module.exports = { createEvents };
