'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('./helpers');
const { createAudit } = require('../lib/audit');
const accounts = require('../lib/accounts');
const { gauges } = require('../lib/usage');
const { buildTree } = require('../lib/tree');
const reader = require('../../rootfs/usr/local/lib/ccdash/reader');

const { req, ORIGIN } = h;
const post = (s, p, json, extra = {}) => req(s.base, p, { method: 'POST', headers: { origin: ORIGIN, 'x-ccdash': '1', ...extra }, json, cookie: s.cookie });
const get = (s, p) => req(s.base, p, { cookie: s.cookie });
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-acct-')));

// runFile fake: ccd-account list / create, ccd-session start (rejects accounts not in `known`)
function svcWith(known = ['default', 'work']) {
  const svc = h.fakeServices();
  fs.mkdirSync(path.join(svc.workspace, 'demo'));
  svc.runFile = async (file, args) => {
    svc.calls.runFile.push([file, ...args]);
    if (file === 'ccd-account' && args[0] === 'list') {
      return { stdout: known.map((n) => `${n}\t${n === 'work' ? 'not logged in' : 'logged in'}\n`).join(''), stderr: '' };
    }
    if (file === 'ccd-account') return { stdout: `${args[1]}\n`, stderr: '' };
    const a = args[args.indexOf('--account') + 1];
    if (!known.includes(a)) throw Object.assign(new Error('x'), { stderr: `unknown account: ${a} (create it with: ccd login --account ${a})\n` });
    return { stdout: `claude-${args[1]}\n`, stderr: '' };
  };
  return svc;
}

test('account name rule: default or ^[a-z0-9][a-z0-9_-]{0,31}$', () => {
  for (const ok of ['default', 'work', 'a', '0x', 'a_b-c', 'a'.repeat(32)]) assert.ok(accounts.validAccount(ok), ok);
  for (const bad of ['', 'Work', '-a', '_a', 'a b', 'a/b', '../x', 'a.b', 'a'.repeat(33), 'a;b', 5, null, {}]) assert.ok(!accounts.validAccount(bad), String(bad));
  assert.strictEqual(accounts.parseAccount(undefined), 'default');
  assert.throws(() => accounts.parseAccount('Bad'), (e) => e.status === 400);
});

test('GET /api/accounts: default first, names and loggedIn only', async (t) => {
  const svc = svcWith();
  const s = await h.authed(svc);
  t.after(s.stop);
  const r = await get(s, '/api/accounts');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(await r.json(), { accounts: [{ name: 'default', loggedIn: true }, { name: 'work', loggedIn: false }] });
  assert.deepStrictEqual(svc.calls.runFile, [['ccd-account', 'list']]);
  assert.strictEqual((await req(s.base, '/api/accounts')).status, 401);
});

test('POST /api/accounts: creates, audits the name only, rejects bad names and missing Origin / X-CCDash', async (t) => {
  const dir = tmp();
  const audit = createAudit({ dir });
  const svc = svcWith();
  const s = await h.start({ services: svc, audit: audit.log });
  t.after(s.stop);
  const cookie = await h.loginCookie(s.base);
  const p = (json, extra) => req(s.base, '/api/accounts', { method: 'POST', headers: { origin: ORIGIN, 'x-ccdash': '1', ...extra }, json, cookie });
  const ok = await p({ name: 'personal', secret: 'sk-ant-SECRET' });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(await ok.json(), { name: 'personal', project: '_login', account: 'personal' });
  assert.deepStrictEqual(svc.calls.runFile, [['ccd-account', 'create', 'personal']]);
  for (const name of ['', 'Bad', '../x', 'default', 'a b', 5, undefined]) {
    assert.strictEqual((await p({ name })).status, 400, String(name));
  }
  assert.strictEqual(svc.calls.runFile.length, 1);
  assert.strictEqual((await p({ name: 'x' }, { origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await p({ name: 'x' }, { 'x-ccdash': '' })).status, 403);
  assert.strictEqual(svc.calls.runFile.length, 1);
  const log = fs.readFileSync(audit.file, 'utf8');
  const entry = log.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.event === 'account.create' && e.outcome === 'ok');
  assert.strictEqual(entry.account, 'personal');
  assert.ok(!/SECRET|secret/.test(log));
});

test('account is threaded to ccd-session after the project: add, open, terminal; bad name 400, unknown 404', async (t) => {
  const svc = svcWith();
  const s = await h.authed(svc);
  t.after(s.stop);
  const open = (json) => post(s, '/api/projects/demo/open', json);
  assert.strictEqual((await open({ account: 'work' })).status, 200);
  assert.deepStrictEqual(svc.calls.runFile.at(-1), ['ccd-session', 'start', 'demo', '--account', 'work']);
  assert.strictEqual((await post(s, '/api/projects/demo/open')).status, 200); // no body: default
  assert.deepStrictEqual(svc.calls.runFile.at(-1), ['ccd-session', 'start', 'demo', '--account', 'default']);
  const n = svc.calls.runFile.length;
  assert.strictEqual((await open({ account: 'Bad Name' })).status, 400);
  assert.strictEqual((await open({ account: '--account' })).status, 400);
  assert.strictEqual((await open({ account: 7 })).status, 400);
  assert.strictEqual(svc.calls.runFile.length, n);
  const unknown = await open({ account: 'nope' });
  assert.strictEqual(unknown.status, 404);
  assert.match((await unknown.json()).error, /unknown account/);
  // add project: the account is validated before anything is cloned
  assert.strictEqual((await post(s, '/api/projects', { repo: 'octo/hello', account: 'BAD' })).status, 400);
  assert.strictEqual(svc.calls.runOp.length, 0);
  const add = await post(s, '/api/projects', { repo: 'octo/hello', account: 'work', prompt: 'hi' });
  assert.strictEqual(add.status, 200);
  assert.deepStrictEqual(svc.calls.runFile.at(-1), ['ccd-session', 'start', 'hello', '--account', 'work', 'hi']);
});

test('terminal WebSocket takes ?account=, refuses a bad one, 404 for an unknown one', async (t) => {
  const WebSocket = require('ws');
  const svc = svcWith();
  const spawns = [];
  svc.spawnPty = (...a) => { spawns.push(a); return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }; };
  const s = await h.authed(svc);
  t.after(s.stop);
  const open = (p) => new Promise((resolve, reject) => {
    const ws = new WebSocket(s.base.replace('http', 'ws') + p, { headers: { origin: ORIGIN, cookie: s.cookie } });
    ws.on('open', () => resolve(ws));
    ws.on('unexpected-response', (_q, res) => { res.resume(); reject(Object.assign(new Error('rejected'), { status: res.statusCode })); });
    ws.on('error', reject);
  });
  const status = (p) => open(p).then((ws) => { ws.close(); return 101; }, (e) => e.status);
  assert.strictEqual(await status('/term/demo?account=work'), 101);
  assert.deepStrictEqual(svc.calls.runFile.at(-1), ['ccd-session', 'start', 'demo', '--account', 'work']);
  assert.strictEqual(await status('/term/demo'), 101);
  assert.deepStrictEqual(svc.calls.runFile.at(-1), ['ccd-session', 'start', 'demo', '--account', 'default']);
  const n = svc.calls.runFile.length;
  assert.strictEqual(await status('/term/demo?account=Bad%20Name'), 400);
  assert.strictEqual(await status('/term/demo?account=--account'), 400);
  assert.strictEqual(svc.calls.runFile.length, n);
  assert.strictEqual(await status('/term/demo?account=nope'), 404);
});

test('reader: default root plus account roots only; outside and symlinked accounts are refused', () => {
  const t = tmp();
  const def = path.join(t, 'claude', 'projects');
  const base = path.join(t, 'accts');
  const mk = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
  const a = mk(path.join(def, 'p', 'a.jsonl'), 'default');
  const w = mk(path.join(base, 'work', 'projects', 'p', 'w.jsonl'), 'work');
  const outside = mk(path.join(t, 'other', 'o.jsonl'), 'outside');
  const real = mk(path.join(t, 'elsewhere', 'projects', 'p', 'l.jsonl'), 'linked');
  fs.symlinkSync(path.join(t, 'elsewhere'), path.join(base, 'linked'));
  const own = mk(path.join(base, 'bad', 'notprojects', 'x.jsonl'), 'x');
  const prev = { r: process.env.CCDASH_READER_ROOT, a: process.env.CCDASH_ACCOUNTS_DIR };
  process.env.CCDASH_READER_ROOT = def; process.env.CCDASH_ACCOUNTS_DIR = base;
  try {
    const ok = (p) => reader.handle(reader.defaultRoots, { op: 'stat', path: p }).ok === true;
    assert.ok(ok(a)); assert.ok(ok(w));
    assert.ok(!ok(outside)); assert.ok(!ok(real)); assert.ok(!ok(own));
    assert.ok(!ok(path.join(base, 'work', 'settings.json')));
    // a symlink inside an account's projects that points at another dir is refused too
    fs.symlinkSync(path.join(t, 'other'), path.join(base, 'work', 'projects', 'esc'));
    assert.ok(!ok(path.join(base, 'work', 'projects', 'esc', 'o.jsonl')));
    // a new account is picked up without a restart
    const n = mk(path.join(base, 'new1', 'projects', 'p', 'n.jsonl'), 'n');
    assert.ok(ok(n));
  } finally {
    for (const [k, v] of [['CCDASH_READER_ROOT', prev.r], ['CCDASH_ACCOUNTS_DIR', prev.a]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('usage is keyed by account and never mixed; top-level stays the default account', () => {
  const d = tmp();
  const NOW = 1789990000;
  const w = (name, account, used, ts) => fs.writeFileSync(path.join(d, `${name}.json`), JSON.stringify({
    sid: name, ...(account ? { account } : {}), ts, rate_limits: { five_hour: { used_percentage: used, resets_at: NOW + 100 } },
  }));
  w('old', undefined, 10, NOW - 50); // no account field: default
  w('def', 'default', 20, NOW - 40);
  w('work', 'work', 90, NOW - 1); // newest overall, but another account
  w('bad', 'Not Valid', 99, NOW); // an invalid account name reads as default
  const g = gauges({ dir: d, now: NOW });
  assert.strictEqual(g.five_hour.used_percentage, 99); // `bad` falls back to default and is the freshest default reading
  assert.strictEqual(g.accounts.work.five_hour.used_percentage, 90);
  assert.strictEqual(g.accounts.default.five_hour.used_percentage, 99);
  assert.deepStrictEqual(Object.keys(g.accounts).sort(), ['default', 'work']);
  const d2 = tmp();
  fs.writeFileSync(path.join(d2, 'w.json'), JSON.stringify({ sid: 'w', account: 'work', ts: NOW, rate_limits: { five_hour: { used_percentage: 50, resets_at: NOW + 5 } } }));
  const only = gauges({ dir: d2, now: NOW });
  assert.deepStrictEqual(only.five_hour, { status: 'unknown' }, 'a work reading never shows as default');
  assert.strictEqual(only.accounts.work.five_hour.used_percentage, 50);
  const fb = gauges({ dir: d2, now: NOW, fallback: () => ({ ts: NOW, limits: { five_hour: { used_percentage: 7 } } }) });
  assert.strictEqual(fb.five_hour.used_percentage, 7);
  assert.deepStrictEqual(fb.accounts.work.source, 'statusline'); // fallback is default only
});

test('accountOfPath and the tree carry each conversation\'s account', () => {
  const base = '/home/ccd/.claude-accounts';
  assert.strictEqual(accounts.accountOfPath(`${base}/work/projects/p/s.jsonl`), 'work');
  assert.strictEqual(accounts.accountOfPath('/home/ccd/.claude/projects/p/s.jsonl'), 'default');
  assert.strictEqual(accounts.accountOfPath(`${base}/work/../x/s.jsonl`), 'default');
  assert.strictEqual(accounts.accountOfPath(`${base}/Bad/s.jsonl`), 'default');
  assert.strictEqual(accounts.accountOfPath(undefined), 'default');
  const t = tmp();
  const agents = path.join(t, 'agents'); fs.mkdirSync(agents);
  const sid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const ev = JSON.stringify({ ev: 'session', ts: '2026-01-10T11:00:00Z', sid, pane: '%3', win: 'claude-demo:0', project: '/workspace/demo' });
  fs.writeFileSync(path.join(agents, `${sid}.jsonl`), `${ev}\n`);
  const states = new Map([[sid, { status: 'working', transcript: `${base}/work/projects/demo/${sid}.jsonl` }]]);
  const now = Date.parse('2026-01-10T12:00:00Z');
  const conv = (st) => buildTree({ agentsDir: agents, transcriptRoot: [t], panes: [], table: new Map(), now, all: true, states: st })[0].conversations[0];
  assert.strictEqual(conv(states).account, 'work');
  assert.strictEqual(conv(new Map([[sid, { status: 'working', transcript: '/home/ccd/.claude/projects/demo/x.jsonl' }]])).account, 'default');
  assert.strictEqual(conv(null).account, 'default');
});

test('POST open accepts an empty JSON-typed body; bad JSON stays 400; _login is not a repo name', async () => {
  const { readJson } = require('../lib/http');
  const mk = (txt) => { const { Readable } = require('node:stream'); return Readable.from(txt === '' ? [] : [Buffer.from(txt)]); };
  assert.deepStrictEqual(await readJson(mk(''), 1024, true), {});
  await assert.rejects(readJson(mk('{x'), 1024, true), { status: 400 });
  assert.throws(() => require('../lib/projects').normalizeRepo('o/_login'), { status: 400 });
});
