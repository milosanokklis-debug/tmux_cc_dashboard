'use strict';
// Step 3 (AC-3.2): project windows over the API. Fake svc.runFile plays `ccd-session windows|new|close|select`
// with two projects; a window id belonging to another project makes `close` exit 1.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('./helpers');
const { createAudit } = require('../lib/audit');

const { req, ORIGIN } = h;
const post = (s, p, json, extra = {}) => req(s.base, p, { method: 'POST', headers: { origin: ORIGIN, 'x-ccdash': '1', ...extra }, json, cookie: s.cookie });
const get = (s, p) => req(s.base, p, { cookie: s.cookie });

function svcWith({ loggedIn = true } = {}) {
  const svc = h.fakeServices();
  for (const n of ['a', 'b']) fs.mkdirSync(path.join(svc.workspace, n));
  svc.state = { loggedIn, wins: { a: [
    { id: '@1', index: 0, name: 'claude', active: true, kind: 'claude', pid: 100 },
    { id: '@2', index: 1, name: 'shell', active: false, kind: 'shell', pid: 101 },
  ], b: [{ id: '@9', index: 0, name: 'claude', active: true, kind: 'claude', pid: 200 }] }, next: 20 };
  svc.runFile = async (file, args) => {
    svc.calls.runFile.push([file, ...args]);
    const [cmd, name, arg] = args;
    const fail = (code, msg) => { throw Object.assign(new Error(`exit ${code}`), { code, stderr: `${msg}\n` }); };
    if (cmd === 'auth') return { stdout: svc.state.loggedIn ? 'logged-in\n' : 'logged-out\n', stderr: '' };
    if (cmd === 'windows') return { stdout: (svc.state.wins[name] || []).map((w) => JSON.stringify(w)).join('\n') + '\n', stderr: '' };
    if (cmd === 'new') {
      if (arg && !['claude', 'shell'].includes(arg)) fail(2, 'bad kind');
      if (arg === 'claude' && !svc.state.loggedIn) fail(9, 'logged out');
      const id = `@${svc.state.next++}`;
      svc.state.wins[name].push({ id, index: svc.state.wins[name].length, name: arg, active: false, kind: arg, pid: 1 });
      return { stdout: `${id}\n`, stderr: '' };
    }
    if (cmd === 'close') {
      const i = (svc.state.wins[name] || []).findIndex((w) => w.id === arg);
      if (i < 0) fail(1, `window ${arg} is not in project ${name}`);
      svc.state.wins[name].splice(i, 1);
      return { stdout: '', stderr: '' };
    }
    return { stdout: `claude-${name}\n`, stderr: '' };
  };
  return svc;
}
const base = '/api/projects';

test('AC-3.2 GET windows returns that project\'s windows only', async (t) => {
  const s = await h.authed(svcWith());
  t.after(s.stop);
  const r = await get(s, `${base}/a/windows`);
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  const list = Array.isArray(j) ? j : j.windows;
  assert.deepStrictEqual(list.map((w) => w.id), ['@1', '@2']);
  assert.deepStrictEqual(list.map((w) => w.kind), ['claude', 'shell']);
  assert.strictEqual((await req(s.base, `${base}/a/windows`)).status, 401);
  assert.strictEqual((await get(s, `${base}/bad%3Bname/windows`)).status, 400);
});

test('AC-3.2 POST windows {kind:shell} creates one and the list shows it', async (t) => {
  const svc = svcWith();
  const s = await h.authed(svc);
  t.after(s.stop);
  const r = await post(s, `${base}/a/windows`, { kind: 'shell' });
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.match(j.id, /^@\d+$/);
  assert.ok(svc.calls.runFile.some((c) => c[0] === 'ccd-session' && c[1] === 'new' && c[2] === 'a' && c[3] === 'shell'));
  const list = await (await get(s, `${base}/a/windows`)).json();
  assert.ok((Array.isArray(list) ? list : list.windows).some((w) => w.id === j.id));
});

test('AC-3.2 bad kind is 400 and nothing is created; claude when logged out is 409 login-required', async (t) => {
  const svc = svcWith({ loggedIn: false });
  const s = await h.authed(svc);
  t.after(s.stop);
  for (const kind of ['login', 'root', '', 5, undefined]) assert.strictEqual((await post(s, `${base}/a/windows`, { kind })).status, 400, String(kind));
  assert.ok(!svc.calls.runFile.some((c) => c[1] === 'new'), 'ccd-session new not run for bad kinds');
  const r = await post(s, `${base}/a/windows`, { kind: 'claude' });
  assert.strictEqual(r.status, 409);
  assert.deepStrictEqual(await r.json(), { error: 'login-required' });
});

test('AC-3.2 close: own window 200; another project\'s window 404; bad id 400', async (t) => {
  const svc = svcWith();
  const s = await h.authed(svc);
  t.after(s.stop);
  assert.strictEqual((await post(s, `${base}/a/windows/%409/close`)).status, 404); // @9 belongs to b
  assert.strictEqual(svc.state.wins.b.length, 1);
  for (const id of ['x', '%40', '%401%3Bid', '1', '%40-1', '..']) assert.strictEqual((await post(s, `${base}/a/windows/${id}/close`)).status, 400, id);
  assert.strictEqual((await post(s, `${base}/a/windows/%402/close`)).status, 200);
  assert.deepStrictEqual(svc.state.wins.a.map((w) => w.id), ['@1']);
});

test('AC-3.2 select returns 200 and acts on the window id; bad id is 400', async (t) => {
  const svc = svcWith();
  svc.calls.tmux = [];
  svc.tmux.run = async (argv) => { svc.calls.tmux.push(argv); return ''; };
  const s = await h.authed(svc);
  t.after(s.stop);
  assert.strictEqual((await post(s, `${base}/a/windows/zz/select`)).status, 400);
  const r = await post(s, `${base}/a/windows/%402/select`);
  assert.strictEqual(r.status, 200);
  const acted = [...svc.calls.runFile, ...svc.calls.tmux].some((c) => c.includes('@2'));
  assert.ok(acted, 'select-window / ccd-session select was called with @2');
});

test('AC-3.2 every POST needs Origin and X-CCDash (403 without) and nothing runs', async (t) => {
  const svc = svcWith();
  const s = await h.authed(svc);
  t.after(s.stop);
  for (const [p, json] of [[`${base}/a/windows`, { kind: 'shell' }], [`${base}/a/windows/%402/close`], [`${base}/a/windows/%402/select`]]) {
    assert.strictEqual((await post(s, p, json, { origin: 'https://evil.example' })).status, 403, `${p} origin`);
    assert.strictEqual((await post(s, p, json, { 'x-ccdash': '' })).status, 403, `${p} header`);
  }
  assert.ok(!svc.calls.runFile.some((c) => ['new', 'close', 'select'].includes(c[1])));
});

test('AC-3.2 changes are audited with names only', async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-win-')));
  const audit = createAudit({ dir });
  const s = await h.start({ services: svcWith(), audit: audit.log });
  t.after(s.stop);
  s.cookie = await h.loginCookie(s.base);
  await post(s, `${base}/a/windows`, { kind: 'shell', note: 'SECRET-TEXT' });
  await post(s, `${base}/a/windows/%402/close`);
  await post(s, `${base}/a/windows/%401/select`);
  const log = fs.readFileSync(audit.file, 'utf8');
  assert.ok(!log.includes('SECRET-TEXT'));
  const es = log.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const word of ['new', 'close', 'select']) {
    const e = es.find((x) => x.event.includes('window') && x.event.includes(word) && x.outcome === 'ok');
    assert.ok(e, `audit entry for window ${word}`);
    assert.strictEqual(e.project, 'a');
  }
});
