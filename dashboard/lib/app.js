'use strict';
// The dashboard HTTP application. Authentication only: no project/terminal features.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const authstore = require('./authstore');
const { SessionStore } = require('./sessions');
const { SocketRegistry } = require('./registry');
const { LoginLimiter } = require('./ratelimit');
const sec = require('./security');

const MAX_BODY = 8 * 1024;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(data), ...extra });
  res.end(data);
}
const html = (name) => fs.readFileSync(path.join(PUBLIC_DIR, name));

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'request body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
        resolve(v);
      } catch { reject(new HttpError(400, 'invalid JSON')); }
    });
    req.on('error', () => reject(new HttpError(400, 'bad request')));
  });
}

function createApp({
  webDir = authstore.webDir(),
  origins = sec.allowedOrigins(),
  clock = Date,
  delay = (ms) => sleep(ms),
  log = console.error,
} = {}) {
  let auth = null; // null = no usable credentials: everything except /healthz is refused
  let authStamp = null;
  let authBroken = false; // logged once per run of failures
  const generationOf = () => (auth ? auth.generation : '');
  let sessions = null; // created after the first auth read so it starts with the right generation
  const registry = new SocketRegistry();
  const limiter = new LoginLimiter({ clock });
  const authFile = path.join(webDir, 'auth.json');

  // Picks up `ccd passwd` runs without a restart; a new generation ends all sessions.
  function refreshAuth() {
    let stamp = 'none';
    try { const st = fs.statSync(authFile); stamp = `${st.ino}:${st.mtimeMs}:${st.size}`; } catch { /* absent */ }
    if (stamp === authStamp) return;
    let next;
    try {
      next = authstore.readAuth(webDir);
    } catch (e) {
      // Corrupt or unreadable: fail closed. Keep the previous state (no password at
      // startup, the old credentials later) and retry on the next request/tick.
      if (!authBroken) log(`auth.json problem, keeping previous state: ${e.message}`);
      authBroken = true;
      return;
    }
    authBroken = false;
    authStamp = stamp;
    auth = next;
    if (sessions && sessions.setGeneration(generationOf())) registry.closeAll();
  }
  refreshAuth();
  sessions = new SessionStore({ dir: webDir, clock, generation: generationOf() });

  function tick() {
    refreshAuth();
    for (const key of sessions.sweep()) registry.closeSession(key);
    registry.closeWhere((key) => !sessions.map.has(key));
  }

  const currentSession = (req) => {
    const id = sec.sessionIdFromRequest(req);
    return id && sessions.validate(id) ? id : null;
  };

  async function handle(req, res) {
    for (const [k, v] of Object.entries(sec.SECURITY_HEADERS)) res.setHeader(k, v);
    refreshAuth();
    if (!req.url.startsWith('/')) throw new HttpError(400, 'bad request');
    let pathname;
    try { ({ pathname } = new URL(`http://localhost${req.url}`)); } catch { throw new HttpError(400, 'bad request'); }
    const isApi = pathname === '/api' || pathname.startsWith('/api/');
    const isRead = req.method === 'GET' || req.method === 'HEAD';

    if (pathname === '/healthz' && isRead) return send(res, 200, 'ok\n', 'text/plain; charset=utf-8');

    if (!auth) { // no credentials yet: nothing works until `ccd passwd` has run
      if (pathname.startsWith('/assets/') && isRead) return serveAsset(res, pathname);
      if (isApi || !isRead) return send(res, 503, { error: 'not configured: run ccd passwd' });
      return send(res, 503, html('setup.html'), 'text/html; charset=utf-8');
    }

    const bad = sec.checkStateChanging(req, origins);
    if (bad) return send(res, bad.status, { error: bad.error });

    if (pathname.startsWith('/assets/') && isRead) return serveAsset(res, pathname);

    if (pathname === '/login' && isRead) {
      if (currentSession(req)) return redirect(res, '/');
      return send(res, 200, html('login.html'), 'text/html; charset=utf-8');
    }
    if (pathname === '/login' && req.method === 'POST') return login(req, res);

    const id = currentSession(req);
    if (!id) {
      if (isApi) return send(res, 401, { error: 'unauthorized' });
      return redirect(res, '/login');
    }

    if (pathname === '/logout' && req.method === 'POST') {
      const key = sessions.keyOf(id);
      sessions.destroy(id);
      registry.closeSession(key);
      return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': sec.clearCookie() });
    }
    if (pathname === '/' && isRead) return send(res, 200, html('index.html'), 'text/html; charset=utf-8');
    if (isApi) return send(res, 404, { error: 'not found' });
    return send(res, 404, 'not found\n', 'text/plain; charset=utf-8');
  }

  function redirect(res, to) {
    res.writeHead(302, { Location: to, 'Content-Length': 0 });
    res.end();
  }

  function serveAsset(res, pathname) {
    const name = pathname.slice('/assets/'.length);
    const type = TYPES[path.extname(name)];
    if (!type || !/^[a-z0-9.-]+$/.test(name)) return send(res, 404, 'not found\n', 'text/plain; charset=utf-8');
    try { return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, name)), type); } catch {
      return send(res, 404, 'not found\n', 'text/plain; charset=utf-8');
    }
  }

  async function login(req, res) {
    const body = await readJson(req);
    const { username, password } = body;
    if (typeof username !== 'string' || typeof password !== 'string'
      || username.length > authstore.MAX_USERNAME_LENGTH || password.length > authstore.MAX_PASSWORD_LENGTH) {
      throw new HttpError(400, 'invalid credentials format');
    }
    const attempt = limiter.begin(sec.clientIp(req));
    if (attempt.locked) {
      return send(res, 429, { error: 'Too many failed attempts. Try again later.' }, undefined,
        { 'Retry-After': String(Math.ceil(attempt.retryAfterMs / 1000)) });
    }
    if (attempt.delayMs) await delay(attempt.delayMs);
    // Verify against the credentials as they were when the attempt started; if the
    // password changed while argon2 ran, the login is discarded (no session).
    const creds = auth;
    const gen = sessions.generation;
    const ok = await authstore.verifyLogin(creds, username, password);
    attempt.finish(ok);
    if (!ok) {
      log(`login failed from ${sec.clientIp(req)}`);
      return send(res, 401, { error: 'Invalid username or password.' });
    }
    refreshAuth();
    if (sessions.generation !== gen) {
      return send(res, 409, { error: 'Credentials changed. Try again.' });
    }
    return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': sec.sessionCookie(sessions.create()) });
  }

  function onRequest(req, res) {
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.destroy();
      if (e instanceof HttpError) {
        // After an oversize body, stop reading: answer, then drop the connection.
        if (e.status === 413) res.once('finish', () => req.destroy());
        return send(res, e.status, { error: e.message }, undefined, e.status === 413 ? { Connection: 'close' } : {});
      }
      console.error('internal error:', e.message);
      send(res, 500, { error: 'internal error' });
    });
  }

  // Future WebSocket endpoints go here: after guardUpgrade passes, complete the
  // handshake and call registry.add(key, socket). None exist yet.
  function onUpgrade(req, socket) {
    socket.on('error', () => {});
    refreshAuth();
    if (!auth) return sec.rejectUpgrade(socket, 503, 'Service Unavailable');
    const g = sec.guardUpgrade(req, socket, { sessions, origins });
    if (g) sec.rejectUpgrade(socket, 404, 'Not Found');
  }

  function createServer() {
    const server = http.createServer({
      headersTimeout: 5000, requestTimeout: 10000, maxHeaderSize: 16 * 1024,
    }, onRequest);
    server.on('upgrade', onUpgrade);
    const timer = setInterval(tick, 30000);
    timer.unref();
    server.on('close', () => clearInterval(timer));
    return server;
  }

  return { createServer, onUpgrade, sessions, registry, limiter, tick, refreshAuth };
}

module.exports = { createApp };
