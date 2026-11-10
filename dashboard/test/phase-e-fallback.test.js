'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUsageFallback, parseUsage } = require('../lib/usage-fallback');
const { gauges } = require('../lib/usage');

const SCREEN = `
 Settings:  Status   Config   Usage

 Current session
 ████████                          23% used
 Resets 3pm (UTC)

 Current week (all models)
 ████████████████                  41% used
 Resets Nov 9, 2pm (UTC)

 Current week (Sonnet only)
 ███                               9% used
 Resets Nov 9, 2pm (UTC)
`;

// A fake tmux that plays a hidden Claude: the prompt is shown at once, /usage prints SCREEN.
function fakeTmux({ screen = SCREEN, fail = false } = {}) {
  const calls = [];
  let typed = '';
  return {
    calls,
    ensureOps: async () => { calls.push(['ensureOps']); },
    run: async (argv) => {
      calls.push(argv);
      if (fail) throw new Error('boom');
      if (argv[0] === 'new-window') return '@7\n';
      if (argv[0] === 'send-keys' && argv.includes('-l')) typed = argv.at(-1);
      if (argv[0] === 'capture-pane') return typed === '/usage' ? screen : '> ';
      return '';
    },
  };
}
const mk = (over = {}) => {
  let t = 1_000_000;
  const tmux = over.tmux || fakeTmux();
  const fb = createUsageFallback({
    tmux, now: () => t, wait: async () => {}, env: over.env || {}, flagFile: over.flagFile || '/nonexistent/flag',
    log: () => {}, intervalMs: 600_000,
    projects: () => ['x'],
  });
  return { fb, tmux, advance: (ms) => { t += ms; } };
};

test('parseUsage takes session and all-models week, skips single-model sections', () => {
  const l = parseUsage(SCREEN);
  assert.equal(l.five_hour.used_percentage, 23);
  assert.equal(l.five_hour.resets_text, '3pm (UTC)');
  assert.equal(l.seven_day.used_percentage, 41);
  assert.equal(l.seven_day.resets_text, 'Nov 9, 2pm (UTC)');
  assert.deepEqual(parseUsage('nothing here'), {});
  assert.deepEqual(parseUsage('Current session\n 250% used'), {});
});

test('off by default: no tmux call, no reading', async () => {
  const { fb, tmux } = mk();
  assert.equal(fb.enabled(), false);
  assert.equal(fb.refresh(), null);
  assert.equal(tmux.calls.length, 0);
  assert.equal(fb.latest(), null);
});

test('the env flag and the flag file switch it on', () => {
  assert.equal(mk({ env: { CCDASH_USAGE_FALLBACK: '1' } }).fb.enabled(), true);
  assert.equal(mk({ env: { CCDASH_USAGE_FALLBACK: '0' } }).fb.enabled(), false);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-fb-')), 'usage-fallback.enabled');
  fs.writeFileSync(f, '');
  assert.equal(mk({ flagFile: f }).fb.enabled(), true);
});

test('a run starts a hidden claude in _ops, types /usage, captures, exits and kills the window', async () => {
  const { fb, tmux } = mk({ env: { CCDASH_USAGE_FALLBACK: '1' } });
  await fb.refresh();
  const nw = tmux.calls.find((c) => c[0] === 'new-window');
  assert.ok(nw.includes('=_ops:'));
  assert.ok(nw.join(' ').includes('-e CCDASH_HIDDEN=1'));
  assert.equal(nw.at(-1), 'claude');
  const sends = tmux.calls.filter((c) => c[0] === 'send-keys').map((c) => c.slice(3).join(' '));
  assert.ok(sends.includes('-l /usage'));
  assert.ok(sends.includes('-l /exit'));
  assert.deepEqual(tmux.calls.at(-1), ['kill-window', '-t', '@7']);
  assert.ok(tmux.calls.some((c) => c[0] === 'capture-pane'));
  assert.equal(fb.latest().limits.five_hour.used_percentage, 23);
  assert.equal(fb.latest().ts, 1000);
});

test('a trust dialog is never taken for the prompt: the run aborts without typing', async () => {
  const dlg = ' Do you trust the files in this folder?\n > 1. Yes, proceed\n   2. No, exit\n';
  const tmux = fakeTmux({ screen: dlg });
  const orig = tmux.run;
  tmux.run = async (a) => (a[0] === 'capture-pane' ? dlg : orig(a));
  const { fb } = mk({ env: { CCDASH_USAGE_FALLBACK: '1' }, tmux });
  await fb.refresh();
  assert.ok(!tmux.calls.some((c) => c[0] === 'send-keys'));
  assert.deepEqual(tmux.calls.at(-1), ['kill-window', '-t', '@7']);
  assert.equal(fb.latest(), null);
});

test('stale ccdash-usage windows are swept before the first run', async () => {
  const tmux = fakeTmux();
  const orig = tmux.run;
  tmux.run = async (a) => (a[0] === 'list-windows' ? '@3 ccdash-usage\n@4 ccd-ops\n' : orig(a));
  const { fb } = mk({ env: { CCDASH_USAGE_FALLBACK: '1' }, tmux });
  await fb.refresh();
  assert.ok(tmux.calls.some((c) => c[0] === 'kill-window' && c[2] === '@3'));
  assert.ok(!tmux.calls.some((c) => c[0] === 'kill-window' && c[2] === '@4'));
});

test('at most once per interval; again after it', async () => {
  const { fb, tmux, advance } = mk({ env: { CCDASH_USAGE_FALLBACK: '1' } });
  await fb.refresh();
  const n = tmux.calls.filter((c) => c[0] === 'new-window').length;
  advance(599_000);
  await fb.refresh();
  assert.equal(tmux.calls.filter((c) => c[0] === 'new-window').length, n);
  advance(2_000);
  await fb.refresh();
  assert.equal(tmux.calls.filter((c) => c[0] === 'new-window').length, n + 1);
});

test('a failing run is logged-and-swallowed, leaves no reading, and still honours the interval', async () => {
  const { fb, tmux } = mk({ env: { CCDASH_USAGE_FALLBACK: '1' }, tmux: fakeTmux({ fail: true }) });
  await fb.refresh();
  assert.equal(fb.latest(), null);
  const n = tmux.calls.length;
  await fb.refresh();
  assert.equal(tmux.calls.length, n);
});

test('an unparsable screen gives no reading (never a guess)', async () => {
  const { fb } = mk({ env: { CCDASH_USAGE_FALLBACK: '1' }, tmux: fakeTmux({ screen: 'Welcome to Claude' }) });
  await fb.refresh();
  assert.equal(fb.latest(), null);
});

test('gauges use the fallback reading only when no statusline reading has rate_limits', async () => {
  const { fb } = mk({ env: { CCDASH_USAGE_FALLBACK: '1' } });
  await fb.refresh();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-fb-'));
  const g = gauges({ dir: empty, now: 1000, fallback: fb.latest });
  assert.equal(g.source, 'usage-command');
  assert.equal(g.five_hour.used_percentage, 23);
  assert.equal(g.five_hour.countdown, null);
  assert.equal(g.five_hour.resets_text, '3pm (UTC)');
});
