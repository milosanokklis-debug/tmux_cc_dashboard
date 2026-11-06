'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createReader } = require('../lib/reader');
const { createTokens, readTranscript, transcriptFiles, subagentPath, PRICE_NOTE } = require('../lib/tokens');

const T0 = Date.parse('2026-01-10T10:00:00Z') / 1000; // 5-hour windows are epoch-aligned
const iso = (s) => new Date(s * 1000).toISOString();

// An assistant line as Claude Code writes it: one line per content block, usage repeated.
const asst = (id, ts, usage, { model = 'claude-sonnet-5-5', rid = `req_${id}`, text = 'hi' } = {}) => JSON.stringify({
  type: 'assistant', timestamp: iso(ts), requestId: rid,
  message: {
    id, model, role: 'assistant', content: [{ type: 'text', text }],
    usage: { input_tokens: usage[0], output_tokens: usage[1], cache_creation_input_tokens: usage[2], cache_read_input_tokens: usage[3], service_tier: 'standard' },
  },
});
const user = (ts, text) => JSON.stringify({ type: 'user', timestamp: iso(ts), message: { role: 'user', content: text } });

function env() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-tok-')));
  const root = path.join(tmp, 'projects');
  fs.mkdirSync(path.join(root, 'p', 'S1', 'subagents'), { recursive: true });
  const reader = createReader({ dir: root });
  const main = path.join(root, 'p', 'S1.jsonl');
  const sub = path.join(root, 'p', 'S1', 'subagents', 'agent-a1.jsonl');
  const tokens = createTokens({ reader, minIntervalMs: 0 });
  const files = [
    { path: main, conv: 'S1', project: 'demo', agent: 'main', agent_type: null },
    { path: sub, conv: 'S1', project: 'demo', agent: 'a1', agent_type: 'runner' },
  ];
  return { tmp, root, reader, main, sub, tokens, files };
}

test('totals match a manual sum; a message repeated over several lines counts once', async () => {
  const e = env();
  fs.writeFileSync(e.main, [
    user(T0, 'go'),
    asst('m1', T0 + 1, [2, 100, 5000, 0]), asst('m1', T0 + 2, [2, 100, 5000, 0]), asst('m1', T0 + 3, [2, 100, 5000, 0]),
    asst('m2', T0 + 10, [4, 50, 10, 5000], { model: 'claude-opus-5-5' }),
    'not json at all {', '{"type":"summary"}',
  ].join('\n') + '\n');
  fs.writeFileSync(e.sub, [asst('s1', T0 + 20, [1, 7, 0, 3], { model: 'claude-haiku-5-5' })].join('\n') + '\n');
  await e.tokens.refresh(e.files);
  const v = e.tokens.views();
  assert.equal(v.price_note, 'API-price estimate, not billing');
  assert.equal(PRICE_NOTE, v.price_note);
  assert.deepEqual([v.total.input, v.total.output, v.total.cache_creation, v.total.cache_read, v.total.messages], [7, 157, 5010, 5003, 3]);
  const conv = e.tokens.forNode('S1');
  assert.equal(conv.output, 157);
  assert.equal(e.tokens.forNode('S1', 'a1').output, 7);
  assert.equal(e.tokens.forNode('S1', 'main').output, 150);
  assert.equal(e.tokens.forNode('nope'), null);
  // views by model, project, conversation, agent
  assert.deepEqual(v.by_model.map((m) => [m.model, m.output]).sort(), [['claude-haiku-5-5', 7], ['claude-opus-5-5', 50], ['claude-sonnet-5-5', 100]]);
  assert.deepEqual(v.by_project.map((p) => [p.project, p.output]), [['demo', 157]]);
  assert.deepEqual(v.by_conversation.map((c) => [c.conversation, c.output]), [['S1', 157]]);
  assert.deepEqual(v.by_agent.map((a) => [a.agent, a.output]).sort(), [['a1', 7], ['main', 150]]);
  assert.equal(v.by_agent.find((a) => a.agent === 'a1').agent_type, 'runner');
  // cost: sonnet (2*3 + 100*15 + 5000*3.75)/1e6 + opus (4*5 + 50*25 + 10*6.25 + 5000*0.5)/1e6 + haiku (1 + 35 + 3*0.1)/1e6
  const expect = (2 * 3 + 100 * 15 + 5000 * 3.75 + 4 * 5 + 50 * 25 + 10 * 6.25 + 5000 * 0.5 + 1 * 1 + 7 * 5 + 3 * 0.1) / 1e6;
  assert.ok(Math.abs(v.total.cost_usd - expect) < 0.0001, `${v.total.cost_usd} vs ${expect}`);
  assert.equal(v.reader.unavailable, false);
});

test('a message whose usage grows between lines is counted at its last value', async () => {
  const e = env();
  fs.writeFileSync(e.main, `${asst('m1', T0, [1, 10, 0, 0])}\n${asst('m1', T0 + 1, [1, 90, 0, 0])}\n`);
  await e.tokens.refresh(e.files);
  assert.equal(e.tokens.views().total.output, 90);
  assert.equal(e.tokens.views().total.messages, 1);
});

test('5-hour windows split on the epoch-aligned boundary', async () => {
  const e = env();
  const start = Math.floor(T0 / 18000) * 18000;
  fs.writeFileSync(e.main, `${asst('a', start + 17999, [0, 1, 0, 0])}\n${asst('b', start + 18000, [0, 2, 0, 0])}\n${asst('c', start + 18001, [0, 4, 0, 0])}\n`);
  await e.tokens.refresh(e.files);
  const w = e.tokens.views().by_window;
  assert.deepEqual(w.map((x) => [x.start, x.end, x.output]), [[start + 18000, start + 36000, 6], [start, start + 18000, 1]]);
});

test('incremental: only new bytes are consumed and a partial last line is carried', async () => {
  const e = env();
  const l1 = `${asst('m1', T0, [1, 10, 0, 0])}\n`;
  const l2 = `${asst('m2', T0 + 1, [1, 20, 0, 0])}\n`;
  fs.writeFileSync(e.main, l1 + l2.slice(0, 40));
  await e.tokens.refresh(e.files);
  assert.equal(e.tokens.views().total.output, 10);
  const st = e.tokens._files.get(e.main);
  assert.equal(st.offset, Buffer.byteLength(l1) + 40);
  fs.appendFileSync(e.main, l2.slice(40));
  const reads = [];
  const orig = e.reader.read;
  e.reader.read = async (...a) => { reads.push(a[1]); return orig(...a); };
  await e.tokens.refresh(e.files);
  assert.equal(e.tokens.views().total.output, 30);
  assert.equal(reads[0], Buffer.byteLength(l1) + 40, 'read resumed at the stored offset');
  await e.tokens.refresh(e.files); // nothing new: nothing double counted
  assert.equal(e.tokens.views().total.output, 30);
});

test('a replaced file (new inode) and a truncated file are re-read from byte 0', async () => {
  const e = env();
  fs.writeFileSync(e.main, `${asst('m1', T0, [1, 10, 0, 0])}\n${asst('m2', T0 + 1, [1, 20, 0, 0])}\n`);
  await e.tokens.refresh(e.files);
  assert.equal(e.tokens.views().total.output, 30);
  // replaced by a longer file with other content: only the inode tells
  const other = `${e.main}.new`;
  fs.writeFileSync(other, `${asst('x1', T0, [0, 5, 0, 0])}\n${asst('x2', T0, [0, 6, 0, 0])}\n${asst('x3', T0, [0, 7, 0, 0])}\n${asst('x4', T0, [0, 8, 0, 0])}\n`);
  fs.renameSync(other, e.main);
  await e.tokens.refresh(e.files);
  assert.equal(e.tokens.views().total.output, 26);
  // truncated in place
  fs.truncateSync(e.main, 0);
  fs.appendFileSync(e.main, `${asst('y1', T0, [0, 3, 0, 0])}\n`);
  await e.tokens.refresh(e.files);
  assert.equal(e.tokens.views().total.output, 3);
});

test('after a restart the totals are rebuilt from offset 0 and equal the old ones', async () => {
  const e = env();
  fs.writeFileSync(e.main, `${asst('m1', T0, [1, 10, 2, 3])}\n${asst('m1', T0, [1, 10, 2, 3])}\n${asst('m2', T0 + 5, [4, 20, 5, 6])}\n`);
  await e.tokens.refresh(e.files);
  const fresh = createTokens({ reader: e.reader, minIntervalMs: 0 });
  await fresh.refresh(e.files);
  assert.deepEqual(fresh.views().total, e.tokens.views().total);
  assert.equal(fresh._files.get(e.main).offset, fs.statSync(e.main).size);
});

test('conversation filter, unknown models are unpriced, a missing file does not break the rest', async () => {
  const e = env();
  const other = path.join(e.root, 'p', 'S2.jsonl');
  fs.writeFileSync(e.main, `${asst('m1', T0, [0, 10, 0, 0])}\n`);
  fs.writeFileSync(other, `${asst('o1', T0, [0, 99, 0, 0], { model: 'mystery-9' })}\n`);
  const files = [...e.files, { path: other, conv: 'S2', project: 'other', agent: 'main' }];
  await e.tokens.refresh(files);
  assert.equal(e.tokens.views({ conversation: 'S1' }).total.output, 10);
  assert.deepEqual(e.tokens.views({ conversation: 'S1' }).by_conversation.map((c) => c.conversation), ['S1']);
  const all = e.tokens.views();
  assert.equal(all.total.output, 109);
  assert.deepEqual(all.unpriced_models, ['mystery-9']);
  assert.equal(e.tokens._files.get(e.sub).error, 'not_found'); // the subagent file does not exist (yet)
  assert.equal(e.tokens.forNode('S1', 'a1'), null);
});

test('a reader that is down shows up as unavailable, not as zero usage', async () => {
  const reader = createReader({ sock: '/nonexistent/reader.sock', dir: null });
  const t = createTokens({ reader, minIntervalMs: 0 });
  await t.refresh([{ path: '/home/ccd/.claude/projects/p/x.jsonl', conv: 'S1', project: 'p', agent: 'main' }]);
  assert.equal(t.views().reader.unavailable, true);
  assert.equal(t.forNode('S1'), null);
});

test('refresh is throttled by minIntervalMs', async () => {
  const e = env();
  let t = 1000;
  const tokens = createTokens({ reader: e.reader, now: () => t, minIntervalMs: 2000 });
  fs.writeFileSync(e.main, `${asst('m1', T0, [0, 10, 0, 0])}\n`);
  await tokens.refresh(e.files);
  fs.appendFileSync(e.main, `${asst('m2', T0, [0, 10, 0, 0])}\n`);
  t += 500;
  await tokens.refresh(e.files);
  assert.equal(tokens.views().total.output, 10);
  t += 2000;
  await tokens.refresh(e.files);
  assert.equal(tokens.views().total.output, 20);
});

test('transcriptFiles uses the hook path, else derives the subagent path from the main transcript', () => {
  const main = '/home/ccd/.claude/projects/p/S1.jsonl';
  const files = transcriptFiles(
    [{ sid: 'S1', project: 'demo', subs: [{ agent_id: 'a1', agent_type: 'r', transcript: null }, { agent_id: 'a2', agent_type: 'r', transcript: '/home/ccd/.claude/projects/p/S1/subagents/agent-a2.jsonl' }] }],
    new Map([['S1', { transcript: main }]]),
  );
  assert.deepEqual(files.map((f) => [f.agent, f.path]), [
    ['main', main],
    ['a1', '/home/ccd/.claude/projects/p/S1/subagents/agent-a1.jsonl'],
    ['a2', '/home/ccd/.claude/projects/p/S1/subagents/agent-a2.jsonl'],
  ]);
  assert.equal(subagentPath('/x/y.txt', 'S1', 'a1'), null);
  assert.equal(subagentPath(main, 'S1', '../x'), null);
  assert.deepEqual(transcriptFiles([{ sid: 'S9', project: null, subs: [{ agent_id: 'a', transcript: null }] }], new Map()), []);
});

test('readTranscript: tail, then follow by next_offset, complete lines only, bounded, sanitized', async () => {
  const e = env();
  const lines = [user(T0, 'hello\u001b[31m'), asst('m1', T0 + 1, [1, 2, 3, 4], { text: 'x'.repeat(5000) })];
  fs.writeFileSync(e.main, `${lines.join('\n')}\n{"type":"assis`);
  const a = await readTranscript(e.reader, e.main);
  assert.equal(a.entries.length, 2);
  assert.equal(a.entries[0].role, 'user');
  assert.ok(!a.entries[0].parts[0].text.includes('\u001b'));
  assert.ok(a.entries[1].parts[0].text.length <= 2001);
  assert.equal(a.offset, 0);
  assert.equal(a.next_offset, Buffer.byteLength(`${lines.join('\n')}\n`));
  fs.appendFileSync(e.main, `tant"}\n${user(T0 + 9, 'later')}\n`);
  const b = await readTranscript(e.reader, e.main, { offset: a.next_offset });
  assert.deepEqual(b.entries.map((x) => x.parts[0].text), ['later']);
  assert.equal(b.next_offset, fs.statSync(e.main).size);
  const c = await readTranscript(e.reader, e.main, { offset: b.next_offset });
  assert.equal(c.entries.length, 0);
  // an offset past the end (file replaced by a shorter one) restarts at the tail
  fs.writeFileSync(e.main, `${user(T0, 'new')}\n`);
  const d = await readTranscript(e.reader, e.main, { offset: 100000 });
  assert.equal(d.reset, true);
  assert.equal(d.entries[0].parts[0].text, 'new');
  // a big file: only the tail comes back, starting at a line boundary
  fs.writeFileSync(e.main, Array.from({ length: 5000 }, (_, i) => user(T0 + i, `line ${i} ${'y'.repeat(100)}`)).join('\n') + '\n');
  const big = await readTranscript(e.reader, e.main);
  assert.ok(big.offset > 0 && big.entries.length <= 200);
  assert.match(big.entries.at(-1).parts[0].text, /^line 4999 /);
  assert.ok(big.truncated);
});

test('the fake claude\'s transcripts (duplicate lines, a subagent file) add up to the manual sum', { skip: spawnSync('jq', ['--version']).status !== 0 && 'needs jq' }, async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-fake-')));
  const projects = path.join(tmp, 'projects');
  const r = spawnSync(path.join(__dirname, '..', '..', 'tests', 'fake-claude', 'claude'), [], {
    input: 'one\ntwo /sub\n', cwd: tmp, encoding: 'utf8',
    env: { ...process.env, FAKE_CLAUDE_TRANSCRIPTS: projects, FAKE_CLAUDE_USAGE: '1 2 3 4', FAKE_CLAUDE_HOME: path.join(tmp, 'fh'), FAKE_CLAUDE_SETTINGS: '/nonexistent', FAKE_CLAUDE_FIXTURES: path.join(__dirname, '..', '..', 'tests', 'fixtures', '2.1.317') },
  });
  assert.equal(r.status, 0);
  const dir = path.join(projects, fs.readdirSync(projects)[0]);
  const main = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.jsonl')));
  const sid = path.basename(main, '.jsonl');
  const subDir = path.join(dir, sid, 'subagents');
  const sub = path.join(subDir, fs.readdirSync(subDir)[0]);
  const tokens = createTokens({ reader: createReader({ dir: projects }), minIntervalMs: 0 });
  await tokens.refresh(transcriptFiles(
    [{ sid, project: 'fake', subs: [{ agent_id: path.basename(sub, '.jsonl').slice(6), agent_type: 'x', transcript: null }] }],
    new Map([[sid, { transcript: main }]]),
  ));
  // 2 prompts + 1 subagent message, 4 assistant lines in the main file but 2 messages
  const t = tokens.forNode(sid);
  assert.deepEqual([t.input, t.output, t.cache_creation, t.cache_read, t.messages], [3, 6, 9, 12, 3]);
});

test('readTranscript skips one oversized line instead of stalling on it', async () => {
  const e = env();
  const good = user(T0 + 5, 'after the big one');
  fs.writeFileSync(e.main, `${user(T0, 'first')}\n${'x'.repeat(600 * 1024)}\n${good}\n`);
  // follow mode from the start of the oversized line: every call moves forward
  const start = Buffer.byteLength(`${user(T0, 'first')}\n`);
  let off = start;
  let sawGood = false;
  for (let i = 0; i < 6 && off < fs.statSync(e.main).size; i++) {
    const r = await readTranscript(e.reader, e.main, { offset: off });
    assert.ok(r.next_offset > off, 'next_offset must advance');
    if (i === 0) assert.ok(r.truncated);
    sawGood ||= r.entries.some((x) => x.parts[0].text === 'after the big one');
    off = r.next_offset;
  }
  assert.ok(sawGood);
  // tail mode inside the oversized line: resumes at the end of the file
  fs.writeFileSync(e.main, `${user(T0, 'first')}\n${'x'.repeat(600 * 1024)}`);
  const t = await readTranscript(e.reader, e.main);
  assert.equal(t.next_offset, fs.statSync(e.main).size);
  assert.ok(t.truncated);
});

test('an oversized unterminated line is dropped from the carry; later lines still count', async () => {
  const e = env();
  fs.writeFileSync(e.main, `${'x'.repeat(9 * 1024 * 1024)}`);
  await e.tokens.refresh(e.files);
  assert.equal(e.tokens._files.get(e.main).carry.length, 0);
  fs.appendFileSync(e.main, `yyy\n${asst('m1', T0 + 1, [1, 2, 3, 4])}\n`);
  await e.tokens.refresh(e.files);
  assert.equal(e.tokens.forNode('S1').output, 2);
});
