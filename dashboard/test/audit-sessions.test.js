'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const h = require('./helpers');
const { createAudit } = require('../lib/audit');

const { ORIGIN } = h;
const PH = { origin: ORIGIN, 'x-ccdash': '1' };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-audit-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakePty() {
  const st = { spawns: 0, killed: 0 };
  st.spawnPty = () => {
    st.spawns++;
    return { onData() {}, onExit() {}, write() {}, resize() {}, kill: () => { st.killed++; } };
  };
  return st;
}

async function setup(extra = {}) {
  const pty = fakePty();
  const svc = h.fakeServices({ spawnPty: pty.spawnPty, cleanupMs: 20, sweepMs: 100, ...extra });
  const s = await h.authed(svc);
  const cookie2 = await h.loginCookie(s.base);
  const open = (p, cookie) => new Promise((resolve, reject) => {
    const ws = new WebSocket(s.base.replace('http', 'ws') + p, { headers: { origin: ORIGIN, cookie } });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
  const post = (p, cookie, json = {}) => h.req(s.base, p, { method: 'POST', headers: PH, cookie, json });
  return { pty, svc, s, cookie1: s.cookie, cookie2, open, post };
}

test('GET /api/sessions: shape, current flag, ua truncated, no cookie value', async (t) => {
  const c = await setup();
  t.after(c.s.stop);
  const res = await h.req(c.s.base, '/api/sessions', { cookie: c.cookie1 });
  assert.strictEqual(res.status, 200);
  const { sessions } = await res.json();
  assert.strictEqual(sessions.length, 2);
  assert.deepStrictEqual(Object.keys(sessions[0]).sort(), ['created', 'current', 'id', 'ip', 'lastSeen', 'ua']);
  assert.strictEqual(sessions.filter((x) => x.current).length, 1);
  assert.match(sessions[0].id, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(sessions).includes(c.cookie1.split('=')[1]));
  // unauthenticated and wrong method
  assert.strictEqual((await h.req(c.s.base, '/api/sessions')).status, 401);
  assert.strictEqual((await h.req(c.s.base, '/api/sessions', { method: 'POST', headers: PH, cookie: c.cookie1, json: {} })).status, 405);
  // POST needs Origin and X-CCDash
  assert.strictEqual((await h.req(c.s.base, '/api/sessions/revoke-all', { method: 'POST', cookie: c.cookie1, json: {} })).status, 403);
  const long = await h.req(c.s.base, '/login', { method: 'POST', headers: { ...PH, 'user-agent': 'U'.repeat(500) }, json: { username: h.USER, password: h.PASS } });
  const ck = long.headers.get('set-cookie').split(';')[0];
  const list = await (await h.req(c.s.base, '/api/sessions', { cookie: ck })).json();
  assert.ok(list.sessions.every((x) => x.ua.length <= 200));
  assert.ok(list.sessions.some((x) => x.ua.length === 200));
});

test('revoke closes that session\'s terminal and event sockets within 5 s; others unaffected', async (t) => {
  const c = await setup();
  t.after(c.s.stop);
  const ws1 = await c.open('/term/demo', c.cookie1);
  const ev1 = await c.open('/events', c.cookie1);
  const ws2 = await c.open('/term/demo', c.cookie2);
  await wait(30);
  const list = (await (await h.req(c.s.base, '/api/sessions', { cookie: c.cookie2 })).json()).sessions;
  const other = list.find((x) => !x.current);
  const closed = Promise.all([ws1, ev1].map((w) => new Promise((r) => w.once('close', r))));
  const t0 = Date.now();
  const res = await c.post('/api/sessions/revoke', c.cookie2, { id: other.id });
  assert.deepStrictEqual(await res.json(), { ok: true, current: false });
  await closed;
  assert.ok(Date.now() - t0 < 5000);
  await wait(100);
  assert.strictEqual(c.pty.killed, 1);
  assert.ok(c.svc.calls.runFile.some((a) => a.includes('kill-session')), 'web-* tmux session removed');
  assert.strictEqual(ws2.readyState, WebSocket.OPEN);
  assert.strictEqual((await h.req(c.s.base, '/api/sessions', { cookie: c.cookie1 })).status, 401);
  assert.strictEqual((await h.req(c.s.base, '/api/sessions', { cookie: c.cookie2 })).status, 200);
  assert.strictEqual((await c.post('/api/sessions/revoke', c.cookie2, { id: other.id })).status, 404);
  assert.strictEqual((await c.post('/api/sessions/revoke', c.cookie2, { id: 'zz' })).status, 404);
});

test('sweeper closes sockets whose session vanished without revoke', async (t) => {
  const c = await setup();
  t.after(c.s.stop);
  const ws = await c.open('/term/demo', c.cookie1);
  const closed = new Promise((r) => ws.once('close', r));
  c.s.app.sessions.map.clear(); // vanished behind the registry's back
  await closed;
});

test('revoke-all logs out everywhere, clears the cookie, closes sockets', async (t) => {
  const c = await setup();
  t.after(c.s.stop);
  const ws1 = await c.open('/term/demo', c.cookie1);
  const ws2 = await c.open('/term/demo', c.cookie2);
  const closed = Promise.all([ws1, ws2].map((w) => new Promise((r) => w.once('close', r))));
  const res = await c.post('/api/sessions/revoke-all', c.cookie1);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
  await closed;
  for (const ck of [c.cookie1, c.cookie2]) assert.strictEqual((await h.req(c.s.base, '/api/sessions', { cookie: ck })).status, 401);
  assert.strictEqual(c.s.app.sessions.map.size, 0);
});

test('enrol-mode session cannot use the sessions routes', async (t) => {
  const s = await h.start();
  t.after(s.stop);
  const authstore = require('../lib/authstore');
  await authstore.setCredentials({ dir: s.dir, username: h.USER, password: h.PASS, hashOptions: h.FAST });
  authstore.setTotpRequired({ dir: s.dir, required: true });
  s.app.refreshAuth();
  const res = await h.login(s.base);
  assert.strictEqual((await res.json()).enroll, true);
  const ck = res.headers.get('set-cookie').split(';')[0];
  assert.strictEqual((await h.req(s.base, '/api/sessions', { cookie: ck })).status, 403);
  assert.strictEqual((await h.req(s.base, '/api/sessions/revoke-all', { method: 'POST', headers: PH, cookie: ck, json: {} })).status, 403);
});

test('audit log: approve and failed login recorded, mode 0600, no prompt text or token', async (t) => {
  const dir = tmpDir();
  const audit = createAudit({ dir });
  const decided = [];
  const CANARY = 'CANARY-PROMPT-TEXT';
  const TOKEN = 'github_pat_CANARYTOKEN0123456789';
  const svc = h.fakeServices({
    broker: { decide: (id, d) => { decided.push([id, d]); return true; }, forSid: () => null, sweep() {}, start() {}, stop() {} },
    saveToken: () => {},
    fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ permissions: { push: true } }) }),
  });
  const s = await h.start({ services: svc, audit: audit.log });
  t.after(() => { s.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.strictEqual((await h.login(s.base, {}, { username: h.USER, password: 'wrong' })).status, 401);
  const cookie = await h.loginCookie(s.base);
  const r = await h.req(s.base, '/api/approvals/0123456789abcdef/decision', {
    method: 'POST', headers: PH, cookie, json: { behavior: 'allow', message: CANARY },
  });
  assert.strictEqual(r.status, 200);
  await h.req(s.base, '/api/projects', { method: 'POST', headers: PH, cookie, json: { repo: 'o/r', token: TOKEN, prompt: CANARY } });
  await h.req(s.base, '/logout', { method: 'POST', headers: PH, cookie, json: {} });
  const file = path.join(dir, 'audit.log');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.event === 'login' && l.outcome === 'fail'));
  assert.ok(lines.some((l) => l.event === 'approve' && l.outcome === 'ok' && l.request === '0123456789abcdef'));
  assert.ok(lines.some((l) => l.event === 'logout'));
  assert.ok(lines.some((l) => l.event === 'token.saved'));
  assert.ok(lines.every((l) => l.ts && !('ua' in l)));
  for (const bad of [CANARY, TOKEN, 'CANARYTOKEN', 'wrong']) assert.ok(!text.includes(bad), bad);
});

test('audit whitelist drops unknown keys and unsafe values', () => {
  const dir = tmpDir();
  const a = createAudit({ dir });
  a.log('x', { prompt: 'secret', text: 't', input: 'i', token: 'k', code: 'c', password: 'p', ua: 'Mozilla', outcome: 'ok', project: 'has space', ip: '1.2.3.4' });
  const l = JSON.parse(fs.readFileSync(a.file, 'utf8'));
  assert.deepStrictEqual(Object.keys(l).sort(), ['event', 'ip', 'outcome', 'ts']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('audit rotation keeps 5 files in total (audit.log + .1 to .4)', () => {
  const dir = tmpDir();
  const a = createAudit({ dir, maxBytes: 300, keep: 5 });
  for (let i = 0; i < 60; i++) a.log('login', { ip: '1.2.3.4', outcome: 'ok' });
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('audit.log')).sort();
  assert.deepStrictEqual(files, ['audit.log', 'audit.log.1', 'audit.log.2', 'audit.log.3', 'audit.log.4']);
  for (const f of files) assert.strictEqual(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});
