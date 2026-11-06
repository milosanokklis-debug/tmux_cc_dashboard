'use strict';
// Phase B leftover: the process table (and its parent -> children index) is built once per
// reconciler tick and shared by every conversation, not once per conversation.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createReconciler } = require('../lib/state');
const { hasClaude, _stats } = require('../lib/tmux');

const N = 25;

test('a tick with N conversations reads /proc once and indexes it once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-pt-'));
  const panes = [];
  const table = new Map();
  for (let i = 0; i < N; i++) {
    const sid = `c${i}`;
    fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({ sid, state: 'waiting', ts: 1, pane: `%${i}`, tmux_pid: 77, waiting_since: 1 }));
    panes.push({ session: `claude-p${i}`, window: '0', paneId: `%${i}`, panePid: 1000 + i * 10 });
    table.set(1000 + i * 10, { ppid: 1, comm: 'bash' });
    table.set(1001 + i * 10, { ppid: 1000 + i * 10, comm: 'claude' });
  }
  let reads = 0;
  const r = createReconciler({
    stateDir: dir, now: () => 5000, log: () => {},
    procTable: () => { reads++; return new Map(table); }, // a fresh snapshot per tick, as readProcTable gives
    tmux: { listPanes: async () => panes, run: async () => '77 1000\n' },
  });
  const before = _stats.indexBuilds;
  await r.tick();
  assert.equal(reads, 1, 'one /proc read per tick');
  assert.equal(_stats.indexBuilds - before, 1, 'one index build per tick, not one per conversation');
  assert.equal([...r.snapshot().values()].filter((x) => x.status === 'waiting').length, N);
  await r.tick();
  assert.equal(reads, 2);
  assert.equal(_stats.indexBuilds - before, 2);
  fs.rmSync(dir, { recursive: true });
});

test('hasClaude still answers correctly on a shared table, and re-indexes a table that changed', () => {
  const table = new Map([[10, { ppid: 1, comm: 'bash' }], [11, { ppid: 10, comm: 'node' }]]);
  assert.equal(hasClaude(table, 10), false);
  table.set(12, { ppid: 11, comm: 'claude' });
  assert.equal(hasClaude(table, 10), true);
  assert.equal(hasClaude(table, 12), true);
  assert.equal(hasClaude(table, 999), false);
});
