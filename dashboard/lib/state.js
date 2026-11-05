'use strict';
// Conversation status: hooks/state.sh records facts per conversation in
// ~/.ccdash/sessions/<sid>.json; this reconciler derives the status the dashboard shows from
// those facts plus a live tmux check. It is read-only: derived status stays in memory and the
// state files (ccd-writable, so untrusted) are never written.
const fs = require('node:fs');
const path = require('node:path');
const { hasClaude, readProcTable } = require('./tmux');
const { readRegular } = require('./safefile');

const STATES = new Set(['working', 'needs_approval', 'waiting', 'error', 'ended']);
const SID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_FILES = 1000;
const MAX_BYTES = 64 * 1024;
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : null);

function clean(v, max) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim().slice(0, max) || null : null;
}

// One state file -> a validated record, or null. `name` is the sid taken from the file name.
function parseRecord(name, text) {
  let o;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== 'object' || o.sid !== name || !STATES.has(o.state)) return null;
  const ts = num(o.ts);
  if (ts === null) return null;
  const from = typeof o.resumed_from === 'string' && SID_RE.test(o.resumed_from) && o.resumed_from !== name ? o.resumed_from : null;
  return {
    sid: name, state: o.state, event: clean(o.event, 40), ts,
    project: clean(o.project, 1000),
    pane: typeof o.pane === 'string' && /^%[0-9]+$/.test(o.pane) ? o.pane : null,
    tmuxPid: Number.isInteger(o.tmux_pid) && o.tmux_pid > 0 ? o.tmux_pid : null,
    tmuxStart: Number.isInteger(o.tmux_start) && o.tmux_start > 0 ? o.tmux_start : null,
    waitingSince: num(o.waiting_since),
    resumedFrom: from,
  };
}

function readRecords(dir) {
  const out = new Map();
  try { if (!fs.lstatSync(dir).isDirectory()) return out; } catch { return out; }
  let names;
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const m = /^([A-Za-z0-9_-]{1,100})\.json$/.exec(n);
    if (!m || out.size >= MAX_FILES) continue;
    const f = readRegular(path.join(dir, n), MAX_BYTES);
    if (!f || f.size > MAX_BYTES) continue;
    const r = parseRecord(m[1], f.buf.toString('utf8'));
    if (r) out.set(r.sid, r);
  }
  return out;
}

// records: Map sid -> record. env: { panes, table, serverPid, now (ms), idleMs, quietMs }.
// Returns Map sid -> { sid, pane, status, idle, quiet, outsideTmux, hidden, resumedFrom }.
function derive(records, { panes, table, serverPid = null, serverStart = null, now, idleMs, quietMs }) {
  const replaced = new Set();
  for (const r of records.values()) if (r.resumedFrom) replaced.add(r.resumedFrom);
  const runsClaude = (paneId) => panes.some((p) => p.paneId === paneId && hasClaude(table, p.panePid));
  // A restarted tmux server may get the same pid and hands out the same pane ids again, so the
  // start time is compared too (records written before it existed only have the pid).
  const otherServer = (r) => (r.tmuxPid && serverPid && r.tmuxPid !== serverPid)
    || (r.tmuxStart && serverStart && r.tmuxStart !== serverStart);
  const out = new Map();
  for (const r of records.values()) {
    let status = r.state;
    let outsideTmux = false;
    if (r.state !== 'ended' && r.event !== 'SessionEnd') {
      if (!r.pane) outsideTmux = true; // no pane: nothing to check, keep the recorded status
      else if (otherServer(r) || !runsClaude(r.pane)) status = 'sleeping';
    }
    out.set(r.sid, {
      sid: r.sid, pane: r.pane, status, outsideTmux, project: r.project ? path.basename(r.project) : '(unknown)', resumedFrom: r.resumedFrom,
      hidden: replaced.has(r.sid),
      idle: status === 'waiting' && r.waitingSince !== null && now - r.waitingSince * 1000 >= idleMs,
      quiet: status === 'working' && now - r.ts * 1000 >= quietMs,
    });
  }
  return out;
}

// One conversation's state file, read the same safe way (no follow, regular file, size cap), or null.
function readRecord(dir, sid) {
  if (typeof sid !== 'string' || !SID_RE.test(sid)) return null;
  const f = readRegular(path.join(dir, `${sid}.json`), MAX_BYTES);
  return f && f.size <= MAX_BYTES ? parseRecord(sid, f.buf.toString('utf8')) : null;
}

const seconds = (v, dflt) => (/^[0-9]+$/.test(v ?? '') && Number(v) > 0 ? Number(v) : dflt);

// deps: { stateDir, tmux, procTable (function), now, idleSec, quietSec, intervalMs, log }
function createReconciler({
  stateDir = process.env.CCDASH_STATE_DIR || '/home/ccd/.ccdash/sessions',
  tmux, procTable = readProcTable, now = () => Date.now(),
  idleSec = seconds(process.env.CCDASH_IDLE_FLAG, 7200),
  quietSec = seconds(process.env.CCDASH_QUIET_AFTER, 900),
  intervalMs = seconds(process.env.CCDASH_RECONCILE_MS, 5000),
  log = console.error,
} = {}) {
  let snapshot = null; // null until the first successful pass
  let timer = null;
  let down = false;
  const listeners = [];

  async function tick() {
    let panes;
    let serverPid = null;
    let serverStart = null;
    try {
      panes = await tmux.listPanes();
      if (panes.length) {
        try {
          const m = /^([0-9]+) ([0-9]+)$/.exec((await tmux.run(['display-message', '-p', '#{pid} #{start_time}'])).trim());
          if (m) { serverPid = Number(m[1]); serverStart = Number(m[2]); }
        } catch { /* skip the server check */ }
      }
    } catch (e) {
      // tmux unreachable or access denied is not "everything is gone": keep the last answer
      if (!down) log('reconciler: tmux unavailable:', e.message);
      down = true;
      return snapshot;
    }
    down = false;
    const startedAt = now(); // state files read from here on; listeners may trust anything older was seen
    snapshot = derive(readRecords(stateDir), {
      panes, table: procTable(), serverPid, serverStart, now: now(), idleMs: idleSec * 1000, quietMs: quietSec * 1000,
    });
    for (const fn of listeners) { try { fn(snapshot, startedAt); } catch (e) { log('reconciler listener:', e.message); } }
    return snapshot;
  }

  return {
    tick,
    readOne: (sid) => readRecord(stateDir, sid),
    onTick: (fn) => { listeners.push(fn); },
    snapshot: () => snapshot,
    get: (sid) => snapshot?.get(sid) ?? null,
    start() {
      if (timer) return;
      tick().catch((e) => log('reconciler:', e.message));
      timer = setInterval(() => tick().catch((e) => log('reconciler:', e.message)), intervalMs);
      timer.unref();
    },
    stop() { clearInterval(timer); timer = null; },
  };
}

module.exports = { clean, createReconciler, derive, readRecords, readRecord, parseRecord };
