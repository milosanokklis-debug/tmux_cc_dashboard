'use strict';
// The /events WebSocket: guard, push on change, silence when unchanged, preview watch + rate limit.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const h = require('./helpers');

const SID = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-2222-3333-4444-555555555555';

async function setup({ preview } = {}) {
  const watch = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-ev-'));
  fs.mkdirSync(path.join(watch, 'agents'));
  let status = 'working';
  let listeners = [];
  const snap = () => new Map([[SID, { sid: SID, status, hidden: false, idle: false, quiet: false, pane: '%1' }]]);
  const reconciler = {
    tick: async () => snap(), snapshot: snap, get: (s) => snap().get(s) ?? null,
    onTick: (fn) => { listeners.push(fn); },
  };
  const calls = [];
  const svc = h.fakeServices({
    reconciler, eventsDir: watch, agentsDir: path.join(watch, 'agents'), usageDir: path.join(watch, 'usage'),
    eventsOpts: { debounceMs: 20, previewMs: 100, rewatchMs: 50 },
    tmux: { sock: '/x', listPanes: async () => [], run: async (a) => { calls.push(a); return preview ? preview() : 'hello'; }, ensureOps: async () => {} },
    tokens: { refresh: async () => {}, views: () => ({ total: { input: 1 } }), forNode: () => null, modelOf: () => null },
  });
  const s = await h.authed(svc);
  const open = (p = '/events', { origin = h.ORIGIN, cookie = s.cookie } = {}) => new Promise((resolve, reject) => {
    const headers = {};
    if (origin) headers.origin = origin;
    if (cookie) headers.cookie = cookie;
    const ws = new WebSocket(s.base.replace('http', 'ws') + p, { headers });
    ws.msgs = [];
    ws.on('message', (d) => ws.msgs.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve(ws));
    ws.on('unexpected-response', (_q, res) => { res.resume(); reject(Object.assign(new Error('rejected'), { status: res.statusCode })); });
    ws.on('error', reject);
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stop = async () => { await s.stop(); fs.rmSync(watch, { recursive: true, force: true }); };
  return { s, open, sleep, watch, stop, calls, fireTick: () => listeners.forEach((f) => f()), setStatus: (v) => { status = v; } };
}
const status = (p) => p.then(() => { throw new Error('should have been rejected'); }, (e) => e.status);
const of = (ws, type) => ws.msgs.filter((m) => m.type === type);

test('guard: no session 401, bad or missing Origin 403', async (t) => {
  const c = await setup();
  t.after(c.stop);
  assert.strictEqual(await status(c.open('/events', { cookie: null })), 401);
  assert.strictEqual(await status(c.open('/events', { cookie: '__Host-ccdash=nope' })), 401);
  assert.strictEqual(await status(c.open('/events', { origin: 'https://evil.example' })), 403);
  assert.strictEqual(await status(c.open('/events', { origin: null })), 403);
  assert.strictEqual(c.s.app.events.clients, 0);
});

test('a client gets tree, state, usage and tokens at once, then tree again on a file change', async (t) => {
  const c = await setup();
  t.after(c.stop);
  const ws = await c.open();
  t.after(() => ws.terminate());
  await c.sleep(300);
  for (const type of ['tree', 'state', 'usage', 'tokens']) assert.strictEqual(of(ws, type).length, 1, type);
  assert.strictEqual(of(ws, 'state')[0].states[SID].status, 'working');
  assert.ok(Array.isArray(of(ws, 'tree')[0].tree.projects));
  // a new conversation file appears in the watched dir
  const before = of(ws, 'tree').length;
  const ev = JSON.stringify({ ev: 'session', ts: new Date().toISOString(), sid: SID, pane: '%1', win: 'claude-demo:0', project: '/workspace/demo' });
  fs.writeFileSync(path.join(c.watch, 'agents', `${SID}.jsonl`), ev + '\n');
  const t0 = Date.now();
  while (of(ws, 'tree').length === before && Date.now() - t0 < 2000) await c.sleep(25);
  assert.ok(of(ws, 'tree').length > before, 'tree pushed within 2 s');
});

test('a status change arrives as state; an unchanged tick sends nothing', async (t) => {
  const c = await setup();
  t.after(c.stop);
  const ws = await c.open();
  t.after(() => ws.terminate());
  await c.sleep(300);
  const n = ws.msgs.length;
  c.fireTick(); c.fireTick();
  await c.sleep(250);
  assert.strictEqual(ws.msgs.length, n, 'nothing new');
  c.setStatus('waiting');
  c.fireTick();
  await c.sleep(250);
  assert.strictEqual(of(ws, 'state').at(-1).states[SID].status, 'waiting');
});

test('previews: only watched ids, rate limited, only on change; unwatch stops them', async (t) => {
  let n = 0;
  const c = await setup({ preview: () => `frame ${n++}` });
  t.after(c.stop);
  const ws = await c.open();
  t.after(() => ws.terminate());
  await c.sleep(300);
  assert.strictEqual(of(ws, 'preview').length, 0, 'nothing before a watch');
  ws.send(JSON.stringify({ type: 'watch', ids: [OTHER, 'not-an-id'] }));
  await c.sleep(400);
  assert.strictEqual(of(ws, 'preview').length, 0, 'unknown ids send nothing');
  ws.send(JSON.stringify({ type: 'watch', ids: [SID] }));
  await c.sleep(1050);
  const got = of(ws, 'preview');
  assert.ok(got.length >= 1 && got.length <= 11, `rate limited (got ${got.length})`); // controls also caches a capture for 1 s
  assert.ok(got.every((m) => m.id === SID && typeof m.text === 'string'));
  ws.send(JSON.stringify({ type: 'unwatch', ids: [SID] }));
  await c.sleep(150);
  const after = of(ws, 'preview').length;
  await c.sleep(400);
  assert.strictEqual(of(ws, 'preview').length, after);
});

test('logout closes the events socket', async (t) => {
  const c = await setup();
  t.after(c.stop);
  const ws = await c.open();
  const closed = new Promise((r) => ws.on('close', r));
  const out = await h.req(c.s.base, '/logout', { method: 'POST', headers: { origin: h.ORIGIN, 'x-ccdash': '1' }, cookie: c.s.cookie });
  assert.strictEqual(out.status, 200);
  await closed;
});
