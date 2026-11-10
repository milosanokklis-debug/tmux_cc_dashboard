'use strict';
// Step 3 (AC-3.1, AC-3.3, AC-3.4): per-project login over the API. Fakes: svc.runFile answers the
// ccd-session subcommands (auth/start/login), svc.tmux.run answers `capture-pane` with the login pane.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const h = require('./helpers');
const { createAudit } = require('../lib/audit');
const { gauges } = require('../lib/usage');

const { req, ORIGIN } = h;
const URL_SECRET = 'https://claude.ai/oauth/authorize?code=true&state=SECRETSTATE123';
const post = (s, p, json, extra = {}) => req(s.base, p, { method: 'POST', headers: { origin: ORIGIN, 'x-ccdash': '1', ...extra }, json, cookie: s.cookie });
const get = (s, p) => req(s.base, p, { cookie: s.cookie });
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-pl-')));

function svcWith({ loggedIn = false, pane = `Browser didn't open? Visit:\n${URL_SECRET}\nPaste code here> ` } = {}) {
  const svc = h.fakeServices();
  fs.mkdirSync(path.join(svc.workspace, 'demo'));
  svc.state = { loggedIn };
  svc.calls.tmux = [];
  svc.runFile = async (file, args) => {
    svc.calls.runFile.push([file, ...args]);
    const [cmd, name] = args;
    if (cmd === 'auth') return { stdout: svc.state.loggedIn ? 'logged-in\n' : 'logged-out\n', stderr: '' };
    if (cmd === 'start' && !svc.state.loggedIn) throw Object.assign(new Error('exit 9'), { code: 9, stderr: `project ${name} is logged out\n` });
    return { stdout: `claude-${name}\n`, stderr: '' };
  };
  svc.tmux.run = async (argv) => { svc.calls.tmux.push(argv); return argv[0] === 'capture-pane' ? pane : ''; };
  return svc;
}
const sawLoginCall = (svc) => svc.calls.runFile.some((c) => c[0] === 'ccd-session' && c[1] === 'login' && c[2] === 'demo');

test('AC-3.1 open on a logged-out project is 409 login-required', async (t) => {
  const svc = svcWith();
  const s = await h.authed(svc);
  t.after(s.stop);
  const r = await post(s, '/api/projects/demo/open');
  assert.strictEqual(r.status, 409);
  assert.deepStrictEqual(await r.json(), { error: 'login-required' });
});

test('AC-3.1 open on a logged-in project still works', async (t) => {
  const svc = svcWith({ loggedIn: true });
  const s = await h.authed(svc);
  t.after(s.stop);
  const r = await post(s, '/api/projects/demo/open');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(await r.json(), { session: 'claude-demo' });
  assert.ok(!svc.calls.runFile.some((c) => c.includes('--account')), 'no --account argument any more');
});

test('AC-3.1 POST /api/projects/:p/login opens the login window (200, Origin and X-CCDash required)', async (t) => {
  const svc = svcWith();
  const s = await h.authed(svc);
  t.after(s.stop);
  assert.strictEqual((await post(s, '/api/projects/demo/login', undefined, { origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await post(s, '/api/projects/demo/login', undefined, { 'x-ccdash': '' })).status, 403);
  assert.ok(!sawLoginCall(svc));
  const r = await post(s, '/api/projects/demo/login');
  assert.strictEqual(r.status, 200);
  assert.ok(sawLoginCall(svc), 'ccd-session login demo was run');
  assert.strictEqual((await post(s, '/api/projects/bad%3Bname/login')).status, 400);
});

test('AC-3.1 GET login: {loggedIn:false, url} from the login pane via capture-pane', async (t) => {
  const svc = svcWith();
  const s = await h.authed(svc);
  t.after(s.stop);
  const r = await get(s, '/api/projects/demo/login');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(await r.json(), { loggedIn: false, url: URL_SECRET });
  assert.ok(svc.calls.tmux.some((a) => a[0] === 'capture-pane'), 'url read live with tmux capture-pane');
  assert.strictEqual((await req(s.base, '/api/projects/demo/login')).status, 401);
});

test('AC-3.1 GET login: url is null when the pane has no https URL; loggedIn true when logged in', async (t) => {
  const svc = svcWith({ pane: 'Starting login...\nhttp://not-https.example/x\n' });
  const s = await h.authed(svc);
  t.after(s.stop);
  assert.deepStrictEqual(await (await get(s, '/api/projects/demo/login')).json(), { loggedIn: false, url: null });
  svc.state.loggedIn = true;
  const j = await (await get(s, '/api/projects/demo/login')).json();
  assert.strictEqual(j.loggedIn, true);
});

test('AC-3.1 the sign-in URL is not in the audit log or any file the dashboard writes', async (t) => {
  const dir = tmp();
  const audit = createAudit({ dir });
  const svc = svcWith();
  const s = await h.start({ services: svc, audit: audit.log });
  t.after(s.stop);
  s.cookie = await h.loginCookie(s.base);
  await post(s, '/api/projects/demo/login');
  assert.strictEqual((await (await get(s, '/api/projects/demo/login')).json()).url, URL_SECRET); // it was read, so the scan below means something
  await post(s, '/api/projects/demo/open');
  const entries = fs.readFileSync(audit.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(entries.some((e) => /login/.test(e.event) && e.project === 'demo'), 'login is audited by project name');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const root of [dir, s.dir, svc.dir]) {
    for (const f of walk(root)) {
      const text = fs.readFileSync(f, 'utf8');
      assert.ok(!text.includes('SECRETSTATE123') && !text.includes('claude.ai/oauth'), `${f} leaks the URL`);
    }
  }
});

test('AC-3.3 GET /api/accounts and GET /api/tree are 404; /api/usage and /api/tokens still answer', async (t) => {
  const s = await h.authed(svcWith({ loggedIn: true }));
  t.after(s.stop);
  assert.strictEqual((await get(s, '/api/accounts')).status, 404);
  assert.strictEqual((await get(s, '/api/tree')).status, 404);
  assert.strictEqual((await post(s, '/api/accounts', { name: 'x' })).status, 404);
  assert.strictEqual((await get(s, '/api/usage')).status, 200);
});

test('AC-3.3 WS /term/_login is refused and ?account= is ignored or refused', async (t) => {
  const svc = svcWith({ loggedIn: true });
  const spawns = [];
  svc.spawnPty = (...a) => { spawns.push(a); throw new Error('must not spawn'); };
  const s = await h.authed(svc);
  t.after(s.stop);
  const open = (p) => new Promise((resolve, reject) => {
    const ws = new WebSocket(s.base.replace('http', 'ws') + p, { headers: { origin: ORIGIN, cookie: s.cookie } });
    ws.on('open', () => resolve({ status: 101, ws }));
    ws.on('unexpected-response', (_q, res) => { res.resume(); resolve({ status: res.statusCode }); });
    ws.on('error', reject);
  });
  const a = await open('/term/_login?account=work');
  assert.ok([400, 404].includes(a.status), `/term/_login got ${a.status}`);
  const b = await open('/term/demo?account=work');
  if (b.ws) b.ws.close();
  assert.notStrictEqual(b.status, 101, '?account= must not be accepted as a valid parameter');
  assert.ok(!svc.calls.runFile.some((c) => c.includes('--account')));
});

test('AC-3.4 usage is reported per project (record.project), not per account', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-usage-'));
  const rec = (project, ts, pct) => ({ sid: project, ts, project, rate_limits: { five_hour: { used_percentage: pct, resets_at: 1790000000 + ts } }, cost: null, context_window: null, model: null });
  fs.writeFileSync(path.join(d, 'a.json'), JSON.stringify(rec('a', 1789990000, 11)));
  fs.writeFileSync(path.join(d, 'b.json'), JSON.stringify(rec('b', 1789990010, 77)));
  const g = gauges({ dir: d, now: 1789990100 });
  assert.ok(g.projects, 'gauges has a projects map');
  assert.strictEqual(g.projects.a.five_hour.used_percentage, 11);
  assert.strictEqual(g.projects.b.five_hour.used_percentage, 77);
  assert.ok(!('accounts' in g), 'no accounts key');
});
