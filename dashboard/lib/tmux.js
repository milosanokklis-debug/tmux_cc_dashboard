'use strict';
// tmux access (always execFile with an argv array, never a shell), the /proc process
// table, and the ccd-ops poller used for long jobs such as git clone.
const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readRegular } = require('./safefile');
const { setTimeout: sleep } = require('node:timers/promises');

const DENIED = /access not allowed/;

function runFile(file, args, { timeout = 15000, exec = execFile } = {}) {
  return new Promise((resolve, reject) => {
    exec(file, args, { timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error((stderr || '').trim() || err.message);
        e.code = err.code; e.stderr = stderr || ''; e.stdout = stdout || '';
        return reject(e);
      }
      resolve({ stdout, stderr });
    });
  });
}

// A tmux client denied by server-access prints "access not allowed" and still exits 0,
// so the output is checked as well as the exit status. Only stderr (or an output that is
// exactly the message) counts: stdout carries session/option/pane text that ccd controls.
function createTmux({ sock = process.env.CCDASH_TMUX || '/run/ccdash/tmux.sock', exec = execFile, spawnFn = spawn } = {}) {
  async function run(args) {
    const { stdout, stderr } = await runFile('tmux', ['-S', sock, ...args], { exec });
    if (DENIED.test(stderr) || stdout.trim() === 'access not allowed') throw new Error('tmux: access not allowed');
    return stdout;
  }

  // Like run, with `input` written to tmux's stdin (e.g. `load-buffer -b id -`). The input is never
  // part of an error message or a log line.
  function runInput(args, input) {
    return new Promise((resolve, reject) => {
      const child = spawnFn('tmux', ['-S', sock, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (d) => { if (stdout.length < 1024 * 1024) stdout += d; });
      child.stderr.setEncoding('utf8').on('data', (d) => { if (stderr.length < 64 * 1024) stderr += d; });
      child.stdin.on('error', () => { /* tmux exited early: the exit status reports it */ });
      child.on('error', (e) => reject(new Error(e.message)));
      child.on('close', (code) => {
        if (DENIED.test(stderr) || stdout.trim() === 'access not allowed') return reject(new Error('tmux: access not allowed'));
        if (code !== 0) return reject(new Error(stderr.trim() || `tmux exited ${code}`));
        resolve(stdout);
      });
      child.stdin.end(input);
    });
  }

  // [{ session, window, paneId, panePid, active, projectDir }] for every pane of every session.
  async function listPanes() {
    let out;
    try {
      out = await run(['list-panes', '-a', '-F',
        '#{session_name}\t#{window_index}\t#{pane_id}\t#{pane_pid}\t#{window_active}\t#{pane_active}\t#{@project_dir}']);
    } catch (e) {
      // Access denied and connect errors propagate. "error connecting to <sock> (No such file or
      // directory)" (server not started yet / socket gone) is deliberately not "no panes": the
      // caller turns it into 503 "tmux unavailable" instead of showing everything as gone.
      if (/no server running/.test(e.message)) return [];
      throw e;
    }
    const panes = [];
    for (const line of out.split('\n')) {
      const f = line.split('\t');
      if (f.length < 7) continue;
      panes.push({
        session: f[0], window: f[1], paneId: f[2], panePid: Number(f[3]),
        active: f[4] === '1' && f[5] === '1', projectDir: f[6],
      });
    }
    return panes;
  }

  async function ensureOps() {
    try { await run(['has-session', '-t', '=_ops']); return; } catch { /* create below */ }
    try { await run(['new-session', '-d', '-s', '_ops']); } catch (e) {
      if (!/duplicate session/.test(e.message)) throw e; // another request created it first
    }
  }

  return { sock, run, runInput, listPanes, ensureOps };
}

// Map pid -> { ppid, comm } read from /proc (the container does not mount it with hidepid).
function readProcTable(procDir = '/proc') {
  const table = new Map();
  let names;
  try { names = fs.readdirSync(procDir); } catch { return table; }
  for (const n of names) {
    if (!/^[0-9]+$/.test(n)) continue;
    try {
      const stat = fs.readFileSync(path.join(procDir, n, 'stat'), 'utf8');
      // "pid (comm) S ppid ...": comm may contain spaces and parentheses
      const open = stat.indexOf('(');
      const close = stat.lastIndexOf(')');
      if (open < 0 || close < open) continue;
      table.set(Number(n), { ppid: Number(stat.slice(close + 2).split(' ')[1]), comm: stat.slice(open + 1, close) });
    } catch { /* process vanished or unreadable */ }
  }
  return table;
}

// True when `rootPid` or one of its descendants is a process whose comm is `claude`.
function hasClaude(table, rootPid) {
  const kids = new Map();
  for (const [pid, p] of table) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(pid);
  }
  const seen = new Set();
  const todo = [rootPid];
  while (todo.length) {
    const pid = todo.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (table.get(pid)?.comm === 'claude') return true;
    todo.push(...(kids.get(pid) || []));
  }
  return false;
}

const LOG_TAIL = 4096;
const RC_BYTES = 16;

// Runs `argv` as user ccd in a window of the hidden _ops session via ccd-ops and waits
// for <dir>/<id>.rc. Resolves { rc, log } (the log's last ~4 KB); { timedOut: true, log }
// on timeout, after killing the window and removing the files. The files live in a
// directory ccd can write, so they are read through safefile (FIFOs, symlinks and huge
// files are not followed or read whole); an unreadable rc counts as "still running".
async function runOp({
  tmux, argv, dir = '/run/ccdash/ops',
  timeoutMs = 5 * 60 * 1000, intervalMs = 500, now = () => Date.now(), wait = sleep,
  id = crypto.randomBytes(8).toString('hex'),
}) {
  await tmux.ensureOps();
  const out = await tmux.run(['new-window', '-d', '-P', '-F', '#{window_id}', '-t', '=_ops:', '--', 'ccd-ops', id, ...argv]);
  const windowId = /^@[0-9]+$/.test(String(out ?? '').trim()) ? String(out).trim() : null;
  const rcFile = path.join(dir, `${id}.rc`);
  const logFile = path.join(dir, `${id}.log`);
  const readLog = () => readRegular(logFile, LOG_TAIL, { tail: true })?.buf.toString('utf8') ?? '';
  const cleanup = () => { for (const f of [rcFile, logFile]) { try { fs.unlinkSync(f); } catch { /* best effort */ } } };
  const deadline = now() + timeoutMs;
  for (;;) {
    const f = readRegular(rcFile, RC_BYTES);
    const rc = f && f.size <= RC_BYTES ? f.buf.toString('utf8').trim() : null;
    if (rc !== null && /^[0-9]+$/.test(rc)) {
      const log = readLog();
      cleanup();
      return { rc: Number(rc), log };
    }
    if (now() >= deadline) {
      const log = readLog();
      if (windowId) { try { await tmux.run(['kill-window', '-t', windowId]); } catch { /* already gone */ } }
      cleanup();
      return { timedOut: true, log };
    }
    await wait(intervalMs);
  }
}

const OPS_FILE = /^[0-9a-f]{16}\.(rc|log|rc\.tmp)$/;

// Removes leftovers of ccd-ops jobs (the web process crashed or restarted mid-job) older than
// maxAgeMs. Only regular files with the exact generated names; nothing is followed.
function sweepOps(dir = '/run/ccdash/ops', { maxAgeMs = 3600 * 1000, now = Date.now() } = {}) {
  let removed = 0;
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const n of names) {
    if (!OPS_FILE.test(n)) continue;
    const f = path.join(dir, n);
    try {
      const st = fs.lstatSync(f);
      if (!st.isFile() || now - st.mtimeMs < maxAgeMs) continue;
      fs.unlinkSync(f);
      removed++;
    } catch { /* vanished or not ours to delete */ }
  }
  return removed;
}

// Sweeps now and every `everyMs`; the timer does not keep the process alive.
function startOpsSweeper(dir = '/run/ccdash/ops', { everyMs = 10 * 60 * 1000, ...opts } = {}) {
  sweepOps(dir, opts);
  const timer = setInterval(() => sweepOps(dir, opts), everyMs);
  timer.unref();
  return timer;
}

module.exports = { runFile, createTmux, readProcTable, hasClaude, runOp, sweepOps, startOpsSweeper };
