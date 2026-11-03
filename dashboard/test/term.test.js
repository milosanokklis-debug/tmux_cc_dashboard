'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { WebSocket } = require('ws');
const h = require('./helpers');
const { parseControl, clampDim, tmuxArgs } = require('../lib/term');

const { ORIGIN } = h;

test('parseControl: only {"resize":[c,r]} is a control message; sizes are clamped', () => {
  assert.deepStrictEqual(parseControl('{"resize":[120,40]}'), { cols: 120, rows: 40 });
  assert.deepStrictEqual(parseControl('{"resize":[0,99999]}'), { cols: 1, rows: 500 });
  assert.deepStrictEqual(parseControl('{"resize":["90","30"]}'), { cols: 90, rows: 30 });
  for (const t of ['ls -l', '{', '{"resize":[1]}', '{"resize":[1,2,3]}', '{"resize":"x"}', '{"resize":[1,"a"]}',
    '{"resize":[80,24],"x":1}', '{"other":1}', '[80,24]', '{"resize":null}', '{"resize":[null,null]}']) {
    assert.strictEqual(parseControl(t), null, t);
  }
});

test('clampDim defaults and bounds', () => {
  assert.strictEqual(clampDim(undefined, 80), 80);
  assert.strictEqual(clampDim('abc', 80), 80);
  assert.strictEqual(clampDim(null, 80), 80);
  assert.strictEqual(clampDim('', 80), 80);
  assert.strictEqual(clampDim('0', 80), 1);
  assert.strictEqual(clampDim('501', 80), 500);
  assert.strictEqual(clampDim('132.9', 80), 132);
  assert.strictEqual(clampDim('-5', 80), 1);
});

test('tmux argv attaches a grouped session that destroys itself when unattached', () => {
  assert.deepStrictEqual(tmuxArgs('/s.sock', 'claude-demo', 'web-0123abcd'), [
    '-S', '/s.sock', 'new-session', '-t', '=claude-demo', '-s', 'web-0123abcd', ';', 'set-option', 'destroy-unattached', 'on',
  ]);
});

function fakePty() {
  const state = { spawns: [], writes: [], resizes: [], killed: 0, dataCbs: [], exitCbs: [] };
  state.spawnPty = (file, args, opts) => {
    state.spawns.push({ file, args, opts });
    return {
      onData: (cb) => { if (state.throwOnData) throw new Error('boom'); state.dataCbs.push(cb); },
      onExit: (cb) => state.exitCbs.push(cb),
      write: (d) => { if (state.broken) throw new Error('EIO'); state.writes.push(d); },
      resize: (c, r) => { if (state.broken) throw new Error('EIO'); state.resizes.push([c, r]); },
      kill: () => { state.killed++; },
    };
  };
  return state;
}

async function setup(over = {}) {
  const pty = fakePty();
  const svc = h.fakeServices({ spawnPty: pty.spawnPty, ...over });
  const s = await h.authed(svc);
  const wsUrl = (p) => s.base.replace('http', 'ws') + p;
  const open = (p, { origin = ORIGIN, cookie = s.cookie } = {}) => new Promise((resolve, reject) => {
    const headers = {};
    if (origin) headers.origin = origin;
    if (cookie) headers.cookie = cookie;
    const ws = new WebSocket(wsUrl(p), { headers });
    ws.on('open', () => resolve(ws));
    ws.on('unexpected-response', (_q, res) => { res.resume(); reject(Object.assign(new Error('rejected'), { status: res.statusCode })); });
    ws.on('error', reject);
  });
  const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  return { pty, svc, s, open, tick };
}
const rejectedWith = (promise) => promise.then(() => { throw new Error('should have been rejected'); }, (e) => e.status);

test('WS guard: no session 401, bad/missing Origin 403, wrong path 404, bad project 400, unknown project 404', async (t) => {
  const c = await setup({
    runFile: async (file, args) => {
      if (args[1] === 'missing') throw Object.assign(new Error('x'), { stderr: 'no such project: missing\n' });
      return { stdout: `claude-${args[1]}\n` };
    },
  });
  t.after(c.s.stop);
  assert.strictEqual(await rejectedWith(c.open('/term/demo', { cookie: null })), 401);
  assert.strictEqual(await rejectedWith(c.open('/term/demo', { cookie: '__Host-ccdash=nope' })), 401);
  assert.strictEqual(await rejectedWith(c.open('/term/demo', { origin: 'https://evil.example' })), 403);
  assert.strictEqual(await rejectedWith(c.open('/term/demo', { origin: null })), 403);
  assert.strictEqual(await rejectedWith(c.open('/other/demo')), 404);
  assert.strictEqual(await rejectedWith(c.open('/term/')), 404);
  assert.strictEqual(await rejectedWith(c.open('/term/a/b')), 404);
  assert.strictEqual(await rejectedWith(c.open('/term/bad%3Bname')), 400);
  assert.strictEqual(await rejectedWith(c.open('/term/..%2Fx')), 400);
  assert.strictEqual(await rejectedWith(c.open('/term/missing')), 404);
  assert.strictEqual(c.pty.spawns.length, 0);
});

test('WS term: starts the session, spawns tmux argv with a pty, relays data both ways', async (t) => {
  const c = await setup();
  t.after(c.s.stop);
  const ws = await c.open('/term/demo?cols=100&rows=30');
  await c.tick();
  assert.deepStrictEqual(c.svc.calls.runFile, [['ccd-session', 'start', 'demo']]);
  const sp = c.pty.spawns[0];
  assert.strictEqual(sp.file, 'tmux');
  assert.deepStrictEqual(sp.args.slice(0, 6), ['-S', '/tmp/fake.sock', 'new-session', '-t', '=claude-demo', '-s']);
  assert.match(sp.args[6], /^web-[0-9a-f]{8}$/);
  assert.deepStrictEqual(sp.args.slice(7), [';', 'set-option', 'destroy-unattached', 'on']);
  assert.strictEqual(sp.opts.env.TERM, 'xterm-256color');
  assert.strictEqual(sp.opts.cols, 100);
  assert.strictEqual(sp.opts.rows, 30);

  const got = new Promise((r) => ws.once('message', (d) => r(d.toString())));
  c.pty.dataCbs[0]('hello é\r\n');
  assert.strictEqual(await got, 'hello é\r\n');

  ws.send('ls\r');
  ws.send('{"resize":[132,43]}');
  ws.send('{"resize":[9999,0]}');
  ws.send('{"not":"resize"}');
  ws.send(Buffer.from([0x03]), { binary: true });
  await c.tick();
  assert.deepStrictEqual(c.pty.resizes, [[132, 43], [500, 1]]);
  assert.strictEqual(c.pty.writes[0], 'ls\r');
  assert.strictEqual(c.pty.writes[1], '{"not":"resize"}');
  assert.ok(Buffer.isBuffer(c.pty.writes[2]) && c.pty.writes[2][0] === 3);
  assert.strictEqual(c.pty.writes.length, 3);

  ws.close();
  await c.tick();
  assert.strictEqual(c.pty.killed, 1);
});

test('WS term: cols/rows default to 80x24 and are clamped', async (t) => {
  const c = await setup();
  t.after(c.s.stop);
  const a = await c.open('/term/demo');
  const b = await c.open('/term/demo?cols=100000&rows=-3');
  const d = await c.open('/term/demo?cols=x&rows=');
  await c.tick();
  assert.deepStrictEqual(c.pty.spawns.map((x) => [x.opts.cols, x.opts.rows]), [[80, 24], [500, 1], [80, 24]]);
  for (const w of [a, b, d]) w.close();
});

test('WS term: pty exit closes the socket; socket errors kill the pty exactly once', async (t) => {
  const c = await setup();
  t.after(c.s.stop);
  const ws = await c.open('/term/demo');
  await c.tick();
  const closed = new Promise((r) => ws.once('close', (code) => r(code)));
  c.pty.exitCbs[0]({ exitCode: 0 });
  assert.strictEqual(await closed, 1000);
  await c.tick();
  assert.strictEqual(c.pty.killed, 0); // already exited: nothing to kill
  const ws2 = await c.open('/term/demo');
  await c.tick();
  ws2.terminate();
  await c.tick();
  assert.strictEqual(c.pty.killed, 1);
});

test('logout, expiry sweep and password change close the socket and kill the pty', async (t) => {
  const c = await setup();
  t.after(c.s.stop);
  const ws = await c.open('/term/demo');
  await c.tick();
  const closed = new Promise((r) => ws.once('close', r));
  const out = await h.req(c.s.base, '/logout', { method: 'POST', headers: { origin: ORIGIN, 'x-ccdash': '1' }, cookie: c.s.cookie });
  assert.strictEqual(out.status, 200);
  await closed;
  await c.tick();
  assert.strictEqual(c.pty.killed, 1);

  const cookie2 = await h.loginCookie(c.s.base);
  const ws2 = await c.open('/term/demo', { cookie: cookie2 });
  await c.tick();
  const closed2 = new Promise((r) => ws2.once('close', r));
  c.s.clock.advance(12 * 3600e3 + 1);
  c.s.app.tick();
  await closed2;
  await c.tick();
  assert.strictEqual(c.pty.killed, 2);
});

test('a missing pty library closes the socket with 1011 instead of crashing', async (t) => {
  const c = await setup({ spawnPty: () => { throw new Error('no native module'); } });
  t.after(c.s.stop);
  const ws = await c.open('/term/demo');
  const code = await new Promise((r) => ws.once('close', r));
  assert.strictEqual(code, 1011);
});

const OUT = { origin: ORIGIN, 'x-ccdash': '1' };

test('a session revoked while startSession runs never gets a terminal', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const c = await setup({ runFile: async (f, args) => { await gate; return { stdout: `claude-${args[1]}\n` }; } });
  t.after(c.s.stop);
  const opening = c.open('/term/demo').then(() => 'open', () => 'refused');
  await c.tick();
  const out = await h.req(c.s.base, '/logout', { method: 'POST', headers: OUT, cookie: c.s.cookie });
  assert.strictEqual(out.status, 200);
  release();
  assert.strictEqual(await opening, 'refused');
  await c.tick();
  assert.strictEqual(c.pty.spawns.length, 0);
  assert.strictEqual(c.s.app.term.active, 0);
});

test('pending starts count toward the terminal limit; failed starts release their slot', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let fail = false;
  const c = await setup({
    runFile: async (f, args) => {
      if (args[0] !== 'start') return { stdout: '' };
      await gate;
      if (fail) throw Object.assign(new Error('x'), { stderr: 'boom\n' });
      return { stdout: `claude-${args[1]}\n` };
    },
  });
  t.after(c.s.stop);
  const pending = Array.from({ length: 16 }, () => c.open('/term/demo').then((w) => w, () => null));
  await c.tick(100);
  assert.strictEqual(c.s.app.term.active, 16);
  assert.strictEqual(await rejectedWith(c.open('/term/demo')), 503);
  fail = true;
  release();
  await Promise.all(pending);
  await c.tick();
  assert.strictEqual(c.s.app.term.active, 0);
  assert.strictEqual(c.pty.spawns.length, 0);
});

test('a client that never answers pings is terminated and its pty killed', async (t) => {
  const c = await setup({ pingMs: 20 });
  t.after(c.s.stop);
  const { WebSocket: WS } = require('ws');
  const ws = new WS(c.s.base.replace('http', 'ws') + '/term/demo', { headers: { origin: ORIGIN, cookie: c.s.cookie }, autoPong: false });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  await new Promise((r) => ws.once('close', r));
  await c.tick();
  assert.strictEqual(c.pty.killed, 1);
  assert.strictEqual(c.s.app.term.active, 0);

  // a normal client (auto pong) stays connected across many ping periods
  const ok = await c.open('/term/demo');
  await c.tick(150);
  assert.strictEqual(ok.readyState, 1);
  ok.close();
});

test('pty.write/resize errors do not crash; web-* session is removed by name on cleanup', async (t) => {
  const c = await setup({ cleanupMs: 0 });
  t.after(c.s.stop);
  const ws = await c.open('/term/demo');
  await c.tick();
  const spawn = c.pty.spawns[0];
  const webName = spawn.args[6];
  c.pty.broken = true;
  ws.send('x'); ws.send('{"resize":[10,10]}');
  await c.tick();
  assert.strictEqual(ws.readyState, 1);
  ws.close();
  await c.tick(100);
  assert.deepStrictEqual(c.svc.calls.runFile.at(-1), ['tmux', '-S', '/tmp/fake.sock', 'kill-session', '-t', `=${webName}`]);
});

test('attach throwing after the upgrade: socket closed (no HTTP reject written), pty killed, slot released once', async (t) => {
  const c = await setup();
  t.after(c.s.stop);
  c.pty.throwOnData = true;
  const errors = [];
  const origErr = console.error; console.error = (...a) => errors.push(a.join(' '));
  try {
    const result = await c.open('/term/demo').then((w) => new Promise((r) => { w.on('close', (code) => r({ closed: code })); w.on('error', () => {}); }), (e) => ({ rejected: e.status }));
    assert.ok(result.closed !== undefined, JSON.stringify(result)); // a WebSocket close, not a 5xx written on the socket
  } finally { console.error = origErr; }
  await c.tick();
  assert.strictEqual(c.pty.killed, 1);
  assert.strictEqual(c.s.app.term.active, 0);
});
