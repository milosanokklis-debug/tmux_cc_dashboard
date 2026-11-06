'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('./helpers');
const { derive, parseRecord, readRecords, createReconciler } = require('../lib/state');
const { buildTree } = require('../lib/tree');

const NOW = 1_800_000_000_000;
const rec = (sid, over = {}) => ({
  sid, state: 'waiting', event: 'Stop', ts: NOW / 1000 - 10, project: '/workspace/demo', pane: '%3', tmuxPid: 77, tmuxStart: 1000,
  waitingSince: NOW / 1000 - 10, resumedFrom: null, ...over,
});
const recs = (...rs) => new Map(rs.map((r) => [r.sid, r]));
const PANES = [{ session: 'claude-demo', window: '0', paneId: '%3', panePid: 100 }];
const TABLE = new Map([[100, { ppid: 1, comm: 'bash' }], [101, { ppid: 100, comm: 'claude' }]]);
const ENV = { panes: PANES, table: TABLE, serverPid: 77, serverStart: 1000, now: NOW, idleMs: 7200_000, quietMs: 900_000 };
const one = (r, env = {}) => derive(recs(r), { ...ENV, ...env }).get(r.sid);

test('a live conversation keeps the status the hooks recorded', () => {
  for (const state of ['working', 'needs_approval', 'waiting', 'error']) {
    assert.strictEqual(one(rec('a', { state })).status, state);
  }
});

test('different tmux server pid, missing pane or a pane without claude -> sleeping', () => {
  assert.strictEqual(one(rec('a'), { serverPid: 78 }).status, 'sleeping');
  assert.strictEqual(one(rec('a', { pane: '%9' })).status, 'sleeping');
  assert.strictEqual(one(rec('a'), { table: new Map([[100, { ppid: 1, comm: 'bash' }]]) }).status, 'sleeping');
  assert.strictEqual(one(rec('a'), { panes: [] }).status, 'sleeping');
  assert.strictEqual(one(rec('a'), { serverPid: null, serverStart: null }).status, 'waiting', 'unknown server skips the server check');
  // same pid and pane id after a restart (containers): only the start time tells the servers apart
  assert.strictEqual(one(rec('a'), { serverStart: 2000 }).status, 'sleeping');
  assert.strictEqual(one(rec('a', { tmuxStart: null }), { serverStart: 2000 }).status, 'waiting', 'older record without a start time');
});

test('ended stays ended even when the pane is gone', () => {
  assert.strictEqual(one(rec('a', { state: 'ended', event: 'SessionEnd' }), { panes: [] }).status, 'ended');
});

test('no pane: "outside tmux", liveness skipped', () => {
  const d = one(rec('a', { pane: null, tmuxPid: null }), { panes: [] });
  assert.strictEqual(d.status, 'waiting');
  assert.strictEqual(d.outsideTmux, true);
  assert.strictEqual(one(rec('a')).outsideTmux, false);
});

test('idle flag: waiting longer than the threshold; quiet flag: working with no event', () => {
  const w = rec('a', { waitingSince: NOW / 1000 - 5 });
  assert.strictEqual(one(w, { idleMs: 5000 }).idle, true);
  assert.strictEqual(one(w, { idleMs: 6000 }).idle, false);
  const k = rec('b', { state: 'working', ts: NOW / 1000 - 5 });
  assert.strictEqual(one(k, { quietMs: 5000 }).quiet, true);
  assert.strictEqual(one(k, { quietMs: 6000 }).quiet, false);
  assert.strictEqual(one(rec('c', { state: 'needs_approval', ts: 1 })).quiet, false, 'only working goes quiet');
  assert.strictEqual(one(rec('d', { state: 'waiting', waitingSince: null })).idle, false);
});

test('a conversation another one resumed from is hidden; a self reference is ignored', () => {
  const d = derive(recs(rec('old', { state: 'working' }), rec('new', { resumedFrom: 'old' })), ENV);
  assert.strictEqual(d.get('old').hidden, true);
  assert.strictEqual(d.get('new').hidden, false);
  assert.strictEqual(parseRecord('x', JSON.stringify({ sid: 'x', state: 'waiting', ts: 1, resumed_from: 'x' })).resumedFrom, null);
});

test('parseRecord rejects bad data and cleans fields', () => {
  const ok = { sid: 'x', state: 'working', ts: 5, pane: '%1', tmux_pid: 9, project: '/workspace/a\nb' };
  assert.strictEqual(parseRecord('x', JSON.stringify(ok)).project, '/workspace/a b');
  for (const bad of [{ ...ok, sid: 'y' }, { ...ok, state: 'bogus' }, { ...ok, ts: 'now' }, null, 'str']) {
    assert.strictEqual(parseRecord('x', JSON.stringify(bad)), null);
  }
  assert.strictEqual(parseRecord('x', '{nope'), null);
  assert.strictEqual(parseRecord('x', JSON.stringify({ ...ok, pane: '%1;x', tmux_pid: -1 })).pane, null);
});

test('readRecords: only regular <sid>.json files whose name matches their sid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-st-'));
  const w = (n, o) => fs.writeFileSync(path.join(dir, n), JSON.stringify(o));
  w('a.json', { sid: 'a', state: 'waiting', ts: 1 });
  w('b.json', { sid: 'zzz', state: 'waiting', ts: 1 });
  w('.a.tmp123', { sid: 'a', state: 'waiting', ts: 1 });
  w('c.txt', {});
  fs.symlinkSync(path.join(dir, 'a.json'), path.join(dir, 'd.json'));
  assert.deepStrictEqual([...readRecords(dir).keys()], ['a']);
  assert.strictEqual(readRecords(path.join(dir, 'missing')).size, 0);
  fs.rmSync(dir, { recursive: true });
});

test('reconciler: reads the files, never writes them, keeps the last answer when tmux fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-st-'));
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ sid: 'a', state: 'waiting', ts: 1, pane: '%3', tmux_pid: 77, waiting_since: 1 }));
  const before = fs.statSync(path.join(dir, 'a.json')).mtimeMs;
  let fail = false;
  const logged = [];
  const r = createReconciler({
    stateDir: dir, procTable: () => TABLE, now: () => NOW, idleSec: 5, quietSec: 5, log: (...a) => logged.push(a.join(' ')),
    tmux: {
      listPanes: async () => { if (fail) throw new Error('tmux: access not allowed'); return PANES; },
      run: async () => '77 1000\n',
    },
  });
  assert.strictEqual(r.snapshot(), null);
  await r.tick();
  assert.deepStrictEqual([r.get('a').status, r.get('a').idle], ['waiting', true]);
  fail = true;
  await r.tick(); await r.tick();
  assert.strictEqual(r.get('a').status, 'waiting');
  assert.strictEqual(logged.length, 1, 'logged once per outage');
  fail = false;
  assert.deepStrictEqual(fs.readdirSync(dir), ['a.json']);
  assert.strictEqual(fs.statSync(path.join(dir, 'a.json')).mtimeMs, before);
  fs.rmSync(dir, { recursive: true });
});

test('tree takes the status from the reconciler, hides resumed conversations, flags wakeable ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-tr-'));
  const agents = path.join(dir, 'agents');
  fs.mkdirSync(agents);
  const ev = (sid, ev, extra = {}) => JSON.stringify({ ev, ts: '2026-01-10T11:00:00Z', sid, pane: '%3', win: 'claude-demo:0', project: '/workspace/demo', ...extra });
  for (const sid of ['old', 'new', 'live']) fs.writeFileSync(path.join(agents, `${sid}.jsonl`), ev(sid, 'session') + '\n');
  const states = derive(recs(rec('old', { state: 'working' }), rec('new', { resumedFrom: 'old' }), rec('live', { pane: '%9' })), ENV);
  const tr = buildTree({ agentsDir: agents, transcriptRoot: dir, panes: PANES, table: TABLE, now: Date.parse('2026-01-10T12:00:00Z'), states });
  const cs = tr.find((p) => p.project === 'demo').conversations;
  assert.deepStrictEqual(cs.map((c) => [c.sid, c.status, c.wakeable]).sort(), [['live', 'sleeping', true], ['new', 'waiting', false]]);
  fs.rmSync(dir, { recursive: true });
});

// ---- wake API -----------------------------------------------------------------------

const SID = '00000000-0000-4000-8000-000000000001';
const SID2 = '00000000-0000-4000-8000-000000000002';
const JSON_POST = { origin: h.ORIGIN, 'x-ccdash': '1' };

async function wakeStack(status, op = async () => ({ rc: 0, log: 'claude-demo\n' })) {
  const ctl = { op };
  const svc = h.fakeServices({ runOp: async (o) => { svc.calls.runOp.push(o.argv); return ctl.op(o); } });
  svc.ctl = ctl;
  const snap = new Map([[SID, { sid: SID, status, hidden: false }], [SID2, { sid: SID2, status: 'working', hidden: false }]]);
  svc.reconciler = { tick: async () => snap, get: (s) => snap.get(s) ?? null, snapshot: () => snap };
  const s = await h.authed(svc);
  const wake = (sid) => h.req(s.base, `/api/conversations/${sid}/wake`, { method: 'POST', headers: JSON_POST, json: {}, cookie: s.cookie });
  return { s, svc, wake };
}

test('POST wake: sleeping and ended conversations run ccd-session wake', async (t) => {
  for (const status of ['sleeping', 'ended']) {
    const { s, svc, wake } = await wakeStack(status);
    t.after(s.stop);
    const r = await wake(SID);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(await r.json(), { ok: true, session: 'claude-demo' });
    assert.deepStrictEqual(svc.calls.runOp, [['ccd-session', 'wake', SID]]);
  }
});

test('POST wake: exit 7 is 409 memory-offline with the mcp list output', async (t) => {
  const { s, wake } = await wakeStack('sleeping', async () => ({ rc: 7, log: 'memory offline\nbasic-memory: x - \u2717 Failed to connect\n' }));
  t.after(s.stop);
  const r = await wake(SID);
  assert.strictEqual(r.status, 409);
  assert.deepStrictEqual(await r.json(), { error: 'memory-offline', message: 'memory offline', output: 'basic-memory: x - \u2717 Failed to connect' });
});

test('POST wake: refuses bad ids, unknown, live and already woken conversations; reports failures', async (t) => {
  const { s, svc, wake } = await wakeStack('sleeping');
  t.after(s.stop);
  assert.strictEqual((await wake('not-a-uuid')).status, 400);
  assert.strictEqual((await wake('00000000-0000-4000-8000-0000000000ff')).status, 404);
  assert.strictEqual((await wake(SID2)).status, 409);
  svc.reconciler.get = () => ({ status: 'sleeping', hidden: true });
  assert.strictEqual((await wake(SID)).status, 409);
  assert.deepStrictEqual(svc.calls.runOp, []);
  svc.reconciler.get = () => ({ status: 'sleeping', hidden: false });
  svc.ctl.op = async () => ({ rc: 1, log: 'no such conversation\n' });
  const r = await wake(SID);
  assert.strictEqual(r.status, 502);
  assert.match((await r.json()).log, /no such conversation/);
  svc.ctl.op = async () => ({ timedOut: true, log: '' });
  assert.strictEqual((await wake(SID)).status, 504);
});
