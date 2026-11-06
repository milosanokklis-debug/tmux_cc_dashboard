'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const { readProjectRecord } = require('../lib/projects');

const { req, ORIGIN } = h;
const POSTH = { origin: ORIGIN, 'x-ccdash': '1' };
const post = (s, p, json) => req(s.base, p, { method: 'POST', headers: POSTH, json, cookie: s.cookie });
const get = (s, p) => req(s.base, p, { cookie: s.cookie });

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const pulledLog = `old ${OLD.slice(0, 7)}\nnew ${NEW.slice(0, 7)}\npulled\nhead ${NEW}\n`;
const uptodateLog = `old ${OLD.slice(0, 7)}\nnew ${OLD.slice(0, 7)}\nalready up to date\nhead ${OLD}\n`;

function setup(over = {}, record = { repo: 'octo/demo', head: OLD }) {
  const svc = h.fakeServices(over);
  fs.mkdirSync(path.join(svc.workspace, 'demo'));
  fs.mkdirSync(svc.projectsDir);
  if (record) fs.writeFileSync(path.join(svc.projectsDir, 'demo.json'), typeof record === 'string' ? record : JSON.stringify(record));
  return svc;
}
const claudeLive = (svc) => {
  svc.tmux.listPanes = async () => [{ session: 'claude-demo', window: '0', paneId: '%1', panePid: 10, active: true, projectDir: `${svc.workspace}/demo` }];
  svc.procTable = () => new Map([[10, { ppid: 1, comm: 'bash' }], [11, { ppid: 10, comm: 'claude' }]]);
};
const withOp = (svc, fn) => { svc.runOp = async (o) => { svc.calls.runOp.push(o.argv); return fn(o); }; };

test('GET /api/projects carries repo and the 7-char head from the record; bad records give null', async (t) => {
  const svc = setup();
  for (const n of ['junk', 'big', 'fifo', 'wrongtype']) fs.mkdirSync(path.join(svc.workspace, n));
  fs.writeFileSync(path.join(svc.projectsDir, 'junk.json'), '{nope');
  fs.writeFileSync(path.join(svc.projectsDir, 'big.json'), JSON.stringify({ repo: 'o/r', pad: 'x'.repeat(10000) }));
  fs.writeFileSync(path.join(svc.projectsDir, 'wrongtype.json'), JSON.stringify({ repo: 5, head: ['x'] }));
  fs.symlinkSync('/etc/hostname', path.join(svc.projectsDir, 'fifo.json'));
  const s = await h.authed(svc);
  t.after(s.stop);
  const { projects } = await (await get(s, '/api/projects')).json();
  const by = Object.fromEntries(projects.map((p) => [p.name, p]));
  assert.deepStrictEqual(by.demo, { name: 'demo', session: null, state: 'none', repo: 'octo/demo', head: OLD.slice(0, 7) });
  for (const n of ['junk', 'big', 'fifo', 'wrongtype']) assert.deepStrictEqual([by[n].repo, by[n].head], [null, null], n);
  assert.strictEqual(readProjectRecord(path.join(svc.dir, 'nonexistent'), 'x'), null);
});

test('pull: changed, no Claude -> message without the restart note; runs ccd-onboard with the recorded repo', async (t) => {
  const svc = setup();
  withOp(svc, () => ({ rc: 0, log: pulledLog }));
  const s = await h.authed(svc);
  t.after(s.stop);
  const r = await post(s, '/api/projects/demo/pull', {});
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(await r.json(), {
    project: 'demo', repo: 'octo/demo', head: 'bbbbbbb', before: 'aaaaaaa', changed: true, claude: false,
    message: 'pulled octo/demo to bbbbbbb', log: pulledLog,
  });
  assert.deepStrictEqual(svc.calls.runOp, [['ccd-onboard', 'octo/demo']]);
  assert.deepStrictEqual(svc.calls.runFile, []); // never starts a session
});

test('pull: changed with a live Claude says it was not restarted; nothing else is run', async (t) => {
  const svc = setup();
  claudeLive(svc);
  withOp(svc, () => ({ rc: 0, log: pulledLog }));
  const s = await h.authed(svc);
  t.after(s.stop);
  const j = await (await post(s, '/api/projects/demo/pull', {})).json();
  assert.strictEqual(j.claude, true);
  assert.strictEqual(j.message, 'pulled octo/demo to bbbbbbb; Claude was not restarted');
  assert.deepStrictEqual(svc.calls.runFile, []);
  assert.strictEqual(svc.calls.runOp.length, 1);
});

test('pull: already up to date, with or without Claude, has no restart note', async (t) => {
  for (const live of [false, true]) {
    const svc = setup();
    if (live) claudeLive(svc);
    withOp(svc, () => ({ rc: 0, log: uptodateLog }));
    const s = await h.authed(svc);
    t.after(s.stop);
    const j = await (await post(s, '/api/projects/demo/pull', {})).json();
    assert.strictEqual(j.changed, false);
    assert.strictEqual(j.claude, live);
    assert.strictEqual(j.message, 'already up to date at aaaaaaa');
    assert.strictEqual(j.before, 'aaaaaaa');
  }
});

test('pull: validation, missing project, missing record', async (t) => {
  const svc = setup({}, null);
  const s = await h.authed(svc);
  t.after(s.stop);
  for (const [p, status] of [['bad%3Bname', 400], ['..%2Fx', 400], ['.hidden', 400], ['%E0%A4%A', 400], ['missing', 404]]) {
    assert.strictEqual((await post(s, `/api/projects/${p}/pull`, {})).status, status, p);
  }
  const r = await post(s, '/api/projects/demo/pull', {});
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await r.json()).error, 'no onboarding record; add the project again');
  assert.strictEqual((await get(s, '/api/projects/demo/pull')).status, 405);
  assert.deepStrictEqual(svc.calls, { runFile: [], runOp: [] });
});

test('pull: exit 3 -> 409 with the last log line; other -> 502; timeout -> 504; log always present', async (t) => {
  for (const [res, status, error] of [
    [{ rc: 3, log: 'x\nuncommitted changes in demo; commit or stash first\n' }, 409, 'uncommitted changes in demo; commit or stash first'],
    [{ rc: 3, log: 'demo has diverged from origin; resolve it in a shell\n' }, 409, 'demo has diverged from origin; resolve it in a shell'],
    [{ rc: 4, log: 'could not reach the remote: nope\n' }, 502, 'pull failed'],
    [{ rc: 1, log: 'boom' }, 502, 'pull failed'],
    [{ rc: 0, log: 'garbage' }, 502, 'pull failed'],
    [{ timedOut: true, log: 'slow' }, 504, 'pull timed out'],
  ]) {
    const svc = setup();
    let seen;
    withOp(svc, (o) => { seen = o; return res; });
    const s = await h.authed(svc);
    t.after(s.stop);
    const r = await post(s, '/api/projects/demo/pull', {});
    const j = await r.json();
    assert.strictEqual(r.status, status);
    assert.strictEqual(j.error, error);
    assert.strictEqual(j.log, res.log);
    assert.strictEqual(seen.timeoutMs, 5 * 60 * 1000);
  }
});

test('pull: a second concurrent pull of the same project shares the first one', async (t) => {
  const svc = setup();
  let release;
  const gate = new Promise((r) => { release = r; });
  withOp(svc, async () => { await gate; return { rc: 0, log: pulledLog }; });
  const s = await h.authed(svc);
  t.after(s.stop);
  const a = post(s, '/api/projects/demo/pull', {});
  await new Promise((r) => setTimeout(r, 100));
  const b = post(s, '/api/projects/demo/pull', {});
  await new Promise((r) => setTimeout(r, 100));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.strictEqual(ra.status, 200);
  assert.strictEqual(rb.status, 200);
  assert.strictEqual(svc.calls.runOp.length, 1);
});

test('POST /api/projects: ccd-onboard exit 3 -> 409 with the last log line and the log', async (t) => {
  const svc = h.fakeServices();
  withOp(svc, () => ({ rc: 3, log: '/workspace/hello belongs to a different repo\n' }));
  const s = await h.authed(svc);
  t.after(s.stop);
  const r = await post(s, '/api/projects', { repo: 'octo/hello' });
  assert.strictEqual(r.status, 409);
  assert.deepStrictEqual(await r.json(), { error: '/workspace/hello belongs to a different repo', log: '/workspace/hello belongs to a different repo\n' });
  assert.deepStrictEqual(svc.calls.runFile, []);
});

test('git identity: GET parses name and email, rc 1 means unset, other failures are 502', async (t) => {
  const svc = h.fakeServices();
  let res = { rc: 0, log: 'user.name Ada Lovelace\nuser.email ada@example.com\n' };
  withOp(svc, () => res);
  const s = await h.authed(svc);
  t.after(s.stop);
  assert.deepStrictEqual(await (await get(s, '/api/git-identity')).json(), { name: 'Ada Lovelace', email: 'ada@example.com' });
  assert.deepStrictEqual(svc.calls.runOp[0], ['git', 'config', '--global', '--get-regexp', '^user\\.(name|email)$']);
  res = { rc: 1, log: '' };
  assert.deepStrictEqual(await (await get(s, '/api/git-identity')).json(), { name: null, email: null });
  res = { rc: 0, log: 'user.email only@example.com\n' };
  assert.deepStrictEqual(await (await get(s, '/api/git-identity')).json(), { name: null, email: 'only@example.com' });
  res = { rc: 128, log: 'fatal' };
  const r = await get(s, '/api/git-identity');
  assert.strictEqual(r.status, 502);
  assert.strictEqual((await r.json()).log, 'fatal');
});

test('git identity: POST sets both values with argv (no shell), trims the name, stable message', async (t) => {
  const svc = h.fakeServices();
  const s = await h.authed(svc);
  t.after(s.stop);
  const r = await post(s, '/api/git-identity', { name: '  Ada $(id) Lovelace;  ', email: 'ada@example.com' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(await r.json(), {
    ok: true, name: 'Ada $(id) Lovelace;', email: 'ada@example.com', message: 'git identity set to Ada $(id) Lovelace; ada@example.com',
  });
  assert.deepStrictEqual(svc.calls.runOp, [
    ['git', 'config', '--global', 'user.name', 'Ada $(id) Lovelace\\;'], // trailing ';' escaped for tmux
    ['git', 'config', '--global', 'user.email', 'ada@example.com'],
  ]);
});

test('git identity: hostile or malformed input is 400 and nothing runs', async (t) => {
  const svc = h.fakeServices();
  const s = await h.authed(svc);
  t.after(s.stop);
  const ok = { name: 'Ada', email: 'ada@example.com' };
  for (const bad of [
    {}, { name: 'Ada' }, { email: 'a@b.co' }, { ...ok, name: 5 }, { ...ok, email: 5 }, { ...ok, name: '' }, { ...ok, name: '   ' },
    { ...ok, name: 'x'.repeat(101) }, { ...ok, name: 'a\nb' }, { ...ok, name: 'a\0b' }, { ...ok, name: 'a\x7fb' }, { ...ok, name: 'a\x1bb' },
    { ...ok, email: 'no-at' }, { ...ok, email: 'a b@c.de' }, { ...ok, email: 'a@b' }, { ...ok, email: 'a@b@c.de' },
    { ...ok, email: 'a@b.co\nx' }, { ...ok, email: 'a@b.c\x01o' }, { ...ok, email: `${'a'.repeat(250)}@b.co` },
  ]) {
    const r = await post(s, '/api/git-identity', bad);
    assert.strictEqual(r.status, 400, JSON.stringify(bad));
    assert.ok((await r.json()).error);
  }
  assert.deepStrictEqual(svc.calls.runOp, []);
  assert.strictEqual((await req(s.base, '/api/git-identity', { method: 'PUT', headers: POSTH, cookie: s.cookie })).status, 405);
  // a name of exactly 100 characters and an email of exactly 254 are fine
  assert.strictEqual((await post(s, '/api/git-identity', { name: 'n'.repeat(100), email: `${'a'.repeat(64)}@${'b'.repeat(184)}.co` })).status, 200);
});

test('git identity: a failing git config is a 502 with the log; the second value is not attempted', async (t) => {
  const svc = h.fakeServices();
  withOp(svc, () => ({ rc: 1, log: 'error: could not lock config file' }));
  const s = await h.authed(svc);
  t.after(s.stop);
  const r = await post(s, '/api/git-identity', { name: 'Ada', email: 'ada@example.com' });
  assert.strictEqual(r.status, 502);
  assert.strictEqual((await r.json()).log, 'error: could not lock config file');
  assert.strictEqual(svc.calls.runOp.length, 1);
});
