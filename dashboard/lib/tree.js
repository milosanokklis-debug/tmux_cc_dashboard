'use strict';
// Folds the hook event files written by hooks/agents.sh into project -> conversation ->
// subagent. Every field comes from Claude (or things Claude can influence), so each one is
// type-checked, stripped of control characters and length-limited.
const fs = require('node:fs');
const path = require('node:path');
const { hasClaude } = require('./tmux');
const { readRegular } = require('./safefile');

const DAY = 24 * 3600 * 1000;
const MAX_FIELD = 200;
const MAX_TASK = 80;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 512 * 1024;
const HEAD_BYTES = 16 * 1024; // first events (project, win) of a file that is read from its tail
const MAX_SUBAGENTS = 200;
const TRANSCRIPT_BYTES = 64 * 1024;

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

function clean(v, max = MAX_FIELD) {
  if (typeof v !== 'string') return null;
  const s = v.replace(CONTROL, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
  return s || null;
}

// Hook timestamp -> epoch milliseconds. agents.sh writes ISO-8601 today; epoch seconds
// (number or digit string, e.g. `date +%s`) are accepted too.
function parseTs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v * 1000 : NaN;
  if (typeof v !== 'string') return NaN;
  return /^\d{1,12}$/.test(v) ? Number(v) * 1000 : Date.parse(v);
}
const sec = (ms) => (ms == null ? null : Math.floor(ms / 1000)); // API timestamps are unix seconds

const idOf = (v) => (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(v) ? v : null);

function projectOf(p) {
  const s = clean(p, 1000);
  if (!s) return null;
  const m = /^\/workspace\/([^/]+)/.exec(s);
  return clean(m ? m[1] : path.basename(s.replace(/\/+$/, '')));
}

const MAX_EVENTS = 5000; // per file: keeps the cache small even for a file of 512 KB of tiny lines
const MAX_MSG_CACHE = 1000;
const msgCache = new Map(); // real path -> { key: "mtime:size", text }

// The agents/transcript directories are ccd-writable: a symlink in their place is refused.
function isRealDir(dir) {
  try { return fs.lstatSync(dir).isDirectory(); } catch { return false; }
}

// First user message of a subagent transcript (JSONL), or null on any problem. Only files
// under `root` are read, because the path comes from a hook payload. Cached by (path, mtime, size).
function firstUserMessage(file, root) {
  try {
    if (typeof file !== 'string' || !file.endsWith('.jsonl')) return null;
    if (!isRealDir(root)) return null;
    const real = fs.realpathSync(file);
    const base = fs.realpathSync(root);
    if (!real.startsWith(base + path.sep)) return null;
    const st = fs.statSync(real); // stat never blocks, even on a FIFO; readRegular rejects those below
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = msgCache.get(real);
    if (hit && hit.key === key) return hit.text;
    const text = readFirstUser(real);
    msgCache.delete(real);
    msgCache.set(real, { key, text });
    if (msgCache.size > MAX_MSG_CACHE) msgCache.delete(msgCache.keys().next().value);
    return text;
  } catch { /* unreadable or odd: no task */ }
  return null;
}

function readFirstUser(real) {
  const head = readRegular(real, TRANSCRIPT_BYTES); // opened by its real path: no symlink, no FIFO
  if (!head) return null;
  for (const line of head.buf.toString('utf8').split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const msg = o && typeof o === 'object' ? o.message : null;
    if (!(o && (o.type === 'user' || (msg && msg.role === 'user')))) continue;
    const c = msg && typeof msg === 'object' ? msg.content : o.content;
    const text = typeof c === 'string' ? c
      : Array.isArray(c) ? c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join(' ') : '';
    const t = clean(text, 4000);
    if (t) return t.slice(0, MAX_TASK);
  }
  return null;
}

// Only what fold() uses, cleaned and capped, so the cache never holds a whole 512 KB line.
function compact(e) {
  const sid = idOf(e.sid);
  const ts = parseTs(e.ts);
  if (!sid || Number.isNaN(ts) || !['session', 'start', 'stop', 'end'].includes(e.ev)) return null;
  const tr = typeof e.agent_transcript === 'string' && e.agent_transcript.length <= 1000 ? e.agent_transcript : null;
  return {
    sid, ts, ev: e.ev,
    project: projectOf(e.project),
    win: clean(e.win),
    pane: typeof e.pane === 'string' && /^%[0-9]+$/.test(e.pane) ? e.pane : null,
    agent_id: idOf(e.agent_id),
    agent_type: clean(e.agent_type),
    agent_transcript: tr,
    description: clean(e.description, MAX_TASK),
  };
}

// Events of one file. A file over MAX_FILE_BYTES is read from its tail (so late stop/end
// events are not lost) plus its first HEAD_BYTES (project, win); partial lines are dropped.
// One fstat (inside readRegular) decides whole-vs-tail; the tail is read one byte early to
// see whether it starts on a line boundary, and bytes already taken from the head are skipped.
function parseFile(full) {
  const tail = readRegular(full, MAX_FILE_BYTES + 1, { tail: true });
  if (!tail) return null;
  const parts = [];
  if (tail.size <= MAX_FILE_BYTES) {
    parts.push(tail.buf);
  } else {
    let headEnd = 0;
    const head = readRegular(full, HEAD_BYTES);
    if (head) {
      headEnd = head.buf.lastIndexOf(10) + 1; // whole lines only
      parts.push(head.buf.subarray(0, headEnd));
    }
    const tailStart = tail.size - tail.buf.length;
    if (tailStart <= headEnd) {
      parts.push(tail.buf.subarray(headEnd - tailStart)); // overlap: the head already has these lines
    } else if (tail.buf[0] === 10) {
      parts.push(tail.buf.subarray(1)); // began exactly on a line boundary
    } else {
      const nl = tail.buf.indexOf(10); // drop the partial first line
      if (nl >= 0) parts.push(tail.buf.subarray(nl + 1));
    }
  }
  let events = [];
  for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object') continue;
    const c = compact(e);
    if (c) events.push(c);
  }
  if (events.length > MAX_EVENTS) events = [...events.slice(0, 500), ...events.slice(-(MAX_EVENTS - 500))];
  return events;
}

const parsed = new Map(); // path -> { key: "mtime:size", events }; pruned to the listed files each call

// Parse the newest MAX_FILES regular *.jsonl files, grouped by sid in file order. The
// directory is writable by ccd, so entries are lstat'ed and only regular files are opened.
function loadConversations(agentsDir) {
  if (!isRealDir(agentsDir)) { parsed.clear(); return new Map(); }
  let names;
  try { names = fs.readdirSync(agentsDir); } catch { return new Map(); }
  const files = [];
  for (const f of names) {
    if (!f.endsWith('.jsonl')) continue;
    const full = path.join(agentsDir, f);
    try {
      const st = fs.lstatSync(full);
      if (st.isFile()) files.push({ full, mtime: st.mtimeMs, size: st.size });
    } catch { /* vanished */ }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  files.length = Math.min(files.length, MAX_FILES);
  const convs = new Map();
  const seen = new Set();
  for (const { full, mtime, size } of files) {
    seen.add(full);
    const key = `${mtime}:${size}`;
    let entry = parsed.get(full);
    if (!entry || entry.key !== key) {
      const events = parseFile(full);
      if (!events) { parsed.delete(full); continue; }
      entry = { key, events };
      parsed.set(full, entry);
    }
    for (const e of entry.events) {
      if (!convs.has(e.sid)) convs.set(e.sid, []);
      convs.get(e.sid).push(e);
    }
  }
  for (const f of parsed.keys()) if (!seen.has(f)) parsed.delete(f);
  return convs;
}

function fold(sid, events, env) {
  const c = {
    sid, project: null, win: null, pane: null, startedTs: events[0].ts, endedTs: null, lastTs: 0, lastLife: null,
    subs: new Map(),
  };
  for (const e of events) {
    c.lastTs = Math.max(c.lastTs, e.ts);
    c.startedTs = Math.min(c.startedTs, e.ts);
    c.project = c.project || e.project;
    c.win = c.win || e.win;
    c.pane = c.pane || e.pane;
    if (e.ev === 'session' || e.ev === 'end') {
      c.lastLife = e.ev;
      if (e.ev === 'end') c.endedTs = e.ts; else c.endedTs = null;
    }
    const aid = e.agent_id;
    if (!aid || (e.ev !== 'start' && e.ev !== 'stop')) continue;
    let s = c.subs.get(aid);
    if (!s && c.subs.size >= MAX_SUBAGENTS) continue;
    if (!s) {
      s = { agent_id: aid, agent_type: null, task: null, status: 'running', startTs: e.ts, endTs: null, transcript: null };
      c.subs.set(aid, s);
    }
    s.agent_type = s.agent_type || e.agent_type;
    s.transcript = s.transcript || e.agent_transcript;
    s.task = s.task || e.description;
    if (e.ev === 'stop') { s.status = 'done'; s.endTs = e.ts; }
  }
  const ended = c.lastLife === 'end';
  let status = 'gone';
  if (ended) status = 'ended';
  else if (c.pane) {
    const sessionOf = c.win ? c.win.split(':')[0] : null;
    const pane = env.panes.find((p) => p.paneId === c.pane && (!sessionOf || p.session === sessionOf));
    if (pane && hasClaude(env.table, pane.panePid)) status = 'running';
  }
  return { c, status };
}

const LIVE = new Set(['running', 'working', 'needs_approval', 'waiting', 'error']);

// deps: { agentsDir, transcriptRoot, panes, table, now, states }. `states` is the reconciler's
// snapshot (Map sid -> derived status): a conversation it knows takes its status from there and a
// conversation it hides (already woken) is left out. Without a record the status comes from
// the agent events and a /proc check, as before state.sh existed.
function buildTree({ agentsDir, transcriptRoot, panes, table, now = Date.now(), all = false, states = null }) {
  const byProject = new Map();
  for (const [sid, events] of loadConversations(agentsDir)) {
    const folded = fold(sid, events, { panes, table });
    const c = folded.c;
    const st = states?.get(sid) ?? null;
    if (st?.hidden) continue;
    const status = st ? st.status : folded.status;
    if (!all && !LIVE.has(status) && c.lastTs < now - DAY) continue;
    const project = c.project || '(unknown)';
    const subagents = [...c.subs.values()].sort((a, b) => a.startTs - b.startTs).map((s) => {
      const open = s.status === 'running' && !LIVE.has(status);
      return {
        agent_id: s.agent_id,
        agent_type: s.agent_type,
        task: s.task || (s.transcript ? firstUserMessage(s.transcript, transcriptRoot) : null),
        // a subagent cannot still run in a conversation that ended or vanished
        status: open ? 'done' : s.status,
        startTs: sec(s.startTs),
        endTs: sec(open ? (c.endedTs ?? c.lastTs) : s.endTs),
      };
    });
    if (!byProject.has(project)) byProject.set(project, []);
    byProject.get(project).push({
      sid, win: c.win, status, startedTs: sec(c.startedTs), endedTs: status === 'ended' ? sec(c.endedTs) : null, subagents,
      ...(st ? { idle: st.idle, quiet: st.quiet, outsideTmux: st.outsideTmux, wakeable: st.status === 'sleeping' || st.status === 'ended', canPrompt: st.status === 'waiting' } : {}),
    });
  }
  return [...byProject.keys()].sort().map((project) => ({
    project,
    conversations: byProject.get(project).sort((a, b) => b.startedTs - a.startedTs),
  }));
}

module.exports = { buildTree, _parsed: parsed };
