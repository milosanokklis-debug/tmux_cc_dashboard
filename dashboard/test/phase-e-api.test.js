'use strict';
// Phase E over HTTP: /api/usage, /api/tokens, /api/transcript, and the richer /api/tree nodes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('./helpers');
const { createReader } = require('../lib/reader');
const { createTokens } = require('../lib/tokens');
const { createUsageFallback } = require('../lib/usage-fallback');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'tests', 'fixtures', '2.1.317', 'statusline.json'), 'utf8'));
const NOW_MS = Date.parse('2026-01-10T12:00:00Z');
const NOW = NOW_MS / 1000;
const iso = (s) => new Date(s * 1000).toISOString();
const asst = (id, ts, usage, model = 'claude-sonnet-5-5') => JSON.stringify({
  type: 'assistant', timestamp: iso(ts), requestId: `r${id}`,
  message: { id, model, role: 'assistant', content: [{ type: 'text', text: `reply ${id}` }], usage: { input_tokens: usage[0], output_tokens: usage[1], cache_creation_input_tokens: usage[2], cache_read_input_tokens: usage[3] } },
});
const user = (ts, text) => JSON.stringify({ type: 'user', timestamp: iso(ts), message: { role: 'user', content: text } });

function world() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-e-')));
  const projects = path.join(base, 'projects');
  const usageDir = path.join(base, 'usage');
  fs.mkdirSync(path.join(projects, 'p', 'S1', 'subagents'), { recursive: true });
  fs.mkdirSync(usageDir);
  const main = path.join(projects, 'p', 'S1.jsonl');
  const sub = path.join(projects, 'p', 'S1', 'subagents', 'agent-a1.jsonl');
  fs.writeFileSync(main, [user(NOW - 100, 'build it'), asst('m1', NOW - 90, [2, 100, 500, 0]), asst('m1', NOW - 89, [2, 100, 500, 0]), asst('m2', NOW - 50, [3, 40, 0, 500], 'claude-opus-5-5')].join('\n') + '\n');
  fs.writeFileSync(sub, [user(NOW - 80, 'sub task'), asst('s1', NOW - 70, [1, 9, 0, 0], 'claude-haiku-5-5')].join('\n') + '\n');
  fs.writeFileSync(path.join(base, 'secret.jsonl'), 'secret');
  const ev = (e, extra = {}) => JSON.stringify({ ev: e, ts: iso(NOW - 100), sid: 'S1', pane: '%3', win: 'claude-demo:0', project: '/workspace/demo', ...extra });
  const agentsDir = path.join(base, 'agents');
  fs.mkdirSync(agentsDir);
  fs.writeFileSync(path.join(agentsDir, 'S1.jsonl'), [
    ev('session'),
    ev('start', { agent_id: 'a1', agent_type: 'runner', ts: iso(NOW - 85) }),
    ev('stop', { agent_id: 'a1', agent_type: 'runner', ts: iso(NOW - 60), agent_transcript: sub }),
    ev('start', { agent_id: 'a2', agent_type: 'runner', ts: iso(NOW - 20) }), // no transcript yet, no file either
  ].join('\n') + '\n');
  const reader = createReader({ dir: projects });
  const snapshot = new Map([['S1', { sid: 'S1', status: 'working', transcript: main, project: 'demo', hidden: false }]]);
  const tokens = createTokens({ reader, minIntervalMs: 0 });
  return { base, projects, usageDir, main, sub, agentsDir, reader, snapshot, tokens };
}

async function boot(w, over = {}) {
  const svc = h.fakeServices({
    agentsDir: w.agentsDir, transcriptRoot: w.base, reader: w.reader, tokens: w.tokens, usageDir: w.usageDir,
    usageFallback: createUsageFallback({ tmux: { ensureOps: async () => {}, run: async () => '' }, env: {}, flagFile: '/nonexistent' }),
    tmux: { sock: '/x', listPanes: async () => [{ session: 'claude-demo', window: '0', paneId: '%3', panePid: 100 }], run: async () => '', ensureOps: async () => {} },
    procTable: () => new Map([[100, { ppid: 1, comm: 'bash' }], [101, { ppid: 100, comm: 'claude' }]]),
    reconciler: { tick: async () => w.snapshot, snapshot: () => w.snapshot, get: (s) => w.snapshot.get(s) ?? null },
    now: () => NOW_MS,
    ...over,
  });
  const s = await h.authed(svc);
  return { ...s, get: (p) => h.req(s.base, p, { cookie: s.cookie }) };
}

test('/api/usage: gauges from the freshest statusline reading, countdown from now', async (t) => {
  const w = world();
  fs.writeFileSync(path.join(w.usageDir, 'a.json'), JSON.stringify({ sid: 'a', ts: NOW - 30, rate_limits: { five_hour: { used_percentage: 23.5, resets_at: NOW + 3600 }, seven_day: { used_percentage: 41.2, resets_at: NOW + 86400 } } }));
  fs.writeFileSync(path.join(w.usageDir, 'b.json'), JSON.stringify({ sid: 'b', ts: NOW - 5, rate_limits: null }));
  const s = await boot(w);
  t.after(s.stop);
  const r = await s.get('/api/usage');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.five_hour, { status: 'ok', used_percentage: 23.5, resets_at: NOW + 3600, countdown: 3600, ts: NOW - 30, stale: false });
  assert.equal(j.seven_day.countdown, 86400);
  assert.equal(j.source, 'statusline');
  assert.equal(j.fallback_enabled, false);
  // the repo fixture's own numbers
  fs.writeFileSync(path.join(w.usageDir, 'c.json'), JSON.stringify({ ts: NOW, rate_limits: FIXTURE.rate_limits }));
  const j2 = await (await s.get('/api/usage')).json();
  assert.equal(j2.five_hour.used_percentage, FIXTURE.rate_limits.five_hour.used_percentage);
});

test('/api/usage: no rate_limits anywhere -> unknown, and the switched-off fallback is not started', async (t) => {
  const w = world();
  fs.writeFileSync(path.join(w.usageDir, 'a.json'), JSON.stringify({ sid: 'a', ts: NOW, rate_limits: null }));
  const calls = [];
  const s = await boot(w, { usageFallback: { latest: () => null, enabled: () => false, refresh: () => { calls.push('refresh'); } } });
  t.after(s.stop);
  const j = await (await s.get('/api/usage')).json();
  assert.deepEqual(j.five_hour, { status: 'unknown' });
  assert.deepEqual(j.seven_day, { status: 'unknown' });
  assert.equal(j.source, null);
  assert.deepEqual(calls, ['refresh']); // refresh() itself is a no-op while disabled (see the fallback tests)
});

test('/api/tokens: totals for the conversation include its subagent; conversation filter; price note', async (t) => {
  const w = world();
  const s = await boot(w);
  t.after(s.stop);
  const j = await (await s.get('/api/tokens')).json();
  assert.equal(j.price_note, 'API-price estimate, not billing');
  assert.deepEqual([j.total.input, j.total.output, j.total.cache_creation, j.total.cache_read], [6, 149, 500, 500]);
  assert.deepEqual(j.by_agent.map((a) => [a.agent, a.output]).sort(), [['a1', 9], ['main', 140]]);
  assert.deepEqual(j.by_project.map((p) => [p.project, p.output]), [['demo', 149]]);
  assert.equal(j.by_window.length, 1);
  assert.equal(j.reader.unavailable, false);
  const one = await (await s.get('/api/tokens?conversation=S1')).json();
  assert.equal(one.conversation, 'S1');
  assert.equal(one.total.output, 149);
  assert.equal((await (await s.get('/api/tokens?conversation=nope')).json()).total.output, 0);
  assert.equal((await s.get('/api/tokens?conversation=../x')).status, 400);
});

test('/api/tokens with the reader down says so instead of showing zeros as fact', async (t) => {
  const w = world();
  w.tokens = createTokens({ reader: createReader({ sock: path.join(w.base, 'none.sock'), dir: null }), minIntervalMs: 0 });
  const s = await boot(w, { reader: createReader({ sock: path.join(w.base, 'none.sock'), dir: null }) });
  t.after(s.stop);
  const j = await (await s.get('/api/tokens')).json();
  assert.equal(j.reader.unavailable, true);
  const r = await s.get('/api/transcript?conv=S1');
  assert.equal(r.status, 503);
  assert.ok(!JSON.stringify(await r.json()).includes(w.base));
});

test('/api/transcript: tail, follow by offset, subagent, and no way to name a path', async (t) => {
  const w = world();
  const s = await boot(w);
  t.after(s.stop);
  const a = await (await s.get('/api/transcript?conv=S1')).json();
  assert.equal(a.agent, 'main');
  assert.deepEqual(a.entries.map((e) => e.role), ['user', 'assistant', 'assistant', 'assistant']);
  assert.equal(a.entries[0].parts[0].text, 'build it');
  fs.appendFileSync(w.main, `${user(NOW, 'next')}\n`);
  const b = await (await s.get(`/api/transcript?conv=S1&offset=${a.next_offset}`)).json();
  assert.deepEqual(b.entries.map((e) => e.parts[0].text), ['next']);
  const sub = await (await s.get('/api/transcript?conv=S1&agent=a1')).json();
  assert.equal(sub.agent_type, 'runner');
  assert.equal(sub.entries[1].model, 'claude-haiku-5-5');
  // derived subagent path (no hook path yet) whose file does not exist yet -> 404
  assert.equal((await s.get('/api/transcript?conv=S1&agent=a2')).status, 404);
  for (const q of ['conv=S1&agent=zzz', 'conv=other', `conv=S1&agent=${encodeURIComponent('../../x')}`, 'conv=S1&offset=-1', 'conv=S1&offset=abc', 'conv=', 'path=/etc/passwd']) {
    const r = await s.get(`/api/transcript?${q}`);
    assert.ok([400, 404].includes(r.status), `${q} -> ${r.status}`);
    await r.arrayBuffer();
  }
  assert.equal((await h.req(s.base, '/api/transcript?conv=S1', { method: 'POST', headers: h.POST_HEADERS, cookie: s.cookie })).status, 405);
});

test('/api/transcript cannot be pointed outside the projects root through a hook-supplied path', async (t) => {
  const w = world();
  fs.appendFileSync(path.join(w.agentsDir, 'S1.jsonl'), JSON.stringify({ ev: 'stop', ts: iso(NOW), sid: 'S1', agent_id: 'evil', agent_type: 'x', agent_transcript: path.join(w.base, 'secret.jsonl') }) + '\n');
  fs.appendFileSync(path.join(w.agentsDir, 'S1.jsonl'), JSON.stringify({ ev: 'start', ts: iso(NOW), sid: 'S1', agent_id: 'evil2', agent_type: 'x' }) + '\n');
  fs.appendFileSync(path.join(w.agentsDir, 'S1.jsonl'), JSON.stringify({ ev: 'stop', ts: iso(NOW), sid: 'S1', agent_id: 'evil2', agent_type: 'x', agent_transcript: '/etc/passwd' }) + '\n');
  const s = await boot(w);
  t.after(s.stop);
  for (const agent of ['evil', 'evil2']) {
    const r = await s.get(`/api/transcript?conv=S1&agent=${agent}`);
    assert.equal(r.status, 404);
    assert.ok(!(await r.text()).includes('secret'));
  }
  const tk = await (await s.get('/api/tokens')).json();
  assert.equal(tk.total.output, 149);
});

test('/api/tree nodes carry model, elapsed, tokens and a transcript reference', async (t) => {
  const w = world();
  const s = await boot(w);
  t.after(s.stop);
  await s.get('/api/tokens'); // reads the transcripts (the tree itself never waits for them)
  const j = await (await s.get('/api/tree')).json();
  const c = j.projects.find((p) => p.project === 'demo').conversations[0];
  assert.equal(c.sid, 'S1');
  assert.equal(c.model, 'claude-opus-5-5');
  assert.equal(c.tokens.output, 149);
  assert.deepEqual(c.transcript, { conv: 'S1', agent: 'main' });
  assert.equal(c.elapsed, 100); // started NOW-100, still live
  const a1 = c.subagents.find((x) => x.agent_id === 'a1');
  assert.equal(a1.model, 'claude-haiku-5-5');
  assert.equal(a1.tokens.output, 9);
  assert.deepEqual(a1.transcript, { conv: 'S1', agent: 'a1' });
  assert.equal(a1.elapsed, 25);
  const a2 = c.subagents.find((x) => x.agent_id === 'a2');
  assert.equal(a2.tokens, null); // never read: unknown, not zero
  assert.equal(a2.model, null);
  assert.equal(a2.elapsed, 20);
  assert.equal(a2.status, 'running');
});
