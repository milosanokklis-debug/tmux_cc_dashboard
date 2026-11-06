'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const { normalizeRepo, sessionNameFor, validProject } = require('../lib/projects');
const github = require('../lib/github');

const { req, ORIGIN } = h;
const JSON_POST = { origin: ORIGIN, 'x-ccdash': '1' };
const post = (s, p, json, extra = {}) => req(s.base, p, { method: 'POST', headers: { ...JSON_POST, ...extra }, json, cookie: s.cookie });
const get = (s, p) => req(s.base, p, { cookie: s.cookie });

test('normalizeRepo accepts owner/repo and GitHub URLs', () => {
  for (const [input, want] of [
    ['octo/hello', { owner: 'octo', repo: 'hello' }],
    ['  octo/hello  ', { owner: 'octo', repo: 'hello' }],
    ['https://github.com/octo/hello', { owner: 'octo', repo: 'hello' }],
    ['https://github.com/octo/hello.git', { owner: 'octo', repo: 'hello' }],
    ['https://github.com/octo/hello/', { owner: 'octo', repo: 'hello' }],
    ['https://github.com/octo/hello.git/', { owner: 'octo', repo: 'hello' }],
    ['octo/my_repo.v2-x', { owner: 'octo', repo: 'my_repo.v2-x' }],
    ['octo/_x', { owner: 'octo', repo: '_x' }],
  ]) assert.deepStrictEqual(normalizeRepo(input), want, input);
});

test('normalizeRepo rejects bad names, other hosts and traversal', () => {
  for (const bad of ['bad;name', '../x', 'a/..', 'a/b/c', 'a/', '/b', '', 'octo/.hidden', 'octo/a..b', '-oct/x', 'oc to/x',
    'octo/x y', 'octo/x;rm', 'octo/$(id)', 'http://github.com/o/r', 'https://evil.com/o/r', 'https://github.com/o',
    'https://github.com/o/r/tree/main', 'https://github.com.evil.com/o/r', 'git@github.com:o/r.git', 'o/.git',
    `${'a'.repeat(40)}/r`, 5, null, {}, ['o/r']]) {
    assert.throws(() => normalizeRepo(bad), (e) => e.status === 400, String(bad));
  }
});

test('project name rules and session name mapping match ccd-session', () => {
  assert.ok(validProject('demo') && validProject('a.b-c_d') && validProject('_x'));
  for (const bad of ['', '.x', '-x', 'a..b', 'a b', 'a/b', '../x', 'a;b']) assert.ok(!validProject(bad), bad);
  assert.strictEqual(sessionNameFor('a.b'), 'claude-a_b');
  assert.strictEqual(sessionNameFor('demo-1'), 'claude-demo-1');
});

test('github: token format; repo check uses Bearer, UA, redirect:error, timeout; only 200 passes', async () => {
  for (const bad of ['', 'a b', 'tok\nen', 'x'.repeat(300), 5, 'a;b']) assert.throws(() => github.validateToken(bad), (e) => e.status === 400);
  github.validateToken('github_pat_11AAA_bbb');
  let seen;
  const ok = (permissions) => async (url, opts) => { seen = { url, opts }; return { status: 200, json: async () => ({ permissions }) }; };
  assert.deepStrictEqual(await github.checkRepoAccess({ owner: 'o', repo: 'r', token: 'T0K', fetchImpl: ok({ push: true }) }), { canPush: true });
  assert.strictEqual(seen.url, 'https://api.github.com/repos/o/r');
  assert.strictEqual(seen.opts.headers.Authorization, 'Bearer T0K');
  assert.ok(seen.opts.headers['User-Agent']);
  assert.strictEqual(seen.opts.redirect, 'error');
  assert.ok(seen.opts.signal instanceof AbortSignal);
  assert.deepStrictEqual(await github.checkRepoAccess({ owner: 'o', repo: 'r', token: 'T', fetchImpl: ok({ push: false }) }), { canPush: false });
  assert.deepStrictEqual(await github.checkRepoAccess({ owner: 'o', repo: 'r', token: 'T', fetchImpl: ok(undefined) }), { canPush: true });
  for (const status of [301, 401, 403, 404, 500]) {
    await assert.rejects(github.checkRepoAccess({ owner: 'o', repo: 'r', token: 'SECRET', fetchImpl: async () => ({ status }) }),
      (e) => e.status === 400 && !e.message.includes('SECRET'));
  }
  await assert.rejects(github.checkRepoAccess({ owner: 'o', repo: 'r', token: 'T', fetchImpl: async () => { throw new Error('boom'); } }),
    (e) => e.status === 502);
});

test('github.saveToken writes 0640 atomically with no leftover temp files', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ccdash-git-'));
  github.saveToken({ dir, owner: 'octo', token: 'abc123', gid: null });
  const st = fs.statSync(path.join(dir, 'octo'));
  assert.strictEqual(st.mode & 0o777, 0o640);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'octo'), 'utf8'), 'abc123');
  github.saveToken({ dir, owner: 'octo', token: 'new', gid: null });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'octo'), 'utf8'), 'new');
  assert.deepStrictEqual(fs.readdirSync(dir), ['octo']);
  assert.throws(() => github.saveToken({ dir, owner: '../x', token: 't', gid: null }), (e) => e.status === 400);
});

test('github.saveToken: group ccd must end up owning a group-readable file, else error, warning without token', (t) => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ccdash-git-'));
  github.saveToken({ dir, owner: 'octo', token: 'ok', gid: process.getgid() });
  assert.strictEqual(fs.statSync(path.join(dir, 'octo')).gid, process.getgid());
  if (process.getuid() === 0) return; // root can chgrp to anything
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  t.after(() => { console.error = orig; });
  const other = process.getgid() + 12345; // a group we cannot chgrp to
  assert.throws(() => github.saveToken({ dir, owner: 'new', token: 'ghp_SECRET', gid: other }), (e) => e.status === 500);
  console.error = orig;
  assert.ok(logged.some((l) => l.includes('chgrp')));
  assert.ok(!logged.join('\n').includes('SECRET'));
  assert.deepStrictEqual(fs.readdirSync(dir), ['octo']); // no file, no temp file left
});

// ---- HTTP level -----------------------------------------------------------------------

const ROUTES = [
  ['GET', '/api/projects'],
  ['POST', '/api/projects', { repo: 'o/r' }],
  ['POST', '/api/projects/demo/open'],
  ['POST', '/api/projects/demo/pull'],
  ['GET', '/api/git-identity'],
  ['POST', '/api/git-identity', { name: 'A', email: 'a@b.co' }],
  ['POST', '/api/conversations/00000000-0000-4000-8000-000000000001/wake'],
  ['GET', '/api/tree'],
  ['GET', '/api/tree?all=1'],
  ['GET', '/assets/xterm.js'],
  ['GET', '/assets/xterm.css'],
  ['GET', '/assets/addon-fit.js'],
  ['GET', '/assets/addon-web-links.js'],
  ['GET', '/assets/addon-clipboard.js'],
];

test('every new route: no session -> 401 (API) or login redirect (assets); nothing is called', async (t) => {
  const svc = h.fakeServices();
  const s = await h.start({ services: svc });
  t.after(s.stop);
  for (const [method, p, json] of ROUTES) {
    const r = await req(s.base, p, { method, headers: method === 'POST' ? JSON_POST : {}, json });
    assert.strictEqual(r.status, p.startsWith('/api') ? 401 : 302, `${method} ${p}`);
    await r.arrayBuffer();
  }
  assert.deepStrictEqual(svc.calls, { runFile: [], runOp: [] });
});

test('every state-changing route: missing/wrong Origin or X-CCDash -> 403 even with a session', async (t) => {
  const svc = h.fakeServices();
  const s = await h.authed(svc);
  t.after(s.stop);
  for (const [method, p, json] of ROUTES.filter((r) => r[0] === 'POST')) {
    for (const headers of [{}, { origin: ORIGIN }, { 'x-ccdash': '1' }, { origin: 'https://evil.example', 'x-ccdash': '1' }]) {
      const r = await req(s.base, p, { method, headers, json, cookie: s.cookie });
      assert.strictEqual(r.status, 403, `${p} ${JSON.stringify(headers)}`);
      await r.arrayBuffer();
    }
  }
  assert.deepStrictEqual(svc.calls, { runFile: [], runOp: [] });
});

test('vendor assets need a session, are served with the same CSP and no-store; style.css/login.js stay public', async (t) => {
  const s = await h.authed(h.fakeServices());
  t.after(s.stop);
  for (const [name, type] of [['xterm.js', 'text/javascript'], ['addon-fit.js', 'text/javascript'],
    ['addon-web-links.js', 'text/javascript'], ['addon-clipboard.js', 'text/javascript'], ['xterm.css', 'text/css']]) {
    const r = await get(s, `/assets/${name}`);
    assert.strictEqual(r.status, 200, name);
    assert.ok(r.headers.get('content-type').startsWith(type));
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.ok((await r.text()).length > 1000);
  }
  for (const bad of ['xterm.mjs', 'xterm.js.map', '../package.json', 'package.json', 'index.html', 'nope.js']) {
    assert.strictEqual((await get(s, `/assets/${bad}`)).status, 404, bad);
  }
  assert.strictEqual((await req(s.base, '/assets/style.css')).status, 200);
  assert.strictEqual((await req(s.base, '/assets/login.js')).status, 200);
  assert.strictEqual((await req(s.base, '/assets/app.js')).status, 302);
  assert.strictEqual((await get(s, '/assets/app.js')).status, 200);
});

test('wrong methods give 405 and unknown API paths 404 (with a session)', async (t) => {
  const s = await h.authed(h.fakeServices());
  t.after(s.stop);
  assert.strictEqual((await post(s, '/api/tree', {})).status, 405);
  assert.strictEqual((await get(s, '/api/projects/demo/open')).status, 405);
  assert.strictEqual((await req(s.base, '/api/projects', { method: 'DELETE', headers: JSON_POST, cookie: s.cookie })).status, 405);
  assert.strictEqual((await get(s, '/api/nothing')).status, 404);
  assert.strictEqual((await post(s, '/api/projects/a/b/open', {})).status, 404);
});

test('GET / serves index.html for a session', async (t) => {
  const s = await h.authed(h.fakeServices());
  t.after(s.stop);
  const r = await get(s, '/');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
});

// ---- /api/projects state derivation (fake tmux + fake /proc) ---------------------------

test('GET /api/projects: claude / shell / none; dotfiles, files, web-* and _ops hidden', async (t) => {
  const ws = (svc, ...names) => names.forEach((n) => fs.mkdirSync(path.join(svc.workspace, n)));
  const svc = h.fakeServices();
  ws(svc, 'withclaude', 'justshell', 'nosession', '.hidden', 'a.b', 'a_b', 'bad name', 'afterclaude');
  fs.writeFileSync(path.join(svc.workspace, 'afile'), 'x');
  fs.symlinkSync('/tmp', path.join(svc.workspace, 'alink'));
  const W = svc.workspace;
  svc.tmux.listPanes = async () => [
    { session: 'claude-withclaude', window: '0', paneId: '%1', panePid: 10, active: true, projectDir: `${W}/withclaude` },
    { session: 'web-ab12cd34', window: '0', paneId: '%1', panePid: 10, active: true, projectDir: '' },
    { session: 'claude-justshell', window: '0', paneId: '%2', panePid: 20, active: true, projectDir: `${W}/justshell` },
    { session: '_ops', window: '0', paneId: '%3', panePid: 30, active: true, projectDir: '' },
    // a.b and a_b both map to claude-a_b; the session belongs to a_b
    { session: 'claude-a_b', window: '0', paneId: '%4', panePid: 40, active: true, projectDir: `${W}/a_b` },
    // claude exited in the active pane; an inactive pane still runs claude: state is the active pane's
    { session: 'claude-afterclaude', window: '0', paneId: '%5', panePid: 50, active: true, projectDir: `${W}/afterclaude` },
    { session: 'claude-afterclaude', window: '1', paneId: '%6', panePid: 60, active: false, projectDir: `${W}/afterclaude` },
  ];
  svc.procTable = () => new Map([
    [10, { ppid: 1, comm: 'bash' }], [11, { ppid: 10, comm: 'claude' }],
    [20, { ppid: 1, comm: 'bash' }], [21, { ppid: 20, comm: 'vim' }],
    [30, { ppid: 1, comm: 'bash' }], [40, { ppid: 1, comm: 'bash' }],
    [50, { ppid: 1, comm: 'bash' }], [60, { ppid: 1, comm: 'bash' }], [61, { ppid: 60, comm: 'claude' }],
  ]);
  const s = await h.authed(svc);
  t.after(s.stop);
  const r = await get(s, '/api/projects');
  assert.strictEqual(r.status, 200);
  const { projects } = await r.json();
  const byName = Object.fromEntries(projects.map((p) => [p.name, p]));
  assert.deepStrictEqual(Object.keys(byName).sort(), ['a.b', 'a_b', 'afterclaude', 'justshell', 'nosession', 'withclaude']);
  assert.deepStrictEqual(byName.withclaude, { name: 'withclaude', session: 'claude-withclaude', state: 'claude', repo: null, head: null });
  assert.deepStrictEqual(byName.justshell, { name: 'justshell', session: 'claude-justshell', state: 'shell', repo: null, head: null });
  assert.deepStrictEqual(byName.nosession, { name: 'nosession', session: null, state: 'none', repo: null, head: null });
  assert.deepStrictEqual(byName.a_b, { name: 'a_b', session: 'claude-a_b', state: 'shell', repo: null, head: null });
  assert.deepStrictEqual(byName['a.b'], { name: 'a.b', session: null, state: 'none', repo: null, head: null });
  assert.strictEqual(byName.afterclaude.state, 'shell');
});

test('GET /api/projects: tmux failure is a 503 JSON error', async (t) => {
  const svc = h.fakeServices();
  svc.tmux.listPanes = async () => { throw new Error('tmux: access not allowed'); };
  const s = await h.authed(svc);
  t.after(s.stop);
  const r = await get(s, '/api/projects');
  assert.strictEqual(r.status, 503);
  assert.match((await r.json()).error, /tmux/);
});

// ---- open ---------------------------------------------------------------------------------

test('POST /api/projects/:proj/open validates the name and folder, runs ccd-session start only', async (t) => {
  const svc = h.fakeServices();
  fs.mkdirSync(path.join(svc.workspace, 'demo'));
  const s = await h.authed(svc);
  t.after(s.stop);
  const ok = await post(s, '/api/projects/demo/open');
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(await ok.json(), { session: 'claude-demo' });
  assert.deepStrictEqual(svc.calls.runFile, [['ccd-session', 'start', 'demo']]);
  for (const [p, status] of [['/api/projects/missing/open', 404], ['/api/projects/bad%3Bname/open', 400],
    ['/api/projects/..%2Fx/open', 400], ['/api/projects/.hidden/open', 400],
    ['/api/projects/%E0%A4%A/open', 400]]) {
    const r = await post(s, p);
    assert.strictEqual(r.status, status, p);
    assert.ok((await r.json()).error);
  }
  assert.strictEqual(svc.calls.runFile.length, 1);
  assert.strictEqual(svc.calls.runOp.length, 0);
});

test('open maps ccd-session failures: collision 409, otherwise 500 with the message', async (t) => {
  const svc = h.fakeServices();
  fs.mkdirSync(path.join(svc.workspace, 'a.b'));
  svc.runFile = async () => { throw Object.assign(new Error('x'), { stderr: 'session name claude-a_b is already used by /workspace/a_b; rename the project\n' }); };
  const s = await h.authed(svc);
  t.after(s.stop);
  const r = await post(s, '/api/projects/a.b/open');
  assert.strictEqual(r.status, 409);
  assert.match((await r.json()).error, /already used/);
});

// ---- add ----------------------------------------------------------------------------------

test('POST /api/projects: validation errors are 400 and nothing runs', async (t) => {
  const svc = h.fakeServices();
  const s = await h.authed(svc);
  t.after(s.stop);
  for (const body of [{}, { repo: 'bad;name' }, { repo: '../x' }, { repo: 'a/..' }, { repo: 5 }, { repo: 'o/r', prompt: 5 },
    { repo: 'o/r', prompt: 'x'.repeat(4001) }, { repo: 'o/r', prompt: 'a\0b' }, { repo: 'o/r', token: 'bad token' },
    { repo: 'o/r', token: 7 }]) {
    const r = await post(s, '/api/projects', body);
    assert.strictEqual(r.status, 400, JSON.stringify(body).slice(0, 60));
    assert.ok((await r.json()).error);
  }
  const bad = await req(s.base, '/api/projects', { method: 'POST', headers: JSON_POST, body: '{nope', cookie: s.cookie });
  assert.strictEqual(bad.status, 400);
  assert.deepStrictEqual(svc.calls, { runFile: [], runOp: [] });
});

test('POST /api/projects: a 4000 char prompt is accepted and passed as ONE argv element', async (t) => {
  const svc = h.fakeServices();
  const s = await h.authed(svc);
  t.after(s.stop);
  const prompt = `-x ${'é'.repeat(3990)}; $(id)`;
  const r = await post(s, '/api/projects', { repo: 'https://github.com/octo/hello.git', prompt });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(await r.json(), { project: 'hello', session: 'claude-hello' });
  assert.deepStrictEqual(svc.calls.runOp, [['ccd-onboard', 'octo/hello']]);
  assert.deepStrictEqual(svc.calls.runFile, [['ccd-session', 'start', 'hello', prompt]]);
});

test('POST /api/projects: without token no GitHub call and no token file', async (t) => {
  const svc = h.fakeServices();
  const s = await h.authed(svc); // fetchImpl and saveToken throw if used
  t.after(s.stop);
  assert.strictEqual((await post(s, '/api/projects', { repo: 'o/r', token: '' })).status, 200);
});

test('POST /api/projects: token is checked BEFORE clone; rejection means no clone and no save', async (t) => {
  const svc = h.fakeServices({ fetchImpl: async () => ({ status: 404 }) });
  const s = await h.authed(svc);
  t.after(s.stop);
  const r = await post(s, '/api/projects', { repo: 'o/r', token: 'ghp_SECRETSECRET' });
  assert.strictEqual(r.status, 400);
  const text = JSON.stringify(await r.json());
  assert.ok(!text.includes('SECRET'));
  assert.deepStrictEqual(svc.calls, { runFile: [], runOp: [] });
});

test('POST /api/projects: valid token is saved, read-only token adds a warning; token never echoed', async (t) => {
  const saved = [];
  const svc = h.fakeServices({
    fetchImpl: async () => ({ status: 200, json: async () => ({ permissions: { push: false } }) }),
    saveToken: (a) => saved.push(a),
  });
  const s = await h.authed(svc);
  t.after(s.stop);
  const r = await post(s, '/api/projects', { repo: 'octo/hello', token: 'ghp_SECRETSECRET' });
  assert.strictEqual(r.status, 200);
  const body = await r.json();
  assert.deepStrictEqual(body, { project: 'hello', session: 'claude-hello', warning: 'token cannot push' });
  assert.deepStrictEqual(saved, [{ owner: 'octo', token: 'ghp_SECRETSECRET' }]);
  assert.ok(!JSON.stringify(svc.calls).includes('SECRET'));
});

test('POST /api/projects: clone failure -> 502 with log, no session started; timeout -> 504', async (t) => {
  let result = { rc: 128, log: 'fatal: repository not found\n' };
  const svc = h.fakeServices({ runOp: async () => result });
  const s = await h.authed(svc);
  t.after(s.stop);
  const r = await post(s, '/api/projects', { repo: 'o/r' });
  assert.strictEqual(r.status, 502);
  assert.deepStrictEqual(await r.json(), { error: 'clone failed', log: 'fatal: repository not found\n' });
  assert.deepStrictEqual(svc.calls.runFile, []);
  result = { timedOut: true, log: 'slow' };
  const r2 = await post(s, '/api/projects', { repo: 'o/r' });
  assert.strictEqual(r2.status, 504);
  assert.strictEqual((await r2.json()).log, 'slow');
});

test('POST /api/projects: the same repo twice at once shares ONE clone and one session start', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const svc = h.fakeServices();
  const ops = [];
  svc.runOp = async (o) => { ops.push(o.argv); if (ops.length === 1) await gate; return { rc: 0, log: '' }; };
  const s = await h.authed(svc);
  t.after(s.stop);
  const a = post(s, '/api/projects', { repo: 'o/same' });
  await new Promise((r) => setTimeout(r, 50));
  const b = post(s, '/api/projects', { repo: 'o/same' });
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(ops.length, 1);
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.strictEqual(ra.status, 200);
  assert.strictEqual(rb.status, 200);
  assert.deepStrictEqual(await rb.json(), await ra.json());
  assert.strictEqual(ops.length, 1);
  assert.strictEqual(svc.calls.runFile.length, 1); // the second call did not queue another start
  assert.strictEqual((await post(s, '/api/projects', { repo: 'o/same' })).status, 200); // slot freed afterwards
  assert.strictEqual(ops.length, 2);
});

test('POST /api/projects: a duplicate in flight with a different prompt or token gets 409; identical shares', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const svc = h.fakeServices();
  const ops = [];
  svc.runOp = async (o) => { ops.push(o.argv); await gate; return { rc: 0, log: '' }; };
  const s = await h.authed(svc);
  t.after(s.stop);
  const a = post(s, '/api/projects', { repo: 'o/diff', prompt: 'one' });
  await new Promise((r) => setTimeout(r, 50));
  const other = await post(s, '/api/projects', { repo: 'o/diff', prompt: 'two' });
  assert.strictEqual(other.status, 409);
  assert.strictEqual((await other.json()).error, 'a request for this repo is already in progress with different settings');
  const tok = await post(s, '/api/projects', { repo: 'O/DIFF', prompt: 'one', token: 'ghp_' + 'a'.repeat(36) });
  assert.strictEqual(tok.status, 409);
  const same = post(s, '/api/projects', { repo: 'o/diff', prompt: 'one' });
  await new Promise((r) => setTimeout(r, 30));
  release();
  assert.strictEqual((await a).status, 200);
  assert.strictEqual((await same).status, 200);
  assert.strictEqual(ops.length, 1);
});

test('POST /api/projects: no prompt, null and empty prompt count as the same settings', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const svc = h.fakeServices();
  const ops = [];
  svc.runOp = async (o) => { ops.push(o.argv); await gate; return { rc: 0, log: '' }; };
  const s = await h.authed(svc);
  t.after(s.stop);
  const a = post(s, '/api/projects', { repo: 'o/empty' });
  await new Promise((r) => setTimeout(r, 50));
  const b = post(s, '/api/projects', { repo: 'o/empty', prompt: '', token: '' });
  await new Promise((r) => setTimeout(r, 30));
  release();
  assert.deepStrictEqual([(await a).status, (await b).status], [200, 200]);
  assert.strictEqual(ops.length, 1);
});

test('a denied or unreachable tmux gives 503 on /api/tree and /api/projects (logged once), not an empty tree', async (t) => {
  let up = false;
  const svc = h.fakeServices();
  svc.tmux.listPanes = async () => { if (!up) throw new Error('tmux: access not allowed'); return []; };
  const s = await h.authed(svc);
  t.after(s.stop);
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  try {
    for (const p of ['/api/tree', '/api/projects', '/api/tree', '/api/projects']) {
      const r = await get(s, p);
      assert.strictEqual(r.status, 503, p);
      assert.deepStrictEqual(await r.json(), { error: 'tmux unavailable' });
    }
    assert.strictEqual(logged.filter((l) => l.includes('tmux unavailable')).length, 1);
    up = true;
    assert.strictEqual((await get(s, '/api/tree')).status, 200);
    assert.strictEqual((await get(s, '/api/projects')).status, 200);
  } finally { console.error = orig; }
});

test('GET /api/tree through the API: needs ?all=1 for old conversations; sanitized JSON', async (t) => {
  const svc = h.fakeServices();
  fs.writeFileSync(path.join(svc.agentsDir, 'x.jsonl'), [
    { ev: 'session', ts: '2026-01-01T00:00:00Z', sid: 'old', pane: '%1', win: 'claude-p:0', project: '/workspace/p' },
    { ev: 'end', ts: '2026-01-01T01:00:00Z', sid: 'old', pane: '%1', win: 'claude-p:0', project: '/workspace/p' },
  ].map((e) => JSON.stringify(e)).join('\n'));
  const s = await h.authed(svc);
  t.after(s.stop);
  const def = await (await get(s, '/api/tree')).json();
  assert.deepStrictEqual(def.projects, []);
  assert.strictEqual(def.now, Date.parse('2026-01-10T12:00:00Z') / 1000); // server time, unix seconds
  const all = await (await get(s, '/api/tree?all=1')).json();
  assert.strictEqual(all.projects[0].conversations[0].startedTs, Date.parse('2026-01-01T00:00:00Z') / 1000);
  assert.strictEqual(all.projects[0].conversations[0].endedTs, Date.parse('2026-01-01T01:00:00Z') / 1000);
  assert.strictEqual(all.projects[0].project, 'p');
  assert.strictEqual(all.projects[0].conversations[0].status, 'ended');
});
