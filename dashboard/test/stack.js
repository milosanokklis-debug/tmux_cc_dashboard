'use strict';
// Shared real-tmux stack for the Phase B and C host tests: the real tmux, ccd-session, hooks/state.sh,
// tests/fake-claude and the real reconciler. Only the paths and the timings are overridden.
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createReconciler } = require('../lib/state');
const { createTmux, readProcTable, hasClaude } = require('../lib/tmux');

const ROOT = path.resolve(__dirname, '..', '..');
const SESSION = path.join(ROOT, 'rootfs/usr/local/bin/ccd-session');
const haveTmux = spawnSync('tmux', ['-V']).status === 0 && spawnSync('jq', ['--version']).status === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stack(extraEnv = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-b-'));
  const home = path.join(tmp, 'home');
  const ws = path.join(tmp, 'ws');
  const bin = path.join(tmp, 'bin');
  const sock = path.join(tmp, 'tmux.sock');
  for (const d of [home, ws, bin]) fs.mkdirSync(d);
  fs.symlinkSync(path.join(ROOT, 'tests/fake-claude/claude'), path.join(bin, 'claude'));
  // bash -l resets PATH from /etc/profile; ~/.bash_profile puts the fake claude back
  fs.writeFileSync(path.join(home, '.bash_profile'), `export PATH=${bin}:$PATH\n`);
  const settings = path.join(tmp, 'settings.json');
  fs.writeFileSync(settings, fs.readFileSync(path.join(ROOT, 'rootfs/etc/claude-code/managed-settings.json'), 'utf8')
    .replaceAll('/usr/local/lib/ccdash', path.join(ROOT, 'rootfs/usr/local/lib/ccdash')));
  const stateDir = path.join(home, '.ccdash', 'sessions');
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_CLAUDE_MCP: 'connected', HOME: home, CCDASH_WS: ws, CCDASH_TMUX: sock, CCDASH_STATE: stateDir,
    FAKE_CLAUDE_SETTINGS: settings, FAKE_CLAUDE_FIXTURES: path.join(ROOT, 'tests/fixtures/2.1.317'),
    FAKE_CLAUDE_HOME: path.join(tmp, 'fake'), FAKE_CLAUDE_TIMEOUT: '5',
    CCDASH_ACCOUNTS_LIB: path.join(ROOT, 'rootfs/usr/local/lib/ccdash'), CCDASH_ACCOUNTS_DIR: path.join(tmp, 'accounts'), ...extraEnv,
  };
  delete env.TMUX; delete env.TMUX_PANE;
  const tmux = createTmux({ sock });
  const t = (...a) => execFileSync('tmux', ['-S', sock, ...a], { env, encoding: 'utf8' });
  const rec = createReconciler({ stateDir, tmux, idleSec: 5, quietSec: 5, intervalMs: 200, log: () => {} });
  const s = {
    tmp, ws, env, stateDir, tmux, rec, t,
    ccd: (...a) => execFileSync(SESSION, a, { env, encoding: 'utf8' }).trim(),
    project(name) { fs.mkdirSync(path.join(ws, name)); return name; },
    records() {
      if (!fs.existsSync(stateDir)) return [];
      return fs.readdirSync(stateDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf8')));
    },
    // newest conversation of a project that has not been replaced by a wake
    cur(name) {
      const d = rec.snapshot() ?? new Map();
      const mine = s.records().filter((r) => r.project === path.join(ws, name)).sort((a, b) => b.ts - a.ts);
      return mine.map((r) => d.get(r.sid)).filter((c) => c && !c.hidden)[0] ?? null;
    },
    async until(fn, what, ms = 10000) {
      const end = Date.now() + ms;
      let last;
      while (Date.now() < end) { last = fn(); if (last) return last; await sleep(50); }
      assert.fail(`timed out waiting for ${what}`);
      return null;
    },
    async status(name, want, ms) { return s.until(() => { const c = s.cur(name); return c && c.status === want ? c : null; }, `${name} to be ${want} (now ${s.cur(name)?.status})`, ms); },
    send(name, text) {
      const pane = s.cur(name).pane ?? s.records().find((r) => r.project === path.join(ws, name)).pane;
      t('send-keys', '-t', pane, '-l', text);
      t('send-keys', '-t', pane, 'Enter');
    },
    claudePid(name) {
      const pane = s.records().filter((r) => r.project === path.join(ws, name)).sort((a, b) => b.ts - a.ts)[0].pane;
      const panePid = Number(t('display', '-p', '-t', pane, '#{pane_pid}'));
      const table = readProcTable();
      for (const [pid, p] of table) if (p.comm === 'claude' && hasClaude(table, panePid) && isDescendant(table, pid, panePid)) return pid;
      return null;
    },
    cleanup() { rec.stop(); try { t('kill-server'); } catch { /* none */ } fs.rmSync(tmp, { recursive: true, force: true }); },
  };
  rec.start();
  return s;
}

function isDescendant(table, pid, root) {
  for (let p = pid; p && table.has(p); p = table.get(p).ppid) if (p === root) return true;
  return false;
}

module.exports = { ROOT, SESSION, haveTmux, sleep, stack };
