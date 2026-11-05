'use strict';
// Phase C permission broker: real tmux, ccd-session, state.sh, permission.sh and the fake claude, the broker
// on a unix socket in the temp dir, decisions through the real authenticated HTTP API. The forging tests
// speak to the socket the way user ccd could.
const test = require('node:test');
const assert = require('node:assert');
const { execFile, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { ROOT, haveTmux, sleep, stack } = require('./stack');
const { start, req, loginCookie, POST_HEADERS } = require('./helpers');
const { createBroker } = require('../lib/broker');
const { readRecord } = require('../lib/state');

const skip = !haveTmux && 'needs tmux and jq';
const HOOK = path.join(ROOT, 'rootfs/usr/local/lib/ccdash/hooks/permission.sh');
const haveCurl = spawnSync('curl', ['--version']).status === 0;
const skipHook = (!haveTmux || !haveCurl) && 'needs tmux, jq and curl';

const sockPath = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-sock-')), 'broker.sock');

// A full dashboard app over a stack, with the broker socket and wait given.
async function appOn(s, sock, waitSec) {
  const server = await start({
    services: {
      workspace: s.ws, agentsDir: path.join(s.env.HOME, '.ccdash/agents'), transcriptRoot: path.join(s.tmp, 'tr'), tmux: s.tmux,
      reconciler: s.rec, procTable: () => new Map(), runFile: async () => ({ stdout: '', stderr: '' }),
      runOp: async () => ({ rc: 0, log: '' }), now: () => Date.now(),
    },
    broker: { sock, waitSec },
  });
  assert.strictEqual(await server.app.broker.ready(), true);
  const cookie = await loginCookie(server.base);
  const api = async (p, json, method = json === undefined ? 'GET' : 'POST') => {
    const res = await req(server.base, p, { method, headers: POST_HEADERS, cookie, json });
    const raw = await res.text();
    return { status: res.status, raw, body: raw ? JSON.parse(raw) : null };
  };
  const conv = async (sid) => {
    const { body } = await api('/api/tree');
    return body.projects.flatMap((p) => p.conversations).find((c) => c.sid === sid);
  };
  return { server, api, conv, broker: server.app.broker };
}

async function begin(s, name) {
  s.project(name);
  s.ccd('start', name);
  return (await s.status(name, 'waiting')).sid;
}
const screen = (s, name) => s.t('capture-pane', '-p', '-S', '-', '-t', s.cur(name).pane);
const events = (s) => { try { return fs.readFileSync(path.join(s.env.FAKE_CLAUDE_HOME, 'events.log'), 'utf8'); } catch { return ''; } };

test('Phase C broker: two conversations, approve and deny reach only their own', { skip: skipHook }, async (t) => {
  const sock = sockPath();
  const s = stack({ CCDASH_BROKER_SOCK: sock, CCDASH_APPROVAL_WAIT: '60' });
  t.after(() => s.cleanup());
  const a = await appOn(s, sock, 60);
  t.after(() => a.server.stop());
  const sid1 = await begin(s, 'a1');
  const sid2 = await begin(s, 'a2');
  s.send('a1', '/perm');
  s.send('a2', '/perm');
  const pend = await s.until(() => (a.broker.pending().length === 2 ? a.broker.pending() : null), 'two pending requests');
  let t1; let t2;
  await s.until(() => { a.conv(sid1).then((c) => { t1 = c; }); a.conv(sid2).then((c) => { t2 = c; }); return t1?.approval && t2?.approval; }, 'approvals in the tree');
  assert.strictEqual(t1.status, 'needs_approval');
  assert.strictEqual(t1.approval.id, pend.find((p) => p.sid === sid1).id);
  assert.strictEqual(t2.approval.id, pend.find((p) => p.sid === sid2).id);
  assert.notStrictEqual(t1.approval.id, t2.approval.id);
  assert.match(t1.approval.id, /^[0-9a-f]{16}$/);
  assert.deepStrictEqual(Object.keys(t1.approval).sort(), ['id', 'input', 'since', 'tool', 'truncated']);
  assert.ok(t1.approval.tool);
  assert.ok(pend.every((p) => ['a1', 'a2'].includes(p.project)));

  // validation on the authenticated route
  assert.strictEqual((await a.api('/api/approvals/nothex/decision', { behavior: 'allow' })).status, 400);
  assert.strictEqual((await a.api(`/api/approvals/${t1.approval.id}/decision`, { behavior: 'yes' })).status, 400);
  assert.strictEqual((await a.api(`/api/approvals/${t1.approval.id}/decision`, { behavior: 'deny', message: 5 })).status, 400);
  assert.strictEqual((await a.api(`/api/approvals/${t1.approval.id}/decision`, { behavior: 'deny', message: 'x'.repeat(501) })).status, 400);
  assert.strictEqual((await a.api(`/api/approvals/${'0'.repeat(16)}/decision`, { behavior: 'allow' })).status, 404);
  assert.strictEqual((await a.api(`/api/approvals/${t1.approval.id}/decision`)).status, 405);
  const anon = await req(a.server.base, `/api/approvals/${t1.approval.id}/decision`, { method: 'POST', headers: POST_HEADERS, json: { behavior: 'allow' } });
  assert.strictEqual(anon.status, 401);
  assert.strictEqual(a.broker.pending().length, 2, 'bad requests decided nothing');

  assert.strictEqual((await a.api(`/api/approvals/${t1.approval.id}/decision`, { behavior: 'allow', message: 'ignored' })).status, 200);
  await s.until(() => /permission: allow/.test(screen(s, 'a1')), 'a1 to see allow');
  await s.status('a1', 'waiting');
  assert.ok(!/permission:/.test(screen(s, 'a2')), 'a2 has not been answered');
  assert.strictEqual((await a.api(`/api/approvals/${t1.approval.id}/decision`, { behavior: 'allow' })).status, 404); // gone
  assert.strictEqual(a.broker.pending().length, 1);

  const msg = 'Not now; use the other\u0007branch';
  assert.strictEqual((await a.api(`/api/approvals/${t2.approval.id}/decision`, { behavior: 'deny', message: msg })).status, 200);
  await s.until(() => /permission: deny/.test(screen(s, 'a2')), 'a2 to see deny');
  assert.match(events(s), /^permission-message: Not now; use the other branch$/m);
  assert.ok(!/permission-message/.test(screen(s, 'a1')));
  await s.status('a2', 'waiting');
  assert.strictEqual(a.broker.pending().length, 0);
  assert.strictEqual((await a.conv(sid1)).approval, undefined);
  assert.strictEqual((await a.conv(sid2)).approval, undefined);

  // e: the user answers in the terminal while the hook waits (the hook is killed, its connection closes)
  s.send('a1', '/perm');
  await s.until(() => a.broker.pending().length === 1, 'a pending request');
  const pids = spawnSync('pgrep', ['-f', `unix-socket ${sock}`], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  assert.ok(pids.length >= 1, 'found the hook curl');
  for (const pid of pids) process.kill(Number(pid), 'SIGTERM');
  await s.until(() => a.broker.pending().length === 0, 'the pending request to be dropped');
  await s.until(() => /fall-through: asking user/.test(screen(s, 'a1')), 'the terminal dialog');
  assert.strictEqual((await a.conv(sid1)).approval, undefined);
  s.send('a1', 'y');
  await s.status('a1', 'waiting');
});

test('Phase C broker: unanswered request falls through after CCDASH_APPROVAL_WAIT', { skip: skipHook }, async (t) => {
  const sock = sockPath();
  const s = stack({ CCDASH_BROKER_SOCK: sock, CCDASH_APPROVAL_WAIT: '5' });
  t.after(() => s.cleanup());
  const a = await appOn(s, sock, 5);
  t.after(() => a.server.stop());
  const sid = await begin(s, 'b1');
  const t0 = Date.now();
  s.send('b1', '/perm');
  await s.until(() => a.broker.pending().length === 1, 'the pending request');
  await s.until(() => /fall-through: asking user/.test(screen(s, 'b1')), 'fall-through', 9000);
  assert.ok(Date.now() - t0 >= 4000, 'not before the wait');
  assert.strictEqual(a.broker.pending().length, 0);
  s.send('b1', 'y');
  await s.until(() => /permission: allow \(user\)/.test(screen(s, 'b1')), 'the terminal answer');
  assert.strictEqual((await s.status('b1', 'waiting')).sid, sid);
});

test('Phase C broker: killing the dashboard mid-wait falls through quickly', { skip: skipHook }, async (t) => {
  const sock = sockPath();
  const s = stack({ CCDASH_BROKER_SOCK: sock, CCDASH_APPROVAL_WAIT: '60' });
  t.after(() => s.cleanup());
  const a = await appOn(s, sock, 60);
  await begin(s, 'k1');
  s.send('k1', '/perm');
  await s.until(() => a.broker.pending().length === 1, 'the pending request');
  const t0 = Date.now();
  await a.server.stop();
  await s.until(() => /fall-through: asking user/.test(screen(s, 'k1')), 'fall-through', 2000);
  assert.ok(Date.now() - t0 < 2500);
  assert.ok(!fs.existsSync(sock), 'socket removed');
  s.send('k1', 'y');
  await s.status('k1', 'waiting');
});

test('Phase C broker: a conversation that leaves needs_approval cancels the request', { skip }, async (t) => {
  const s = stack();
  t.after(() => s.cleanup());
  const sock = path.join(s.tmp, 'broker.sock');
  const a = await appOn(s, sock, 60);
  t.after(() => a.server.stop());
  const sid = await begin(s, 'l1');
  const rec = s.records().find((r) => r.sid === sid);
  const post = (extra = {}) => sockReq(sock, { body: JSON.stringify({ session_id: sid, tool_name: 'Bash', tool_input: { command: 'ls' }, pane: rec.pane, ...extra }) });
  // a hand-made state file stands in for the hook's state.sh call
  const file = path.join(s.stateDir, `${sid}.json`);
  const setState = (state) => fs.writeFileSync(file, JSON.stringify({ ...rec, state, event: 'PermissionRequest', ts: Math.floor(Date.now() / 1000) }));
  setState('needs_approval');
  const p = post();
  await s.until(() => a.broker.pending().length === 1, 'pending');
  setState('waiting');
  const r = await p;
  assert.strictEqual(r.status, 204);
  assert.strictEqual(a.broker.pending().length, 0);
});

// ---- raw socket client, the way ccd would talk to it ----
function sockReq(sock, { method = 'POST', url = '/permission', body, headers = { 'content-type': 'application/json' } } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ socketPath: sock, method, path: url, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', (e) => (e.code === 'EPIPE' || e.code === 'ECONNRESET' ? resolve({ status: 'reset', text: '' }) : reject(e)));
    if (body !== undefined) r.write(body);
    r.end();
  });
}

const listeningTcp = () => {
  const inodes = new Set(fs.readdirSync('/proc/self/fd').map((f) => { try { return /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/self/fd/${f}`))?.[1]; } catch { return null; } }).filter(Boolean));
  const out = [];
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      for (const line of fs.readFileSync(f, 'utf8').split('\n').slice(1)) {
        const c = line.trim().split(/\s+/);
        if (c[3] === '0A' && inodes.has(c[9])) out.push(c[1]);
      }
    } catch { /* no ipv6 */ }
  }
  return out;
};

test('Phase C broker: forging from the ccd side never yields an allow', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-forge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir);
  const sock = path.join(dir, 'broker.sock');
  const tcpBefore = listeningTcp();
  const broker = createBroker({ sock, waitSec: 2, readRecord: (sid) => readRecord(stateDir, sid), log: () => {} });
  assert.strictEqual(await broker.start(), true);
  t.after(() => broker.stop());
  assert.deepStrictEqual(listeningTcp(), tcpBefore, 'the broker opens no TCP port');
  assert.strictEqual(fs.statSync(sock).mode & 0o777, 0o660);
  assert.ok(fs.statSync(sock).isSocket());

  const write = (sid, o) => fs.writeFileSync(path.join(stateDir, `${sid}.json`), JSON.stringify({
    sid, state: 'needs_approval', event: 'PermissionRequest', ts: 1, project: '/workspace/proj', pane: '%7', ...o,
  }));
  write('good', {}); write('other', { pane: '%8' }); write('done', { state: 'ended' }); write('idle', { state: 'waiting' });
  const body = (o = {}) => JSON.stringify({ session_id: 'good', tool_name: 'Bash', tool_input: { command: 'rm -rf x' }, pane: '%7', ...o });

  // not 2xx: wrong pane, no state file, ended, not waiting for approval, bad fields
  const bad = (what, o) => sockReq(sock, { body: body(o) }).then((r) => { assert.ok(r.status >= 400 && r.status < 500, `${what}: ${r.status}`); assert.ok(!r.text.includes('allow'), what); });
  await bad('wrong pane', { pane: '%9' });
  await bad('state file for another pane', { session_id: 'other' });
  await bad('no state file', { session_id: 'nope' });
  await bad('ended', { session_id: 'done' });
  await bad('waiting', { session_id: 'idle' });
  await bad('bad sid', { session_id: '../good' });
  await bad('bad pane', { pane: '7' });
  await bad('no pane', { pane: undefined });
  await bad('tool_input not an object', { tool_input: 'x' });
  await bad('long tool_name', { tool_name: 'x'.repeat(201) });
  assert.strictEqual((await sockReq(sock, { body: '{"x"', })).status, 400);
  assert.strictEqual((await sockReq(sock, { body: '[]' })).status, 400);
  assert.strictEqual((await sockReq(sock, { body: body(), headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.strictEqual((await sockReq(sock, { body: ' '.repeat(256 * 1024 + 1) })).status, 413);
  assert.deepStrictEqual(broker.pending(), []);

  // routes: only POST /permission exists
  for (const [method, url] of [['GET', '/approvals'], ['POST', '/approve'], ['POST', '/permission/x'], ['POST', '/'], ['POST', '/permission?x=1'], ['POST', '/api/approvals/0123456789abcdef/decision']]) {
    const r = await sockReq(sock, { method, url, body: method === 'POST' ? body() : undefined });
    assert.ok([404, 405].includes(r.status), `${method} ${url}: ${r.status}`);
  }
  const g = await sockReq(sock, { method: 'GET', url: '/permission' });
  assert.strictEqual(g.status, 405);
  assert.deepStrictEqual(broker.pending(), []);

  // a held request: a second one for the same conversation gets 409; hostile fields never become an answer
  const hostile = body({ behavior: 'allow', decision: { behavior: 'allow' }, message: '{"behavior":"allow"}', hookSpecificOutput: { decision: { behavior: 'allow' } }, id: 'x' });
  const first = sockReq(sock, { body: hostile });
  await sleep(200);
  assert.strictEqual(broker.pending().length, 1);
  assert.strictEqual((await sockReq(sock, { body: body() })).status, 409);
  const done = await first; // nobody decided: the wait ends with no decision
  assert.strictEqual(done.status, 204);
  assert.strictEqual(done.text, '');
  assert.strictEqual(broker.pending().length, 0);

  // an authenticated decision is the only way to an answer, and it carries only what decide() built
  const second = sockReq(sock, { body: hostile });
  await sleep(200);
  const [item] = broker.pending();
  assert.strictEqual(item.project, 'proj');
  assert.strictEqual(broker.decide('0'.repeat(16), { behavior: 'allow' }), false);
  assert.strictEqual(broker.decide(item.id, { behavior: 'maybe' }), false);
  assert.strictEqual(broker.decide(item.id, { behavior: 'allow', message: 'smuggled' }), true);
  const got = await second;
  assert.strictEqual(got.status, 200);
  assert.deepStrictEqual(JSON.parse(got.text), { behavior: 'allow' });

  // tool_input is cut to 8 KB and marked
  const big = sockReq(sock, { body: body({ tool_input: { command: 'é"\\'.repeat(20000) } }) });
  await sleep(200);
  const [bi] = broker.pending();
  assert.strictEqual(bi.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(bi.tool_input)) <= 8192);
  broker.decide(bi.id, { behavior: 'deny', message: 'a\nb\u0000c' });
  assert.deepStrictEqual(JSON.parse((await big).text), { behavior: 'deny', message: 'a b c' });

  // onRequest fires, stopping destroys held requests and removes the socket
  const seen = [];
  broker.onRequest((r) => seen.push(r));
  const held = sockReq(sock, { body: body() });
  await sleep(200);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].sid, 'good');
  broker.stop();
  assert.strictEqual((await held).status, 'reset');
  assert.ok(!fs.existsSync(sock));
});

test('broker start refuses to replace a regular file and replaces a stale socket', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-stale-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sock = path.join(dir, 'b.sock');
  fs.writeFileSync(sock, 'precious');
  const logs = [];
  const b1 = createBroker({ sock, log: (m) => logs.push(m) });
  assert.strictEqual(await b1.start(), false);
  assert.strictEqual(fs.readFileSync(sock, 'utf8'), 'precious');
  fs.rmSync(sock);
  const stale = http.createServer().listen(sock);
  await new Promise((r) => stale.on('listening', r));
  stale.close(); // close() unlinks; recreate a leftover socket file the way a crash would
  const left = http.createServer().listen(sock);
  await new Promise((r) => left.on('listening', r));
  left.unref(); left.closeAllConnections();
  const b2 = createBroker({ sock, log: () => {} });
  assert.strictEqual(await b2.start(), true);
  t.after(() => { b2.stop(); left.close(); });
  assert.strictEqual(fs.statSync(sock).mode & 0o777, 0o660);
});

// ---- permission.sh output mapping against a stub server ----
function stub(sock, handler) {
  const seen = [];
  const srv = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', (c) => chunks.push(c));
    rq.on('end', () => { seen.push({ method: rq.method, url: rq.url, body: Buffer.concat(chunks).toString('utf8') }); handler(rs); });
  });
  return new Promise((r) => srv.listen(sock, () => r({ srv, seen })));
}
const run = (env, input) => new Promise((resolve) => {
  const c = execFile('bash', [HOOK], { env, encoding: 'utf8', timeout: 20000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  c.stdin.end(input);
});

test('permission.sh maps broker answers to hook output and otherwise stays silent', { skip: skipHook }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-hook-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sock = path.join(dir, 's.sock');
  let reply = (rs) => rs.end();
  const { srv, seen } = await stub(sock, (rs) => reply(rs));
  t.after(() => srv.close());
  const env = { PATH: process.env.PATH, HOME: path.join(dir, 'home'), CCDASH_BROKER_SOCK: sock, TMUX_PANE: '%3', CCDASH_APPROVAL_WAIT: '5' };
  const input = JSON.stringify({ session_id: 'sess-1', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/w' });
  const json = (o, code = 200) => (rs) => { rs.writeHead(code, { 'content-type': 'application/json' }); rs.end(typeof o === 'string' ? o : JSON.stringify(o)); };
  const decision = (r) => JSON.parse(r.stdout).hookSpecificOutput;

  reply = json({ behavior: 'allow' });
  let r = await run(env, input);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(decision(r), { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } });
  const posted = JSON.parse(seen.at(-1).body);
  assert.strictEqual(seen.at(-1).url, '/permission');
  assert.strictEqual(posted.pane, '%3');
  assert.strictEqual(posted.session_id, 'sess-1');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'home/.ccdash/sessions/sess-1.json'), 'utf8')).state, 'needs_approval');

  reply = json({ behavior: 'deny', message: 'use make' });
  r = await run(env, input);
  assert.deepStrictEqual(decision(r).decision, { behavior: 'deny', message: 'use make' });
  reply = json({ behavior: 'allow', message: 'dropped for allow' });
  assert.deepStrictEqual(decision(await run(env, input)).decision, { behavior: 'allow' });

  for (const [what, rep] of [
    ['204', (rs) => { rs.writeHead(204); rs.end(); }],
    ['garbage', json('not json')],
    ['500 with an allow body', json({ behavior: 'allow' }, 500)],
    ['unknown behavior', json({ behavior: 'ask' })],
    ['extra keys', json({ behavior: 'allow', updatedInput: {} })],
    ['non-string message', json({ behavior: 'deny', message: { a: 1 } })],
    ['array', json([{ behavior: 'allow' }])],
    ['string', json('allow')],
  ]) {
    reply = rep;
    r = await run(env, input);
    assert.deepStrictEqual([what, r.code, r.stdout], [what, 0, ''], what);
  }

  r = await run({ ...env, CCDASH_BROKER_SOCK: path.join(dir, 'missing.sock') }, input);
  assert.deepStrictEqual([r.code, r.stdout], [0, '']);

  // jq absent: drains stdin, does nothing, silent
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const n of ['bash', 'cat', 'env', 'curl']) {
    const w = spawnSync('bash', ['-c', `command -v ${n}`], { encoding: 'utf8' }).stdout.trim();
    if (w) fs.symlinkSync(w, path.join(bin, n));
  }
  const before = seen.length;
  reply = json({ behavior: 'allow' });
  r = await run({ ...env, PATH: bin }, input.repeat(2000));
  assert.deepStrictEqual([r.code, r.stdout, r.stderr], [0, '', '']);
  assert.strictEqual(seen.length, before);

  // not JSON on stdin: nothing is posted
  r = await run(env, 'not json at all');
  assert.deepStrictEqual([r.code, r.stdout], [0, '']);
  assert.strictEqual(seen.length, before);
});
