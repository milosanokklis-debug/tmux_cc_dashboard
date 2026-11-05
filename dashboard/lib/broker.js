'use strict';
// Permission broker: a separate HTTP server on a UNIX socket (never TCP) that Claude's PermissionRequest
// hook (user ccd) posts to. A request is held open until a logged-in user decides through the normal,
// authenticated API (decide), the wait runs out, the hook goes away, or the conversation leaves
// needs_approval. This socket has exactly one route, POST /permission, and nothing on it can decide.
// Whatever ccd sends is only ever displayed; an answer is built from decide() and nothing else.
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { HttpError, readJson } = require('./http');
const { clean } = require('./state');

const MAX_BODY = 256 * 1024;
const MAX_PENDING = 50;
const MAX_INPUT_BYTES = 8 * 1024;
const MAX_MESSAGE = 500;
const SID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const PANE_RE = /^%[0-9]+$/;
const DEFAULT_SOCK = '/run/ccdash-web/broker.sock';

const waitFromEnv = () => (/^[0-9]+$/.test(process.env.CCDASH_APPROVAL_WAIT ?? '') && Number(process.env.CCDASH_APPROVAL_WAIT) > 0
  ? Number(process.env.CCDASH_APPROVAL_WAIT) : 120);

// tool_input as shown to the user: whole when its JSON fits in 8 KB, else a cut-off JSON string.
function shrink(input) {
  const json = JSON.stringify(input);
  if (Buffer.byteLength(json) <= MAX_INPUT_BYTES) return { value: input, truncated: false };
  let n = MAX_INPUT_BYTES - 64;
  let text;
  do { text = Buffer.from(json).subarray(0, n).toString('utf8'); n = Math.floor(n * 0.8); } while (Buffer.byteLength(JSON.stringify(text)) > MAX_INPUT_BYTES);
  return { value: text, truncated: true };
}

// sock: socket path (null disables the broker). readRecord(sid) -> state record or null.
function createBroker({
  sock = process.env.CCDASH_BROKER_SOCK || DEFAULT_SOCK, waitSec = waitFromEnv(),
  readRecord = () => null, now = () => Date.now(), log = console.error,
} = {}) {
  const pending = new Map(); // id -> entry
  const bySid = new Map(); // sid -> id
  const events = new EventEmitter();
  let server = null;
  let ready = Promise.resolve();
  let ident = null; // dev+ino of the socket file this instance created

  function end(res, status, body, extra = {}) {
    const data = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...extra });
    res.end(data);
  }

  function release(entry) {
    clearTimeout(entry.timer);
    pending.delete(entry.id);
    if (bySid.get(entry.sid) === entry.id) bySid.delete(entry.sid);
  }

  // No decision: 204 makes the hook print nothing, so the terminal dialog shows.
  function cancel(entry) {
    release(entry);
    if (!entry.res.writableEnded) end(entry.res, 204);
  }

  function accept(req, res, body, gone) {
    const { session_id: sid, tool_name: tool, tool_input: input, pane } = body;
    if (typeof sid !== 'string' || !SID_RE.test(sid)) throw new HttpError(400, 'bad session_id');
    if (typeof tool !== 'string' || !tool || tool.length > 200) throw new HttpError(400, 'bad tool_name');
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'bad tool_input');
    if (typeof pane !== 'string' || !PANE_RE.test(pane)) throw new HttpError(400, 'bad pane');
    if (gone() || res.destroyed || req.socket.destroyed || !req.socket.writable) return; // the hook left while the body was read: no ghost request
    const rec = readRecord(sid);
    if (!rec) throw new HttpError(404, 'unknown conversation');
    if (rec.state !== 'needs_approval') throw new HttpError(409, 'conversation is not waiting for approval');
    if (rec.pane !== pane) throw new HttpError(403, 'pane mismatch');
    if (bySid.has(sid)) throw new HttpError(409, 'a request is already pending');
    if (pending.size >= MAX_PENDING) throw new HttpError(429, 'too many pending requests');
    const shown = shrink(input);
    const createdAt = now();
    const entry = {
      id: crypto.randomBytes(8).toString('hex'), sid, res, createdAt,
      project: rec.project ? path.basename(rec.project) : '(unknown)',
      tool: clean(tool, 200) ?? '', input: shown.value, truncated: shown.truncated,
    };
    entry.timer = setTimeout(() => cancel(entry), waitSec * 1000);
    entry.timer.unref();
    pending.set(entry.id, entry);
    bySid.set(sid, entry.id);
    res.on('close', () => { if (!res.writableEnded) release(entry); }); // the hook went away
    try { events.emit('request', view(entry)); } catch { /* a listener must not break the broker */ }
  }

  const view = (e) => ({
    id: e.id, sid: e.sid, project: e.project, tool_name: e.tool, tool_input: e.input, truncated: e.truncated,
    since: Math.floor(e.createdAt / 1000),
  });

  function handle(req, res) {
    if (req.url !== '/permission') return end(res, 404, { error: 'not found' });
    if (req.method !== 'POST') return end(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
    if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      return end(res, 415, { error: 'content-type must be application/json' });
    }
    const fail = (e) => {
      if (res.headersSent || res.writableEnded) return;
      const status = e instanceof HttpError ? e.status : 400;
      if (status === 413) { res.once('finish', () => req.destroy()); return end(res, 413, { error: e.message }, { Connection: 'close' }); }
      return end(res, status, { error: e.message });
    };
    if (Number(req.headers['content-length']) > MAX_BODY) return fail(new HttpError(413, 'request body too large'));
    let gone = false;
    res.on('close', () => { gone = true; });
    return readJson(req, MAX_BODY).then((body) => accept(req, res, body, () => gone)).catch(fail);
  }

  function start() {
    if (!sock || server) return ready;
    server = http.createServer({ headersTimeout: 5000, requestTimeout: 10000, maxHeaderSize: 8 * 1024 }, handle);
    server.on('error', (e) => log(`broker: ${e.message}`));
    const srv = server;
    ready = new Promise((resolve) => {
      try {
        let st = null;
        try { st = fs.lstatSync(sock); } catch { /* absent */ }
        if (st) {
          if (!st.isSocket()) throw new Error(`${sock} exists and is not a socket`);
          fs.unlinkSync(sock);
        }
      } catch (e) { log(`broker disabled: ${e.message}`); server = null; return resolve(false); }
      srv.once('error', () => resolve(false));
      srv.listen(sock, () => {
        try {
          const made = fs.lstatSync(sock);
          ident = `${made.dev}:${made.ino}`;
          fs.chmodSync(sock, 0o660);
          fs.chownSync(sock, fs.statSync(sock).uid, fs.statSync(path.dirname(sock)).gid);
          resolve(true);
        } catch (e) { log(`broker: cannot set socket permissions: ${e.message}`); stop(); resolve(false); }
      });
    });
    return ready;
  }

  function stop() {
    for (const e of [...pending.values()]) { release(e); e.res.destroy(); }
    const srv = server;
    server = null;
    if (!srv) return;
    srv.close();
    srv.closeAllConnections();
    // Only remove the socket this instance created: a newer instance may have replaced it.
    try {
      const st = fs.lstatSync(sock);
      if (st.isSocket() && ident === `${st.dev}:${st.ino}`) fs.unlinkSync(sock);
    } catch { /* gone */ }
    ident = null;
  }

  // Called after each reconcile pass: a conversation that is no longer needs_approval no longer needs an
  // answer (the user used the terminal, or Claude moved on). Requests newer than the pass are left alone.
  function sweep(snapshot, startedAt) {
    if (!snapshot) return;
    for (const e of [...pending.values()]) {
      if (e.createdAt < startedAt && snapshot.get(e.sid)?.status !== 'needs_approval') cancel(e);
    }
  }

  function decide(id, { behavior, message } = {}) {
    const e = typeof id === 'string' ? pending.get(id) : undefined;
    if (!e || (behavior !== 'allow' && behavior !== 'deny')) return false;
    const out = { behavior };
    if (behavior === 'deny' && typeof message === 'string' && message.length <= MAX_MESSAGE) {
      const m = clean(message, MAX_MESSAGE);
      if (m) out.message = m;
    }
    release(e);
    end(e.res, 200, out);
    return true;
  }

  return {
    start, stop, sweep, decide, ready: () => ready,
    pending: () => [...pending.values()].map(view).sort((a, b) => a.since - b.since),
    forSid: (sid) => { const id = bySid.get(sid); return id ? view(pending.get(id)) : null; },
    onRequest: (cb) => { events.on('request', cb); return () => events.off('request', cb); },
  };
}

module.exports = { createBroker, MAX_MESSAGE };
