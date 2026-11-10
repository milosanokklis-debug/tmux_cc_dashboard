'use strict';
// The /events state message carries each conversation's project.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const h = require('./helpers');

const A = '11111111-2222-3333-4444-555555555555';
const B = '99999999-2222-3333-4444-555555555555';

test('state entries carry the project, including (unknown)', async (t) => {
  const watch = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-evp-'));
  fs.mkdirSync(path.join(watch, 'usage'));
  const snap = () => new Map([
    [A, { sid: A, status: 'working', hidden: false, idle: false, quiet: false, project: 'demo' }],
    [B, { sid: B, status: 'idle', hidden: false, idle: true, quiet: false, project: '(unknown)' }],
  ]);
  const reconciler = { tick: async () => snap(), snapshot: snap, get: (s) => snap().get(s) ?? null, onTick: () => {} };
  const svc = h.fakeServices({
    reconciler, eventsDir: watch, usageDir: path.join(watch, 'usage'),
    eventsOpts: { debounceMs: 20, previewMs: 100, rewatchMs: 50 },
    tmux: { sock: '/x', listPanes: async () => [], run: async () => 'x', ensureOps: async () => {} },
    tokens: { refresh: async () => {}, views: () => ({ total: { input: 1 } }), forNode: () => null, modelOf: () => null },
  });
  const s = await h.authed(svc);
  t.after(async () => { await s.stop(); fs.rmSync(watch, { recursive: true, force: true }); });
  const ws = await new Promise((resolve, reject) => {
    const w = new WebSocket(s.base.replace('http', 'ws') + '/events', { headers: { origin: h.ORIGIN, cookie: s.cookie } });
    w.msgs = [];
    w.on('message', (d) => w.msgs.push(JSON.parse(d.toString())));
    w.on('open', () => resolve(w));
    w.on('error', reject);
  });
  t.after(() => ws.terminate());
  const t0 = Date.now();
  while (!ws.msgs.some((m) => m.type === 'state') && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 25));
  const st = ws.msgs.find((m) => m.type === 'state');
  assert.strictEqual(st.states[A].project, 'demo');
  assert.strictEqual(st.states[B].project, '(unknown)');
});
