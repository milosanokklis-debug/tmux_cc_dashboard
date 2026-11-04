'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildTree, _parsed } = require('../lib/tree');

const FIX = path.join(__dirname, 'fixtures');
const NOW = Date.parse('2026-01-10T12:00:00Z');
const t = (s) => Date.parse(s) / 1000; // API timestamps are unix seconds

// Copies the synthetic agents.sh output into a temp dir, pointing transcripts at a temp root.
function setup(only) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-tree-'));
  const agentsDir = path.join(root, 'agents');
  const transcriptRoot = path.join(root, 'claude');
  fs.mkdirSync(agentsDir); fs.mkdirSync(transcriptRoot);
  for (const f of fs.readdirSync(path.join(FIX, 'transcripts'))) {
    fs.copyFileSync(path.join(FIX, 'transcripts', f), path.join(transcriptRoot, f));
  }
  for (const f of fs.readdirSync(path.join(FIX, 'agents'))) {
    if (only && !only.includes(f)) continue;
    fs.writeFileSync(path.join(agentsDir, f),
      fs.readFileSync(path.join(FIX, 'agents', f), 'utf8').replaceAll('__TRANSCRIPTS__', transcriptRoot));
  }
  return { agentsDir, transcriptRoot };
}

// pane %3 (claude-demo:0) runs claude; %4 and %6 exist but run only a shell.
const PANES = [
  { session: 'claude-demo', window: '0', paneId: '%3', panePid: 100 },
  { session: 'web-1234abcd', window: '0', paneId: '%3', panePid: 100 },
  { session: 'claude-demo', window: '0', paneId: '%4', panePid: 200 },
  { session: 'claude-long', window: '0', paneId: '%6', panePid: 300 },
];
const TABLE = new Map([
  [100, { ppid: 1, comm: 'bash' }], [101, { ppid: 100, comm: 'claude' }],
  [200, { ppid: 1, comm: 'bash' }],
  [300, { ppid: 1, comm: 'bash' }], [301, { ppid: 300, comm: 'claude' }],
]);

function tree(opts = {}) {
  const { agentsDir, transcriptRoot } = setup(opts.only);
  return buildTree({ agentsDir, transcriptRoot, panes: PANES, table: TABLE, now: NOW, all: opts.all });
}
const convs = (tr, project) => tr.find((p) => p.project === project)?.conversations ?? [];

test('folds a running conversation with running and done subagents', () => {
  const run = convs(tree(), 'demo').find((c) => c.sid === 'run1');
  assert.strictEqual(run.status, 'running');
  assert.strictEqual(run.win, 'claude-demo:0');
  assert.strictEqual(run.startedTs, t('2026-01-10T10:00:00Z'));
  assert.strictEqual(run.endedTs, null);
  assert.deepStrictEqual(run.subagents.map((s) => [s.agent_id, s.agent_type, s.status, s.startTs, s.endTs]), [
    ['a1', 'Explore', 'done', t('2026-01-10T10:01:00Z'), t('2026-01-10T10:03:00Z')],
    ['a2', 'general-purpose', 'running', t('2026-01-10T10:02:00Z'), null],
  ]);
});

test('task: first user message of the transcript, capped at 80 chars, no control chars; unreadable -> null', () => {
  const run = convs(tree(), 'demo').find((c) => c.sid === 'run1');
  const a1 = run.subagents[0].task;
  assert.strictEqual(a1.length, 80);
  assert.ok(a1.startsWith('Find every usage of the legacy'), a1);
  assert.ok(!/[\u0000-\u001f]/.test(a1));
  assert.strictEqual(run.subagents[1].task, null); // transcript missing
});

test('an ended conversation reports ended with endedTs; its open subagents are closed', () => {
  const ended = convs(tree(), 'demo').find((c) => c.sid === 'ended1');
  assert.strictEqual(ended.status, 'ended');
  assert.strictEqual(ended.endedTs, t('2026-01-10T08:30:00Z'));
  assert.strictEqual(ended.subagents[0].status, 'done');
  assert.strictEqual(ended.subagents[0].endTs, t('2026-01-10T08:30:00Z'));
});

test('gone: pane missing from tmux, or pane without a claude process', () => {
  const demo = convs(tree(), 'demo');
  assert.strictEqual(demo.find((c) => c.sid === 'gone1').status, 'gone'); // %9 does not exist
  assert.strictEqual(demo.find((c) => c.sid === 'gone1').subagents[0].status, 'done');
  // %4 exists but only bash runs there; ended1 has an end event so it is "ended", build a gone one:
  const only = setup(['run1.jsonl']);
  const noClaude = buildTree({ ...only, panes: PANES, table: new Map([[100, { ppid: 1, comm: 'bash' }]]), now: NOW });
  assert.strictEqual(noClaude[0].conversations[0].status, 'gone');
});

test('a pane id reused by a different tmux session does not count as running', () => {
  const only = setup(['run1.jsonl']);
  const panes = [{ session: 'claude-other', window: '0', paneId: '%3', panePid: 100 }];
  assert.strictEqual(buildTree({ ...only, panes, table: TABLE, now: NOW })[0].conversations[0].status, 'gone');
});

test('conversations are newest first and projects sorted; sub-24h ended/gone kept', () => {
  const demo = convs(tree(), 'demo');
  assert.deepStrictEqual(demo.map((c) => c.sid), ['corrupt1', 'run1', 'gone1', 'ended1']);
});

test('24h hiding: old ended/gone hidden by default, shown with all; old but running always shown', () => {
  const def = tree();
  assert.ok(!def.some((p) => p.project === 'other'), 'old1 hidden');
  assert.ok(def.some((p) => p.project === 'long'), 'stale1 still has a live claude: shown');
  assert.strictEqual(convs(def, 'long')[0].status, 'running');
  const all = tree({ all: true });
  assert.strictEqual(convs(all, 'other')[0].sid, 'old1');
  assert.strictEqual(convs(all, 'other')[0].status, 'ended');
});

test('project is the /workspace/<name> segment, else the basename', () => {
  const names = tree().map((p) => p.project);
  assert.ok(names.includes('demo') && names.includes('long'));
});

test('corrupt lines, unknown events, bad ts and odd sids are skipped; later valid events still count', () => {
  const c = convs(tree({ only: ['corrupt1.jsonl'] }), 'demo');
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].sid, 'corrupt1');
  assert.strictEqual(c[0].win, 'claude-demo:0'); // first non-empty win
  assert.deepStrictEqual(c[0].subagents.map((s) => [s.agent_id, s.status]), [['c1', 'done']]);
});

test('hook fields are sanitized and length-limited; non-string ids dropped; /etc/passwd transcript ignored', () => {
  const tr = tree({ only: ['evil1.jsonl'], all: true });
  assert.strictEqual(tr.length, 1);
  const c = tr[0].conversations[0];
  assert.ok(tr[0].project.length <= 200 && !/[\u0000-\u001f]/.test(tr[0].project));
  assert.ok(c.win.length <= 200 && !/[\u0000-\u001f\u001b]/.test(c.win));
  assert.strictEqual(c.subagents.length, 1);
  const s = c.subagents[0];
  assert.ok(s.agent_type.length <= 200 && !s.agent_type.includes('\u001b'));
  assert.strictEqual(s.task.length, 80); // description field wins when present, capped
  assert.ok(!JSON.stringify(tr).includes('root:'));
});

test('transcripts outside the transcript root are never read', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-tree-'));
  fs.mkdirSync(path.join(root, 'agents')); fs.mkdirSync(path.join(root, 'claude'));
  fs.writeFileSync(path.join(root, 'secret.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'SECRET' } }));
  fs.writeFileSync(path.join(root, 'agents', 's.jsonl'), JSON.stringify({
    ev: 'start', ts: '2026-01-10T11:00:00Z', sid: 's', pane: '%3', win: 'claude-demo:0', project: '/workspace/demo',
    agent_id: 'x', agent_type: 'T', agent_transcript: path.join(root, 'secret.jsonl'),
  }));
  const out = buildTree({ agentsDir: path.join(root, 'agents'), transcriptRoot: path.join(root, 'claude'), panes: PANES, table: TABLE, now: NOW });
  assert.strictEqual(out[0].conversations[0].subagents[0].task, null);
});

test('missing agents dir gives an empty tree', () => {
  assert.deepStrictEqual(buildTree({ agentsDir: '/nonexistent/x', transcriptRoot: '/tmp', panes: [], table: new Map() }), []);
});

test('hook timestamps may be ISO or epoch seconds (number or string); output is integer seconds', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-tree-'));
  fs.mkdirSync(path.join(root, 'agents'));
  const base = { sid: 's', pane: '%3', win: 'claude-demo:0', project: '/workspace/demo' };
  const sec = Math.floor(NOW / 1000);
  fs.writeFileSync(path.join(root, 'agents', 's.jsonl'), [
    { ...base, ev: 'session', ts: String(sec - 100) },
    { ...base, ev: 'start', ts: sec - 50, agent_id: 'a' },
    { ...base, ev: 'stop', ts: '2026-01-10T11:59:00.900Z', agent_id: 'a' },
  ].map((e) => JSON.stringify(e)).join('\n'));
  const c = buildTree({ agentsDir: path.join(root, 'agents'), transcriptRoot: root, panes: PANES, table: TABLE, now: NOW })[0].conversations[0];
  assert.strictEqual(c.startedTs, sec - 100);
  assert.deepStrictEqual([c.subagents[0].startTs, c.subagents[0].endTs], [sec - 50, sec - 60]);
});

// ---- hostile agents dir: ccd can write there ------------------------------------------

const { spawnSync } = require('node:child_process');

// buildTree is synchronous, so a blocking open would hang this process: run it in a child
// with a timeout and fail the test instead.
function buildInChild(args) {
  const script = `const { buildTree } = require(${JSON.stringify(path.join(__dirname, '../lib/tree'))});
    const a = JSON.parse(process.argv[1]);
    process.stdout.write(JSON.stringify(buildTree({ ...a, panes: [], table: new Map(), now: ${NOW}, all: true })));`;
  const r = spawnSync(process.execPath, ['-e', script, JSON.stringify(args)], { encoding: 'utf8', timeout: 5000 });
  assert.ok(!r.error, `buildTree did not return promptly: ${r.error}`);
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const mkfifo = (p) => assert.strictEqual(spawnSync('mkfifo', [p]).status, 0);
const sids = (tr) => tr.flatMap((p) => p.conversations.map((c) => c.sid)).sort();

test('a FIFO or symlink named *.jsonl in the agents dir is skipped and never blocks', () => {
  const { agentsDir, transcriptRoot } = setup(['run1.jsonl']);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-out-'));
  fs.writeFileSync(path.join(outside, 'real.jsonl'), JSON.stringify({ ev: 'session', ts: '2026-01-10T10:00:00Z', sid: 'linked', project: '/workspace/linked' }));
  mkfifo(path.join(agentsDir, 'x.jsonl'));
  fs.symlinkSync(path.join(outside, 'real.jsonl'), path.join(agentsDir, 'link.jsonl'));
  fs.symlinkSync(agentsDir, path.join(agentsDir, 'dir.jsonl'));
  assert.deepStrictEqual(sids(buildInChild({ agentsDir, transcriptRoot })), ['run1']);
});

test('a FIFO or symlink as a subagent transcript is not read and does not block', () => {
  const { agentsDir, transcriptRoot } = setup(['run1.jsonl']);
  const sub = path.join(transcriptRoot, 'sub-a1.jsonl');
  fs.rmSync(sub);
  mkfifo(sub);
  const tr = buildInChild({ agentsDir, transcriptRoot });
  const a1 = tr[0].conversations[0].subagents.find((s) => s.agent_id === 'a1');
  assert.strictEqual(a1.task, null);
  // a symlink inside the root that points outside it resolves outside and is refused too
  fs.rmSync(sub);
  const outside = path.join(os.tmpdir(), `ccdash-secret-${process.pid}.jsonl`);
  fs.writeFileSync(outside, JSON.stringify({ type: 'user', message: { role: 'user', content: 'SECRET' } }));
  fs.symlinkSync(outside, sub);
  assert.strictEqual(buildInChild({ agentsDir, transcriptRoot })[0].conversations[0].subagents.find((s) => s.agent_id === 'a1').task, null);
  fs.rmSync(outside);
});

function bigRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-tree-'));
  fs.mkdirSync(path.join(root, 'agents'));
  return root;
}
const ev = (o) => JSON.stringify({ sid: 's', pane: '%3', win: 'claude-demo:0', project: '/workspace/demo', ...o });
const treeOf = (root, over = {}) => buildTree({ agentsDir: path.join(root, 'agents'), transcriptRoot: root, panes: PANES, table: TABLE, now: NOW, all: true, ...over });

test('a file over 512 KB is read from its tail (late end event) plus its head (project)', () => {
  const root = bigRoot();
  const file = path.join(root, 'agents', 's.jsonl');
  const filler = `${JSON.stringify({ ev: 'note', pad: 'x'.repeat(900) })}\n`.repeat(700); // ~650 KB
  fs.writeFileSync(file, `${ev({ ev: 'session', ts: '2026-01-10T10:00:00Z' })}\n${filler}${ev({ ev: 'end', ts: '2026-01-10T11:00:00Z' })}\n`);
  assert.ok(fs.statSync(file).size > 512 * 1024);
  const c = treeOf(root)[0].conversations[0];
  assert.strictEqual(c.status, 'ended');
  assert.strictEqual(c.startedTs, t('2026-01-10T10:00:00Z'));
  assert.strictEqual(c.endedTs, t('2026-01-10T11:00:00Z'));
});

test('parsed files are cached by mtime and size and re-read when they change', () => {
  const root = bigRoot();
  const file = path.join(root, 'agents', 's.jsonl');
  fs.writeFileSync(file, `${ev({ ev: 'session', ts: '2026-01-10T10:00:00Z' })}\n`);
  assert.strictEqual(treeOf(root)[0].conversations[0].status, 'running');
  fs.appendFileSync(file, `${ev({ ev: 'end', ts: '2026-01-10T11:00:00Z' })}\n`);
  assert.strictEqual(treeOf(root)[0].conversations[0].status, 'ended');
  fs.rmSync(file);
  assert.deepStrictEqual(treeOf(root), []);
});

test('only the newest 200 files are read', () => {
  const root = bigRoot();
  for (let i = 0; i < 230; i++) {
    const f = path.join(root, 'agents', `f${i}.jsonl`);
    fs.writeFileSync(f, `${ev({ ev: 'session', ts: '2026-01-10T10:00:00Z', sid: `s${i}` })}\n`);
    fs.utimesSync(f, 1_700_000_000 + i, 1_700_000_000 + i);
  }
  const got = sids(treeOf(root));
  assert.strictEqual(got.length, 200);
  assert.ok(got.includes('s229') && !got.includes('s0') && !got.includes('s29') && got.includes('s30'));
});

// ---- cache contents, tail/head merge, caches, symlinked roots -------------------------

test('the parse cache keeps only the fields fold uses, capped; huge extra fields are not retained', () => {
  const root = bigRoot();
  const file = path.join(root, 'agents', 's.jsonl');
  fs.writeFileSync(file, `${ev({ ev: 'session', ts: '2026-01-10T10:00:00Z', blob: 'B'.repeat(300 * 1024), win: 'w'.repeat(5000) })}\n` +
    `${ev({ ev: 'start', ts: '2026-01-10T10:01:00Z', agent_id: 'a', description: 'd'.repeat(5000), agent_type: 'T'.repeat(5000), junk: { deep: 'J'.repeat(100000) } })}\n`);
  treeOf(root);
  const events = _parsed.get(file).events;
  assert.strictEqual(events.length, 2);
  const allowed = new Set(['sid', 'ts', 'ev', 'project', 'win', 'pane', 'agent_id', 'agent_type', 'agent_transcript', 'description']);
  for (const e of events) assert.ok(Object.keys(e).every((k) => allowed.has(k)), Object.keys(e).join());
  assert.ok(JSON.stringify(events).length < 1500, String(JSON.stringify(events).length));
  assert.ok(events[0].win.length <= 200 && events[1].description.length <= 80);
  fs.rmSync(file);
  treeOf(root);
  assert.ok(!_parsed.has(file), 'entry dropped once the file is gone');
});

const MAX = 512 * 1024;
const note = (len) => { // one line of exactly `len` bytes including the newline
  const base = JSON.stringify({ ev: 'note', pad: '' }).length + 1;
  return `${JSON.stringify({ ev: 'note', pad: 'x'.repeat(len - base) })}\n`;
};

test('a tail that begins exactly on a line boundary keeps its first line', () => {
  const root = bigRoot();
  const file = path.join(root, 'agents', 's.jsonl');
  const end = `${ev({ ev: 'end', ts: '2026-01-10T11:00:00Z' })}\n`;
  const head = `${ev({ ev: 'session', ts: '2026-01-10T10:00:00Z' })}\n${note(40000)}`;
  fs.writeFileSync(file, head + end + note(MAX - end.length));
  assert.strictEqual(fs.statSync(file).size, head.length + MAX);
  assert.strictEqual(treeOf(root)[0].conversations[0].status, 'ended'); // the end line is the tail's first line
});

test('a tail that begins mid-line drops the partial line', () => {
  const root = bigRoot();
  const file = path.join(root, 'agents', 's.jsonl');
  const end = `${ev({ ev: 'end', ts: '2026-01-10T11:00:00Z' })}\n`;
  const head = `${ev({ ev: 'session', ts: '2026-01-10T10:00:00Z' })}\n${note(40000)}`;
  // the end line starts 10 bytes before the tail window: it is cut, and must not be parsed as a fragment
  fs.writeFileSync(file, head + end + note(MAX - end.length + 10));
  assert.strictEqual(treeOf(root)[0].conversations[0].status, 'running');
});

test('a head/tail overlap is parsed once', () => {
  const root = bigRoot();
  const file = path.join(root, 'agents', 's.jsonl');
  const lines = [];
  let size = 0;
  for (let i = 0; size < MAX + 8 * 1024; i++) {
    const l = `${ev({ ev: 'start', ts: '2026-01-10T10:00:00Z', agent_id: `a${i}`, pad: 'p'.repeat(400) })}\n`;
    lines.push(l); size += l.length;
  }
  fs.writeFileSync(file, lines.join(''));
  const total = fs.statSync(file).size;
  assert.ok(total > MAX && total < MAX + 16 * 1024, `overlap needs 512K < size < 528K, got ${total}`);
  treeOf(root);
  const ids = _parsed.get(file).events.map((e) => e.agent_id);
  assert.strictEqual(new Set(ids).size, ids.length, 'no duplicate events');
  assert.strictEqual(ids.length, lines.length, 'no lost events');
});

test('the first user message is cached by path, mtime and size', () => {
  const { agentsDir, transcriptRoot } = setup(['run1.jsonl']);
  const sub = path.join(transcriptRoot, 'sub-a1.jsonl');
  const get = () => buildTree({ agentsDir, transcriptRoot, panes: PANES, table: TABLE, now: NOW })[0].conversations[0].subagents[0].task;
  const user = (c) => JSON.stringify({ type: 'user', message: { role: 'user', content: c } });
  const stamp = () => fs.utimesSync(sub, 1_700_000_000, 1_700_000_000);
  fs.writeFileSync(sub, user('AAAA first')); stamp();
  assert.strictEqual(get(), 'AAAA first');
  fs.writeFileSync(sub, user('BBBB other')); // same size
  stamp();                                   // same mtime: served from the cache
  assert.strictEqual(get(), 'AAAA first');
  fs.writeFileSync(sub, user('CCCC a longer one'));
  assert.strictEqual(get(), 'CCCC a longer one');
});

test('a symlinked agents dir or transcript root is refused', () => {
  const { agentsDir, transcriptRoot } = setup(['run1.jsonl']);
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-ln-'));
  const aLink = path.join(holder, 'agents'); const tLink = path.join(holder, 'claude');
  fs.symlinkSync(agentsDir, aLink); fs.symlinkSync(transcriptRoot, tLink);
  assert.deepStrictEqual(buildTree({ agentsDir: aLink, transcriptRoot, panes: PANES, table: TABLE, now: NOW }), []);
  const sub = buildTree({ agentsDir, transcriptRoot: tLink, panes: PANES, table: TABLE, now: NOW })[0].conversations[0].subagents[0];
  assert.strictEqual(sub.task, null);
  const ok = buildTree({ agentsDir, transcriptRoot, panes: PANES, table: TABLE, now: NOW })[0].conversations[0].subagents[0];
  assert.ok(ok.task);
});
