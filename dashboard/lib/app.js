'use strict';
// The dashboard HTTP application: authentication, the JSON API and the terminal WebSocket.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { WebSocketServer } = require('ws');
const authstore = require('./authstore');
const { SessionStore } = require('./sessions');
const { SocketRegistry } = require('./registry');
const { LoginLimiter } = require('./ratelimit');
const sec = require('./security');
const { HttpError, send, readJson } = require('./http');
const { createApi, defaultServices } = require('./api');
const { createTerm } = require('./term');
const { createEvents } = require('./events');
const { createBroker } = require('./broker');
const { createPush } = require('./push');
const totp = require('./totp');
const qr = require('./qr');

const ENROLL_TTL_MS = 10 * 60 * 1000;

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
// The only assets the login/setup pages need; everything else under /assets/ needs a session.
const PUBLIC_ASSETS = new Set(['style.css', 'login.js']);
// Vendored browser builds, served from node_modules under fixed names (authenticated only).
const NODE_MODULES = path.join(__dirname, '..', 'node_modules');
const VENDOR_ASSETS = {
  'xterm.js': '@xterm/xterm/lib/xterm.js',
  'xterm.css': '@xterm/xterm/css/xterm.css',
  'addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
  'addon-web-links.js': '@xterm/addon-web-links/lib/addon-web-links.js',
  'addon-clipboard.js': '@xterm/addon-clipboard/lib/addon-clipboard.js',
};

const html = (name) => fs.readFileSync(path.join(PUBLIC_DIR, name));

function createApp({
  webDir = authstore.webDir(),
  origins = sec.allowedOrigins(),
  clock = Date,
  delay = (ms) => sleep(ms),
  log = console.error,
  services = {},
  broker: brokerOpts = {}, // { sock (null = off), waitSec }
  audit = () => {}, // audit(event, { ip, outcome, ... }); hook for the audit log (ids and outcomes only)
  hashOptions, // argon2 options for recovery codes (tests use cheap ones)
} = {}) {
  const svc = { ...defaultServices(), ...services };
  svc.audit = audit;
  const rec = svc.reconciler;
  svc.broker ??= createBroker({ readRecord: rec.readOne, log, ...brokerOpts });
  rec.onTick?.((snapshot, startedAt) => svc.broker.sweep(snapshot, startedAt));
  svc.push ??= createPush({ dir: webDir, log });
  rec.onTick?.((snapshot, startedAt) => svc.push.onSnapshot(snapshot, startedAt));
  svc.broker.onRequest?.((view) => svc.push.onApproval(view));
  const handleApi = createApi(svc);
  let auth = null; // null = no usable credentials: everything except /healthz is refused
  let authStamp = null;
  let authBroken = false; // logged once per run of failures
  const generationOf = () => (auth ? auth.generation : '');
  let sessions = null; // created after the first auth read so it starts with the right generation
  const registry = new SocketRegistry();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const term = createTerm({
    wss, registry, tmuxSock: svc.tmux.sock, runFile: svc.runFile, spawnPty: svc.spawnPty,
    pingMs: svc.pingMs, cleanupMs: svc.cleanupMs,
  });
  const events = createEvents({
    wss, registry, api: handleApi, reconciler: rec, log,
    watchDir: svc.eventsDir || path.dirname(svc.agentsDir),
    ...svc.eventsOpts,
  });
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
    const changed = auth && next && auth.generation !== next.generation;
    auth = next;
    if (changed) audit('auth.change', { outcome: 'ok' }); // password or TOTP changed by `ccd passwd`
    if (sessions && sessions.setGeneration(generationOf())) { registry.closeAll(); svc.push.clear(); enrolling.clear(); }
  }
  refreshAuth();
  sessions = new SessionStore({ dir: webDir, clock, generation: generationOf() });
  svc.push.prune((k) => sessions.map.has(k));

  function tick() {
    refreshAuth();
    for (const [k, e] of enrolling) if (e.expires <= clock.now()) enrolling.delete(k);
    for (const key of sessions.sweep()) registry.closeSession(key);
    svc.push.prune((k) => sessions.map.has(k)); // also covers sessions dropped lazily on a failed validate
  }

  // Limited sessions for "TOTP required, not enrolled": in memory only, may use nothing but /api/totp/enroll.
  const enrolling = new Map(); // session key -> { expires, secret }
  const enrollSession = (req) => {
    const id = sec.sessionIdFromRequest(req);
    if (!id) return null;
    const key = sessions.keyOf(id);
    const e = enrolling.get(key);
    if (!e) return null;
    if (e.expires <= clock.now()) { enrolling.delete(key); return null; }
    return { key, e };
  };

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

    if (pathname === '/favicon.ico' && isRead) { // no icon: 204 keeps the browser console clean
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }

    if (!auth) { // no credentials yet: nothing works until `ccd passwd` has run
      if (pathname.startsWith('/assets/') && isRead) return serveAsset(res, pathname, false);
      if (isApi || !isRead) return send(res, 503, { error: 'not configured: run ccd passwd' });
      return send(res, 503, html('setup.html'), 'text/html; charset=utf-8');
    }

    const bad = sec.checkStateChanging(req, origins);
    if (bad) return send(res, bad.status, { error: bad.error });

    if (pathname.startsWith('/assets/') && isRead && PUBLIC_ASSETS.has(pathname.slice('/assets/'.length))) {
      return serveAsset(res, pathname, false);
    }

    if (pathname === '/login' && isRead) {
      if (currentSession(req)) return redirect(res, '/');
      return send(res, 200, html('login.html'), 'text/html; charset=utf-8');
    }
    if (pathname === '/login' && req.method === 'POST') return login(req, res);

    const id = currentSession(req);
    if (!id) {
      const enr = enrollSession(req);
      if (enr) return enrollRoute(req, res, pathname, enr);
      if (isApi) return send(res, 401, { error: 'unauthorized' });
      return redirect(res, '/login');
    }

    if (pathname === '/logout' && req.method === 'POST') {
      const key = sessions.keyOf(id);
      revokeKey(key);
      audit('logout', { ip: sec.clientIp(req), outcome: 'ok', session: sessions.publicId(key) });
      return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': sec.clearCookie() });
    }
    if (pathname === '/api/sessions' || pathname.startsWith('/api/sessions/')) return sessionsRoute(req, res, pathname, id);
    if (pathname === '/' && isRead) return send(res, 200, html('index.html'), 'text/html; charset=utf-8');
    if (pathname === '/sw.js' && isRead) {
      return send(res, 200, html('sw.js'), 'text/javascript; charset=utf-8', { 'Cache-Control': 'no-cache' });
    }
    if (pathname.startsWith('/assets/') && isRead) return serveAsset(res, pathname, true);
    if (isApi) return handleApi(req, res, pathname, new URL(`http://localhost${req.url}`).searchParams, { sessionKey: sessions.keyOf(id), ip: sec.clientIp(req) });
    return send(res, 404, 'not found\n', 'text/plain; charset=utf-8');
  }

  // Ends one login session: the record, its sockets (terminals, /events) and its push subscription.
  // Closing a terminal socket makes term.js kill the pty and its web-* tmux session (one per socket).
  function revokeKey(key) {
    sessions.destroyKey(key);
    registry.closeSession(key);
    svc.push.removeSession(key);
  }

  // GET /api/sessions, POST /api/sessions/revoke {id}, POST /api/sessions/revoke-all
  async function sessionsRoute(req, res, pathname, id) {
    const ip = sec.clientIp(req);
    const mine = sessions.keyOf(id);
    if (pathname === '/api/sessions') {
      if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');
      return send(res, 200, { sessions: sessions.list(mine) });
    }
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
    if (pathname === '/api/sessions/revoke-all') {
      for (const k of [...sessions.map.keys()]) revokeKey(k);
      audit('session.revoke_all', { ip, outcome: 'ok', session: sessions.publicId(mine) });
      return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': sec.clearCookie() });
    }
    if (pathname === '/api/sessions/revoke') {
      const body = await readJson(req);
      const key = sessions.keyFromPublic(body.id);
      if (!key) {
        audit('session.revoke', { ip, outcome: 'fail', reason: 'unknown' });
        throw new HttpError(404, 'no such session');
      }
      revokeKey(key);
      audit('session.revoke', { ip, outcome: 'ok', session: sessions.publicId(key) });
      return send(res, 200, { ok: true, current: key === mine }, undefined, key === mine ? { 'Set-Cookie': sec.clearCookie() } : {});
    }
    throw new HttpError(404, 'not found');
  }

  function redirect(res, to) {
    res.writeHead(302, { Location: to, 'Content-Length': 0 });
    res.end();
  }

  function serveAsset(res, pathname, authed) {
    const name = pathname.slice('/assets/'.length);
    const type = TYPES[path.extname(name)];
    if (!type || !/^[a-z0-9.-]+$/.test(name)) return send(res, 404, 'not found\n', 'text/plain; charset=utf-8');
    if (!authed && !PUBLIC_ASSETS.has(name)) return send(res, 404, 'not found\n', 'text/plain; charset=utf-8');
    const file = Object.hasOwn(VENDOR_ASSETS, name)
      ? path.join(NODE_MODULES, VENDOR_ASSETS[name]) : path.join(PUBLIC_DIR, name);
    try { return send(res, 200, fs.readFileSync(file), type); } catch {
      return send(res, 404, 'not found\n', 'text/plain; charset=utf-8');
    }
  }

  async function enrollRoute(req, res, pathname, { key, e }) {
    if (pathname !== '/api/totp/enroll' || (req.method !== 'GET' && req.method !== 'POST')) {
      return send(res, 403, { error: 'two-factor enrolment required' });
    }
    if (auth.totp) throw new HttpError(409, 'two-factor already enrolled');
    const ip = sec.clientIp(req);
    if (req.method === 'GET') {
      e.secret ??= totp.generateSecret();
      const uri = totp.otpauthUri({ secret: e.secret, account: auth.username });
      return send(res, 200, { uri, qrSvg: qr.svg(uri) });
    }
    const { code } = await readJson(req);
    if (!e.secret || typeof code !== 'string' || code.length > 20) throw new HttpError(400, 'invalid request');
    const attempt = limiter.begin(ip);
    if (attempt.locked) {
      return send(res, 429, { error: 'Too many failed attempts. Try again later.' }, undefined,
        { 'Retry-After': String(Math.ceil(attempt.retryAfterMs / 1000)) });
    }
    if (attempt.delayMs) await delay(attempt.delayMs);
    const step = totp.verify(e.secret, code, clock.now());
    attempt.finish(step !== null);
    if (step === null || enrolling.get(key) !== e) {
      audit('totp.enroll', { ip, outcome: 'fail' });
      return send(res, 401, { error: 'Invalid code.' });
    }
    const recovery = await authstore.enableTotp({ dir: webDir, secret: e.secret, step, hashOptions });
    enrolling.delete(key);
    refreshAuth();
    audit('totp.change', { ip, outcome: 'ok' });
    return send(res, 200, { ok: true, recovery }, undefined, { 'Set-Cookie': sec.sessionCookie(sessions.create({ ip, ua: req.headers['user-agent'] })) });
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
    const ip = sec.clientIp(req);
    const pwOk = await authstore.verifyLogin(creds, username, password);
    let ok = pwOk;
    if (pwOk && creds.totp) {
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      if (!code) { // password right, code still needed: not a failure
        attempt.finish(true);
        return send(res, 401, { totp: true, error: 'Enter your authentication code.' });
      }
      const step = code.length <= 32 ? totp.verify(creds.totp.secret, code, clock.now()) : null;
      if (step !== null) ok = authstore.acceptStep(webDir, step);
      else ok = code.length <= 32 && await authstore.useRecovery(webDir, code);
    }
    attempt.finish(ok);
    if (!ok) {
      log(`login failed from ${ip}`);
      audit('login', { ip, outcome: 'fail' });
      return send(res, 401, { error: pwOk && creds.totp ? 'Invalid username, password or code.' : 'Invalid username or password.' });
    }
    refreshAuth();
    if (sessions.generation !== gen) {
      return send(res, 409, { error: 'Credentials changed. Try again.' });
    }
    if (authstore.totpRequired(creds) && !creds.totp) { // limited session until a second factor is enrolled
      const eid = crypto.randomBytes(32).toString('base64url');
      enrolling.set(sessions.keyOf(eid), { expires: clock.now() + ENROLL_TTL_MS, secret: null });
      audit('login', { ip, outcome: 'enroll' });
      return send(res, 200, { ok: true, enroll: true }, undefined, { 'Set-Cookie': sec.sessionCookie(eid) });
    }
    audit('login', { ip, outcome: 'ok' });
    return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': sec.sessionCookie(sessions.create({ ip, ua: req.headers['user-agent'] })) });
  }

  function onRequest(req, res) {
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.destroy();
      if (e instanceof HttpError) {
        // After an oversize body, stop reading: answer, then drop the connection.
        if (e.status === 413) res.once('finish', () => req.destroy());
        return send(res, e.status, { ...e.extra, error: e.message }, undefined, e.status === 413 ? { Connection: 'close' } : {});
      }
      console.error('internal error:', e.message);
      send(res, 500, { error: 'internal error' });
    });
  }

  // WebSocket endpoints are /events and /term/:proj; guardUpgrade checks session and Origin first.
  function onUpgrade(req, socket, head) {
    socket.on('error', () => {});
    refreshAuth();
    if (!auth) return sec.rejectUpgrade(socket, 503, 'Service Unavailable');
    const g = sec.guardUpgrade(req, socket, { sessions, origins });
    if (!g) return;
    let pathname;
    let query;
    try { const u = new URL(`http://localhost${req.url}`); pathname = u.pathname; query = u.searchParams; } catch {
      return sec.rejectUpgrade(socket, 400, 'Bad Request');
    }
    if (pathname === '/events') {
      if (req.method !== 'GET') return sec.rejectUpgrade(socket, 404, 'Not Found');
      return events.handleUpgrade(req, socket, head, { key: g.key }, (st, text) => sec.rejectUpgrade(socket, st, text));
    }
    const m = /^\/term\/([^/]+)$/.exec(pathname);
    if (!m || req.method !== 'GET') return sec.rejectUpgrade(socket, 404, 'Not Found');
    let proj;
    try { proj = decodeURIComponent(m[1]); } catch { return sec.rejectUpgrade(socket, 400, 'Bad Request'); }
    term.handleUpgrade(req, socket, head, { key: g.key, proj, query }).catch((e) => {
      console.error('terminal upgrade failed:', e.message);
      sec.rejectUpgrade(socket, 500, 'Internal Server Error');
    });
    return undefined;
  }

  function createServer() {
    const server = http.createServer({
      headersTimeout: 5000, requestTimeout: 10000, maxHeaderSize: 16 * 1024,
    }, onRequest);
    server.on('upgrade', onUpgrade);
    // the broker lives and dies with the server: closing it destroys held requests, so hooks fall through
    svc.broker.start();
    const closeServer = server.close.bind(server);
    server.close = (cb) => { svc.broker.stop(); events.close(); return closeServer(cb); };
    server.on('close', () => { svc.broker.stop(); events.close(); });
    const timer = setInterval(tick, 30000);
    // backstop: sockets whose session vanished are closed within ~2 s
    const sweeper = setInterval(() => registry.closeWhere((key) => !sessions.map.has(key)), svc.sweepMs || 2000);
    sweeper.unref();
    server.on('close', () => clearInterval(sweeper));
    timer.unref();
    server.on('close', () => clearInterval(timer));
    return server;
  }

  return { createServer, onUpgrade, sessions, registry, limiter, tick, refreshAuth, term, events, services: svc, broker: svc.broker };
}

module.exports = { createApp };
