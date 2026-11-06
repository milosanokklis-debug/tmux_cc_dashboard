'use strict';
// Token accounting from Claude's transcripts, read through ccd-reader (they are 0600 and only ccd
// can open them). Each transcript is read incrementally: by byte offset, reset when the inode
// changes or the file shrinks, only complete lines consumed, a partial last line carried over.
// Assistant messages repeat on several lines (one per content block) with the same message.id and
// the same usage, so a message counts once; if its usage changes between lines, the difference is
// applied. Totals live in memory only and are rebuilt from offset 0 after a restart.
const path = require('node:path');

const BUCKET = 300; // seconds; divides the 5-hour window, so a window is 60 buckets
const WINDOW = 5 * 3600;
const MAX_CHUNK = 1024 * 1024;
const MAX_FILES = 2000;
const MAX_CARRY = 8 * 1024 * 1024; // a partial line longer than this is dropped
const MAX_IDS = 20000; // message ids remembered per file for de-duplication
const MAX_BYTES_PER_SYNC = 32 * 1024 * 1024; // one sync of one file; the rest follows on the next
const FIELDS = ['input', 'output', 'cache_creation', 'cache_read'];
const USAGE_KEYS = {
  input: 'input_tokens', output: 'output_tokens',
  cache_creation: 'cache_creation_input_tokens', cache_read: 'cache_read_input_tokens',
};

const PRICE_NOTE = 'API-price estimate, not billing';
// USD per million tokens. Placeholders by model family: edit when prices change. cache_creation
// is priced as 1.25x input and cache_read as 0.1x input (the 5-minute cache write rate).
const PRICES = [
  [/opus/i, { input: 5, output: 25 }],
  [/sonnet/i, { input: 3, output: 15 }],
  [/haiku/i, { input: 1, output: 5 }],
];

function priceOf(model) {
  const hit = PRICES.find(([re]) => re.test(model));
  if (!hit) return null;
  const p = hit[1];
  return { input: p.input, output: p.output, cache_creation: p.input * 1.25, cache_read: p.input * 0.1 };
}

const zero = () => ({ input: 0, output: 0, cache_creation: 0, cache_read: 0, messages: 0, cost_usd: 0 });
const num = (v) => (Number.isFinite(v) && v >= 0 && v <= 1e12 ? Math.floor(v) : 0);
const cleanStr = (v, max = 100) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, max) || null : null);

function usageOf(u) {
  if (!u || typeof u !== 'object') return null;
  const out = {};
  for (const f of FIELDS) out[f] = num(u[USAGE_KEYS[f]]);
  return out;
}

function newState(meta) {
  return { meta, inode: null, offset: 0, carry: Buffer.alloc(0), ids: new Map(), agg: new Map(), skipping: false, error: null, synced: false, lastSeen: 0, model: null };
}
function resetState(st) {
  st.offset = 0; st.carry = Buffer.alloc(0); st.ids = new Map(); st.agg = new Map(); st.synced = false; st.skipping = false;
}

function addUsage(st, key, u, sign) {
  let e = st.agg.get(key);
  if (!e) { e = { input: 0, output: 0, cache_creation: 0, cache_read: 0, messages: 0 }; st.agg.set(key, e); }
  for (const f of FIELDS) e[f] += sign * u[f];
}

// One complete transcript line. Returns nothing; updates st.
function consumeLine(st, line) {
  if (line.length < 20 || !line.includes('"usage"')) return; // cheap filter before parsing
  let o;
  try { o = JSON.parse(line); } catch { return; }
  if (!o || o.type !== 'assistant' || !o.message || typeof o.message !== 'object') return;
  const u = usageOf(o.message.usage);
  const ts = Date.parse(o.timestamp) / 1000;
  if (!u || !Number.isFinite(ts)) return;
  const model = cleanStr(o.message.model) || 'unknown';
  if (model !== 'unknown' && model !== '<synthetic>') st.model = model;
  const key = `${Math.floor(ts / BUCKET) * BUCKET}|${model}`;
  const id = cleanStr(o.message.id, 200) || cleanStr(o.requestId, 200);
  const prev = id ? st.ids.get(id) : null;
  if (prev) { // seen on an earlier line: replace its usage
    addUsage(st, prev.key, prev.u, -1);
    st.agg.get(prev.key).messages -= 1;
  }
  addUsage(st, key, u, 1);
  st.agg.get(key).messages += 1;
  if (id) {
    st.ids.delete(id);
    st.ids.set(id, { key, u });
    if (st.ids.size > MAX_IDS) st.ids.delete(st.ids.keys().next().value);
  }
}

function consume(st, data) {
  if (st.skipping) { // inside an oversized line: drop bytes up to its newline
    const i = data.indexOf(10);
    if (i < 0) return;
    st.skipping = false;
    data = data.subarray(i + 1);
  }
  const buf = st.carry.length ? Buffer.concat([st.carry, data]) : data;
  const nl = buf.lastIndexOf(10);
  if (nl < 0) {
    if (buf.length > MAX_CARRY) { st.carry = Buffer.alloc(0); st.skipping = true; } else st.carry = Buffer.from(buf);
    return;
  }
  for (const line of buf.subarray(0, nl).toString('utf8').split('\n')) if (line) consumeLine(st, line);
  st.carry = Buffer.from(buf.subarray(nl + 1));
}

// deps: { reader, now (ms), minIntervalMs }
function createTokens({ reader, now = () => Date.now(), minIntervalMs = 2000, log = () => {} } = {}) {
  const files = new Map(); // transcript path -> state
  let lastRefresh = -Infinity;
  let inflight = null;

  async function sync(file) {
    let st = files.get(file.path);
    if (!st) {
      if (files.size >= MAX_FILES) {
        let oldest = null;
        for (const [p, s] of files) if (!oldest || s.lastSeen < files.get(oldest).lastSeen) oldest = p;
        files.delete(oldest);
      }
      st = newState(null);
      files.set(file.path, st);
    }
    st.meta = { conv: file.conv, project: file.project, agent: file.agent, agent_type: file.agent_type ?? null };
    st.lastSeen = now();
    let budget = MAX_BYTES_PER_SYNC;
    try {
      for (let rounds = 0; budget > 0 && rounds < 64; rounds++) {
        const res = await reader.read(file.path, st.offset, MAX_CHUNK);
        if (st.inode !== null && (res.inode !== st.inode || res.size < st.offset)) {
          resetState(st); // rewritten or truncated: start over from byte 0
          st.inode = res.inode;
          continue;
        }
        st.inode = res.inode;
        if (res.data.length) { consume(st, res.data); st.offset += res.data.length; budget -= res.data.length; }
        if (st.offset >= res.size || !res.data.length) break;
      }
      st.error = null;
      st.synced = true;
    } catch (e) {
      st.error = e.code || 'error';
      if (e.code !== 'unavailable') log('tokens:', file.conv, e.code || e.message);
    }
  }

  // files: [{ path, conv, project, agent ('main' or a subagent id), agent_type }]. Throttled:
  // within minIntervalMs of the last refresh the cached totals are used as they are.
  function refresh(list) {
    if (inflight) return inflight;
    if (now() - lastRefresh < minIntervalMs) return Promise.resolve();
    lastRefresh = now();
    inflight = (async () => {
      const todo = list.slice(0, MAX_FILES);
      for (let i = 0; i < todo.length; i += 8) await Promise.all(todo.slice(i, i + 8).map(sync));
    })().finally(() => { inflight = null; lastRefresh = now(); });
    return inflight;
  }

  const costOf = (model, e) => {
    const p = priceOf(model);
    if (!p) return null;
    return (e.input * p.input + e.output * p.output + e.cache_creation * p.cache_creation + e.cache_read * p.cache_read) / 1e6;
  };

  // Calls fn(entryTotals, st, bucket, model) for every aggregate that passes `keep`.
  function each(keep, fn) {
    for (const st of files.values()) {
      if (!st.meta || !keep(st.meta)) continue;
      for (const [key, e] of st.agg) {
        const bar = key.indexOf('|');
        fn(e, st, Number(key.slice(0, bar)), key.slice(bar + 1));
      }
    }
  }

  function add(row, e, model, unpriced) {
    for (const f of FIELDS) row[f] += e[f];
    row.messages += e.messages;
    const c = costOf(model, e);
    if (c === null) { if (e.input + e.output + e.cache_creation + e.cache_read) unpriced.add(model); } else row.cost_usd += c;
  }

  // Aggregate views, optionally for one conversation.
  function views({ conversation = null } = {}) {
    const unpriced = new Set();
    const total = zero();
    const win = new Map(); const proj = new Map(); const conv = new Map(); const mod = new Map(); const agent = new Map();
    const row = (m, k, init = {}) => { if (!m.has(k)) m.set(k, { ...init, ...zero() }); return m.get(k); };
    each((m) => !conversation || m.conv === conversation, (e, st, bucket, model) => {
      const m = st.meta;
      add(total, e, model, unpriced);
      const start = Math.floor(bucket / WINDOW) * WINDOW;
      add(row(win, start, { start, end: start + WINDOW }), e, model, unpriced);
      add(row(proj, m.project, { project: m.project }), e, model, unpriced);
      add(row(conv, m.conv, { conversation: m.conv, project: m.project }), e, model, unpriced);
      add(row(mod, model, { model }), e, model, unpriced);
      add(row(agent, `${m.conv}|${m.agent}`, { conversation: m.conv, agent: m.agent, agent_type: m.agent_type }), e, model, unpriced);
    });
    const round = (r) => ({ ...r, cost_usd: Math.round(r.cost_usd * 10000) / 10000 });
    const list = (m, sort) => [...m.values()].map(round).sort(sort);
    const states = [...files.values()];
    return {
      price_note: PRICE_NOTE,
      window_seconds: WINDOW,
      conversation,
      total: round(total),
      by_window: list(win, (a, b) => b.start - a.start).slice(0, 48),
      by_project: list(proj, (a, b) => b.output - a.output),
      by_conversation: list(conv, (a, b) => b.output - a.output),
      by_model: list(mod, (a, b) => b.output - a.output),
      by_agent: list(agent, (a, b) => b.output - a.output),
      unpriced_models: [...unpriced].sort(),
      reader: {
        files: states.length, synced: states.filter((s) => s.synced).length,
        unavailable: states.length > 0 && states.every((s) => s.error === 'unavailable'),
      },
    };
  }

  // Totals for one conversation (all its transcripts) or one subagent; null if never read.
  function forNode(conv, agent = null) {
    const t = zero();
    const unpriced = new Set();
    let seen = false;
    for (const st of files.values()) if (st.synced && st.meta?.conv === conv && (!agent || st.meta.agent === agent)) seen = true;
    if (!seen) return null;
    each((m) => m.conv === conv && (!agent || m.agent === agent), (e, st, b, model) => add(t, e, model, unpriced));
    t.cost_usd = Math.round(t.cost_usd * 10000) / 10000;
    return t;
  }

  // The model a conversation (agent 'main') or subagent last used, or null.
  function modelOf(conv, agent = 'main') {
    for (const st of files.values()) if (st.meta?.conv === conv && st.meta.agent === agent) return st.model;
    return null;
  }

  return {
    refresh, views, forNode, modelOf, _files: files,
  };
}

// ---- transcript tail for the read-only panel ----

const VIEW_MAX_BYTES = 256 * 1024;
const VIEW_MAX_ENTRIES = 200;
const VIEW_TAIL_BYTES = 128 * 1024;
const TEXT_MAX = 2000;
const flat = (s) => String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]+/g, ' ');
const clip = (s) => { const t = flat(s); return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX)}…` : t; };

function entryOf(line) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== 'object' || (o.type !== 'user' && o.type !== 'assistant')) return null;
  const msg = o.message && typeof o.message === 'object' ? o.message : {};
  const parts = [];
  const c = msg.content;
  if (typeof c === 'string') parts.push({ kind: 'text', text: clip(c) });
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') parts.push({ kind: 'text', text: clip(b.text) });
      else if (b.type === 'thinking' && typeof b.thinking === 'string') parts.push({ kind: 'thinking', text: clip(b.thinking) });
      else if (b.type === 'tool_use') parts.push({ kind: 'tool_use', name: cleanStr(b.name), text: clip(JSON.stringify(b.input ?? {})) });
      else if (b.type === 'tool_result') {
        const t = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join(' ') : '';
        parts.push({ kind: 'tool_result', text: clip(t) });
      }
    }
  }
  if (!parts.length) return null;
  return { role: o.type, ts: Number.isFinite(Date.parse(o.timestamp)) ? Math.floor(Date.parse(o.timestamp) / 1000) : null, model: cleanStr(msg.model), parts };
}

// Bounded, read-only view of one transcript. Without `offset` it is the tail (about the last
// 128 KB); with it, the complete lines from there on (at most 256 KB). The caller polls with
// next_offset. A file that shrank or an offset past its end restarts at the tail (reset:true).
async function readTranscript(reader, file, { offset = null } = {}) {
  let res;
  let reset = false;
  if (offset === null) {
    res = await reader.tail(file, VIEW_TAIL_BYTES);
  } else {
    res = await reader.read(file, offset, VIEW_MAX_BYTES);
    if (offset > res.size) { reset = true; res = await reader.tail(file, VIEW_TAIL_BYTES); }
  }
  let data = res.data;
  let start = res.offset;
  let skipped = false;
  if (offset === null || reset) { // a tail starts mid-line unless it begins at byte 0
    if (start > 0) {
      const nl = data.indexOf(10);
      if (nl < 0) { start += data.length; data = data.subarray(data.length); skipped = true; } // one oversized line: skip it
      else { data = data.subarray(nl + 1); start += nl + 1; }
    }
  }
  const nl = data.lastIndexOf(10);
  const complete = nl < 0 ? data.subarray(0, 0) : data.subarray(0, nl + 1);
  // A full window with no newline, short of the end of the file, is one oversized line: skip past
  // it instead of stalling on it.
  if (!skipped && nl < 0 && data.length >= VIEW_MAX_BYTES && start + data.length < res.size) {
    start += data.length; skipped = true;
  }
  const entries = [];
  for (const line of complete.toString('utf8').split('\n')) {
    if (!line) continue;
    const e = entryOf(line);
    if (e) entries.push(e);
  }
  return {
    size: res.size, inode: res.inode, offset: start, next_offset: start + complete.length, reset,
    truncated: skipped || entries.length > VIEW_MAX_ENTRIES,
    entries: entries.slice(-VIEW_MAX_ENTRIES),
  };
}

// Transcript files to track, from the tree's conversations and the state snapshot.
// convs: [{ sid, project, subs: [{ agent_id, agent_type, transcript }] }]; records: Map sid -> { transcript, project }.
function transcriptFiles(convs, records) {
  const out = [];
  for (const c of convs) {
    const rec = records?.get(c.sid);
    const main = rec?.transcript;
    const project = c.project || rec?.project || '(unknown)';
    if (main) out.push({ path: main, conv: c.sid, project, agent: 'main', agent_type: null });
    for (const s of c.subs) {
      const p = s.transcript || (main ? subagentPath(main, c.sid, s.agent_id) : null);
      if (p) out.push({ path: p, conv: c.sid, project, agent: s.agent_id, agent_type: s.agent_type });
    }
  }
  return out;
}

// <dir>/<sid>.jsonl -> <dir>/<sid>/subagents/agent-<id>.jsonl (Claude Code 2.1.x layout)
function subagentPath(main, sid, agentId) {
  if (typeof main !== 'string' || !main.endsWith('.jsonl') || !/^[A-Za-z0-9_.:-]{1,100}$/.test(agentId)) return null;
  return path.join(path.dirname(main), sid, 'subagents', `agent-${agentId.replace(/^agent-/, '')}.jsonl`);
}

module.exports = { createTokens, readTranscript, transcriptFiles, subagentPath, PRICE_NOTE };
