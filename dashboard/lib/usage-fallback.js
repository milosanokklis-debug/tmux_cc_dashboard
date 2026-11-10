'use strict';
// Fallback for when no statusline payload carries rate_limits: ask a hidden Claude for /usage.
// OFF by default. It is switched on by CCDASH_USAGE_FALLBACK=1 or by the flag file
// ~/.ccdash/usage-fallback.enabled (ccd doctor --live writes it when rate_limits is missing).
// A helper Claude is started in a window of the hidden _ops session with CCDASH_HIDDEN=1 (so the
// hooks record nothing), /usage is typed in, the pane is captured, /exit ends it. At most one run
// per interval (10 min).
const fs = require('node:fs');
const { setTimeout: sleep } = require('node:timers/promises');

const CONFIG_ROOT = '/home/ccd/.claude-projects'; // <root>/<project> is that project's CLAUDE_CONFIG_DIR
const DEFAULT_FLAG = '/home/ccd/.ccdash/usage-fallback.enabled';
const SECTIONS = [
  ['five_hour', /current session|5.?hour/i],
  ['seven_day', /current week/i],
];

// Text of a captured /usage screen -> { five_hour:{used_percentage,resets_text}, seven_day:{...} }.
// The first percentage under a heading is that window's; a "week" section that names only one
// model (Sonnet, Opus) is not the all-models figure and is skipped.
function parseUsage(text) {
  const limits = {};
  let cur = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
    const head = SECTIONS.find(([, re]) => re.test(line));
    if (head) {
      cur = head[0] === 'seven_day' && /sonnet|opus|haiku/i.test(line) && !/all models/i.test(line) ? null : head[0];
    }
    if (!cur) continue;
    const pct = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(line);
    if (pct && !limits[cur]) limits[cur] = { used_percentage: Number(pct[1]), resets_text: null };
    const reset = /resets?\s+(.{1,60})/i.exec(line);
    if (reset && limits[cur] && !limits[cur].resets_text) limits[cur].resets_text = reset[1].trim();
  }
  for (const k of Object.keys(limits)) if (!(limits[k].used_percentage <= 100)) delete limits[k];
  return limits;
}

// The input prompt: a line that starts with the prompt marker. A numbered menu ("> 1. Yes") or
// any dialog mentioning trust is not it.
const isReady = (screen) => !/trust/i.test(screen) && /^\s*[│|]?\s*(>|❯)\s*(?![0-9]+\.)/m.test(screen);

// deps: { projects () => names (none given: refresh() starts no run; claude never runs without a project config dir), signedIn (name) => bool, configRoot, tmux ({run, ensureOps}), now (ms), wait (ms), intervalMs, flagFile, env, log }
function createUsageFallback({
  tmux, now = () => Date.now(), wait = sleep, env = process.env, log = console.error,
  intervalMs = 600 * 1000,
  projects = null, signedIn = async () => true, configRoot = CONFIG_ROOT,
  flagFile = DEFAULT_FLAG, readyPolls = 40, pollMs = 500,
} = {}) {
  let last = null; // { ts (s), limits }
  let lastRun = -Infinity;
  let running = null;
  let swept = false;

  // Windows left behind in _ops by an earlier run that died: kill the ones running claude.
  async function sweep() {
    try {
      const out = await tmux.run(['list-windows', '-t', '=_ops:', '-F', '#{window_id} #{window_name}']);
      for (const line of String(out ?? '').split('\n')) {
        const m = /^(@[0-9]+) ccdash-usage$/.exec(line.trim());
        if (m) await tmux.run(['kill-window', '-t', m[1]]);
      }
    } catch { /* no _ops yet */ }
  }

  const enabled = () => {
    if (env.CCDASH_USAGE_FALLBACK === '1') return true;
    try { return fs.lstatSync(flagFile).isFile(); } catch { return false; }
  };

  async function once(project) {
    await tmux.ensureOps();
    if (!swept) { swept = true; await sweep(); }
    const out = await tmux.run(['new-window', '-d', '-P', '-F', '#{window_id}', '-t', '=_ops:',
      '-n', 'ccdash-usage', '-e', 'CCDASH_HIDDEN=1', '-e', `CLAUDE_CONFIG_DIR=${configRoot}/${project}`, '-c', '/workspace', '--', 'claude']);
    const win = String(out ?? '').trim();
    if (!/^@[0-9]+$/.test(win)) throw new Error('no window');
    try {
      let screen = '';
      for (let i = 0; i < readyPolls && !isReady(screen); i++) { // wait for the prompt
        await wait(pollMs);
        screen = await tmux.run(['capture-pane', '-p', '-t', win]);
        if (/trust|onboarding|welcome|theme/i.test(screen)) throw new Error('claude shows a dialog'); // never answer one
      }
      if (!isReady(screen)) throw new Error('claude not ready');
      await tmux.run(['send-keys', '-t', win, '-l', '/usage']);
      await tmux.run(['send-keys', '-t', win, 'Enter']);
      let limits = {};
      for (let i = 0; i < readyPolls && !Object.keys(limits).length; i++) {
        await wait(pollMs);
        limits = parseUsage(await tmux.run(['capture-pane', '-p', '-t', win]));
      }
      try {
        await tmux.run(['send-keys', '-t', win, 'Escape']);
        await tmux.run(['send-keys', '-t', win, '-l', '/exit']);
        await tmux.run(['send-keys', '-t', win, 'Enter']);
      } catch { /* killed below */ }
      return limits;
    } finally {
      try { await tmux.run(['kill-window', '-t', win]); } catch { /* already gone */ }
    }
  }

  // Starts a run when enabled, a projects option is given, none is in progress and the interval
  // has passed. Returns the promise of the run (or null when nothing was started); callers need not await it.
  function refresh() {
    if (!projects || !enabled() || running || now() - lastRun < intervalMs) return running;
    lastRun = now();
    running = (async () => {
      for (const p of projects()) { // one run per signed-in project; a signed-out one is skipped
        if (!(await signedIn(p).catch(() => false))) continue;
        try {
          const limits = await once(p);
          if (Object.keys(limits).length) last = { ts: Math.floor(now() / 1000), limits };
        } catch (e) { log('usage fallback:', e.message); }
      }
    })().catch((e) => log('usage fallback:', e.message)).finally(() => { running = null; });
    return running;
  }

  return { enabled, refresh, latest: () => last, parseUsage };
}

module.exports = { createUsageFallback, parseUsage };
