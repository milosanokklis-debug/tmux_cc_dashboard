'use strict';
// The hidden /usage claude runs once per signed-in project, with CLAUDE_CONFIG_DIR set to that project's dir.
const test = require('node:test');
const assert = require('node:assert');
const { createUsageFallback } = require('../lib/usage-fallback');

const SCREEN = ' Current session\n ███  23% used\n Resets 3pm (UTC)\n Current week (all models)\n ██  41% used\n Resets Nov 9, 2pm (UTC)\n';
function fakeTmux() {
  const calls = [];
  let typed = '';
  let n = 0;
  return {
    calls,
    ensureOps: async () => {},
    run: async (argv) => {
      calls.push(argv);
      if (argv[0] === 'new-window') return `@${++n}\n`;
      if (argv[0] === 'send-keys' && argv.includes('-l')) typed = argv.at(-1);
      if (argv[0] === 'capture-pane') return typed === '/usage' ? SCREEN : '> ';
      return '';
    },
  };
}

test('one hidden claude per signed-in project, each with its own CLAUDE_CONFIG_DIR; never the shared dir', async () => {
  const tmux = fakeTmux();
  const fb = createUsageFallback({
    tmux, now: () => 1_000_000, wait: async () => {}, env: { CCDASH_USAGE_FALLBACK: '1' }, log: () => {},
    projects: () => ['a', 'b', 'out'], signedIn: async (n) => n !== 'out',
  });
  await fb.refresh();
  const wins = tmux.calls.filter((c) => c[0] === 'new-window');
  assert.strictEqual(wins.length, 2);
  const dirs = wins.map((c) => c[c.indexOf('-e', c.indexOf('-e') + 1) + 1]);
  assert.deepStrictEqual(dirs, ['CLAUDE_CONFIG_DIR=/home/ccd/.claude-projects/a', 'CLAUDE_CONFIG_DIR=/home/ccd/.claude-projects/b']);
  assert.ok(!wins.some((c) => c.join(' ').includes('/home/ccd/.claude ') || c.join(' ').endsWith('/home/ccd/.claude')));
  assert.strictEqual(fb.latest().limits.five_hour.used_percentage, 23);
});

test('no signed-in project: no claude is started', async () => {
  const tmux = fakeTmux();
  const fb = createUsageFallback({
    tmux, now: () => 1_000_000, wait: async () => {}, env: { CCDASH_USAGE_FALLBACK: '1' }, log: () => {},
    projects: () => ['a'], signedIn: async () => false,
  });
  await fb.refresh();
  assert.ok(!tmux.calls.some((c) => c[0] === 'new-window'));
  assert.strictEqual(fb.latest(), null);
});
