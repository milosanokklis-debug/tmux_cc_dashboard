'use strict';
// Phase B end to end: the real tmux, ccd-session, hooks/state.sh and tests/fake-claude, with the
// real reconciler. Only the paths and the timings are overridden (see stack()).
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { SESSION, haveTmux, sleep, stack } = require('./stack');

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

    s.send('p1', '/perm'); // the PermissionRequest hook marks needs_approval, then (no broker) the dialog shows
    await s.status('p1', 'needs_approval');
    s.send('p1', 'y');
    await s.status('p1', 'waiting');

    s.send('p1', 'run /tool /perm'); // tool call, then blocked
    await s.status('p1', 'needs_approval');
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
