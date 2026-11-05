'use strict';
// Phase B end to end: the real tmux, ccd-session, hooks/state.sh and tests/fake-claude, with the
// real reconciler. Only the paths and the timings are overridden (see stack()).
const test = require('node:test');
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

function stack() {
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
    ...process.env, HOME: home, CCDASH_WS: ws, CCDASH_TMUX: sock, CCDASH_STATE: stateDir,
    FAKE_CLAUDE_SETTINGS: settings, FAKE_CLAUDE_FIXTURES: path.join(ROOT, 'tests/fixtures/2.1.317'),
    FAKE_CLAUDE_HOME: path.join(tmp, 'fake'), FAKE_CLAUDE_TIMEOUT: '5',
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

test('Phase B: status, liveness and wake against the fake claude', { skip: !haveTmux && 'needs tmux and jq' }, async (t) => {
  const s = stack();
  t.after(() => s.cleanup());

  await t.test('prompt, tool call, permission prompt, finish and Esc interrupt give the right status', async () => {
    s.project('p1');
    s.project('p2');
    s.ccd('start', 'p1');
    s.ccd('start', 'p2'); // stays waiting: checked for the idle flag below
    await s.status('p1', 'waiting');
    await s.status('p2', 'waiting');
    assert.strictEqual(s.cur('p1').outsideTmux, false);

    s.send('p1', '/perm'); // a prompt Claude is busy with (blocked on the dialog)
    await s.status('p1', 'working');
    s.send('p1', 'y');
    await s.status('p1', 'waiting');

    s.send('p1', 'run /tool /perm'); // tool call, then blocked
    await s.status('p1', 'working');
    s.send('p1', 'y');
    await s.status('p1', 'waiting');

    s.send('p1', '/notify perm /perm'); // permission prompt
    await s.status('p1', 'needs_approval');
    s.send('p1', 'y');
    await s.status('p1', 'waiting');

    s.send('p1', 'go /fail');
    await s.status('p1', 'error');

    s.send('p1', 'go /esc'); // Esc interrupt: no Stop hook, so the turn stays "working" and goes quiet
    const c = await s.status('p1', 'working');
    assert.strictEqual(c.quiet, false);
    await s.until(() => s.cur('p1').quiet, 'the quiet flag', 9000);

    await s.until(() => s.cur('p2').idle, 'the idle flag', 9000);
    assert.strictEqual(s.cur('p2').status, 'waiting');
    s.send('p2', '/exit');
    await s.status('p2', 'ended');
  });

  await t.test('kill -9 on Claude shows sleeping within 10 s', async () => {
    s.project('p3');
    s.ccd('start', 'p3');
    await s.status('p3', 'waiting');
    process.kill(s.claudePid('p3'), 'SIGKILL');
    await s.status('p3', 'sleeping', 10000);
  });

  async function wakeCheck(name, killer) {
    s.project(name);
    s.ccd('start', name);
    await s.status(name, 'waiting');
    s.send(name, 'first question');
    await s.until(() => s.cur(name).status === 'waiting' && fs.existsSync(path.join(s.env.FAKE_CLAUDE_HOME, 'history')), 'first answer');
    s.send(name, 'second question');
    await sleep(500);
    const old = s.cur(name);
    killer(old);
    await s.status(name, 'sleeping', 10000);
    const sid = s.records().find((r) => r.project === path.join(s.ws, name)).sid;
    assert.strictEqual(old.sid, sid);

    const session = s.ccd('wake', sid);
    assert.strictEqual(session, `claude-${name}`);
    const woken = await s.until(() => { const c = s.cur(name); return c && c.sid !== sid && c.status === 'waiting' ? c : null; }, 'the woken conversation');
    assert.strictEqual(woken.resumedFrom, sid);
    assert.match(fs.readFileSync(path.join(s.env.FAKE_CLAUDE_HOME, 'args.log'), 'utf8'), new RegExp(`^--resume ${sid}$`, 'm'));
    // the old record is replaced: exactly one visible conversation for the project
    const mine = new Set(s.records().filter((r) => r.project === path.join(s.ws, name)).map((r) => r.sid));
    const visible = [...s.rec.snapshot().values()].filter((c) => mine.has(c.sid) && !c.hidden);
    assert.deepStrictEqual(visible.map((c) => c.sid), [woken.sid]);
    assert.strictEqual(s.rec.get(sid).hidden, true);
    // full history is back in the new conversation
    const screen = s.t('capture-pane', '-p', '-t', woken.pane);
    assert.match(screen, /history: first question/);
    assert.match(screen, /history: second question/);
    assert.strictEqual(s.t('show-options', '-qv', '-t', `=claude-${name}:`, '@project_dir').trim(), path.join(s.ws, name));
    return { sid, woken };
  }

  await t.test('wake when the project tmux session still exists (new window)', async () => {
    await wakeCheck('p4', () => process.kill(s.claudePid('p4'), 'SIGKILL'));
    assert.strictEqual(s.t('list-windows', '-t', '=claude-p4', '-F', 'x').trim().split('\n').length, 2);
    // CCDASH_RESUMED_FROM is for the woken claude only: not in the session environment, so a later window never inherits it
    assert.doesNotMatch(s.t('show-environment', '-t', '=claude-p4'), /CCDASH_RESUMED_FROM/);
    s.t('new-window', '-t', '=claude-p4:', '-d', 'sleep 1');
    assert.doesNotMatch(s.t('show-environment', '-t', '=claude-p4'), /CCDASH_RESUMED_FROM/);
  });

  await t.test('wake when the project tmux session is gone (new session)', async () => {
    await wakeCheck('p5', () => s.t('kill-session', '-t', '=claude-p5'));
    assert.strictEqual(s.t('list-windows', '-t', '=claude-p5', '-F', 'x').trim().split('\n').length, 1);
  });

  await t.test('wake refuses a bad id, an unknown conversation and a project outside the workspace', () => {
    const run = (...a) => spawnSync(SESSION, ['wake', ...a], { env: s.env, encoding: 'utf8' });
    assert.strictEqual(run('../etc/passwd').status, 2);
    assert.strictEqual(run('00000000-0000-4000-8000-000000000000').status, 1);
    const sid = '00000000-0000-4000-8000-0000000000aa';
    fs.writeFileSync(path.join(s.stateDir, `${sid}.json`), JSON.stringify({ sid, state: 'waiting', ts: 1, project: '/etc' }));
    const r = run(sid);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /not an existing directory under/);
    fs.writeFileSync(path.join(s.stateDir, `${sid}.json`), JSON.stringify({ sid, state: 'waiting', ts: 1, project: `${s.ws}/../etc` }));
    assert.strictEqual(run(sid).status, 1);
    fs.rmSync(path.join(s.stateDir, `${sid}.json`));
  });

  await t.test('a restarted tmux server shows every conversation sleeping', async () => {
    s.project('p6');
    s.ccd('start', 'p6');
    await s.status('p6', 'waiting');
    const live = [...s.rec.snapshot().values()].filter((c) => c.status === 'waiting');
    assert.ok(live.length >= 2, 'p4 and p5 woken conversations plus p6');
    s.t('kill-server');
    s.t('new-session', '-d', '-s', 'keep'); // what s6 does: a fresh server with a new pid
    await s.until(() => live.every((c) => s.rec.get(c.sid)?.status === 'sleeping'), 'every conversation sleeping', 10000);
  });
});
