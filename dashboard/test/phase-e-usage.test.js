'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gauges } = require('../lib/usage');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'tests', 'fixtures', '2.1.317', 'statusline.json'), 'utf8'));
const NOW = 1789990000;

function dir(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-usage-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(d, `${name}.json`), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return d;
}
const rec = (ts, rate_limits) => ({ sid: 'x', ts, rate_limits, cost: null, context_window: null, model: null });

test('gauges come from the fixture rate_limits with countdowns', () => {
  const d = dir({ a: rec(NOW - 5, FIXTURE.rate_limits) });
  const g = gauges({ dir: d, now: NOW });
  assert.equal(g.five_hour.status, 'ok');
  assert.equal(g.five_hour.used_percentage, 23.5);
  assert.equal(g.five_hour.resets_at, 1790000000);
  assert.equal(g.five_hour.countdown, 10000);
  assert.equal(g.five_hour.ts, NOW - 5);
  assert.equal(g.seven_day.used_percentage, 41.2);
  assert.equal(g.seven_day.countdown, 1790400000 - NOW);
  assert.equal(g.five_hour.stale, false);
  assert.equal(g.source, 'statusline');
});

test('the freshest reading that has rate_limits wins, even over a newer one without', () => {
  const d = dir({
    old: rec(100, { five_hour: { used_percentage: 10, resets_at: NOW + 100 } }),
    mid: rec(200, { five_hour: { used_percentage: 20, resets_at: NOW + 100 } }),
    newer: rec(300, null),
  });
  assert.equal(gauges({ dir: d, now: NOW }).five_hour.used_percentage, 20);
});

test('removing rate_limits gives unknown, never a guess', () => {
  const noRl = { ...FIXTURE }; delete noRl.rate_limits;
  const d = dir({ a: rec(NOW, undefined), b: rec(NOW, null), c: 'not json', d: rec(NOW, { five_hour: { used_percentage: 'lots' } }) });
  const g = gauges({ dir: d, now: NOW });
  assert.deepEqual(g.five_hour, { status: 'unknown' });
  assert.deepEqual(g.seven_day, { status: 'unknown' });
  assert.equal(g.ts, null);
  assert.deepEqual(gauges({ dir: path.join(d, 'missing'), now: NOW }).five_hour, { status: 'unknown' });
  assert.ok(!('rate_limits' in noRl));
});

test('a window missing from the reading is unknown on its own; a rolled window is marked stale', () => {
  const d = dir({ a: rec(NOW - 100, { five_hour: { used_percentage: 99, resets_at: NOW - 10 } }) });
  const g = gauges({ dir: d, now: NOW });
  assert.equal(g.five_hour.stale, true);
  assert.equal(g.five_hour.countdown, 0);
  assert.deepEqual(g.seven_day, { status: 'unknown' });
});

test('symlinks and odd file names in the usage dir are ignored', () => {
  const d = dir({ a: rec(5, { five_hour: { used_percentage: 1, resets_at: NOW + 1 } }) });
  fs.symlinkSync(path.join(d, 'a.json'), path.join(d, 'link.json'));
  fs.writeFileSync(path.join(d, '.tmp'), JSON.stringify(rec(999, FIXTURE.rate_limits)));
  const g = gauges({ dir: d, now: NOW });
  assert.equal(g.five_hour.used_percentage, 1);
  assert.equal(g.ts, 5);
});

test('the fallback is used only when no reading has rate_limits', () => {
  const fb = () => ({ ts: NOW - 60, limits: { five_hour: { used_percentage: 7, resets_at: NOW + 60 } } });
  const empty = dir({});
  const g = gauges({ dir: empty, now: NOW, fallback: fb });
  assert.equal(g.five_hour.used_percentage, 7);
  assert.equal(g.source, 'usage-command');
  const d = dir({ a: rec(1, FIXTURE.rate_limits) });
  assert.equal(gauges({ dir: d, now: NOW, fallback: fb }).source, 'statusline');
});

test('the file cap keeps the newest readings; prune removes old ones', () => {
  const { readings, prune } = require('../lib/usage');
  const d = dir({ fresh: rec(500, { five_hour: { used_percentage: 5, resets_at: NOW + 100 } }), old: rec(100, null) });
  const old = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
  fs.utimesSync(path.join(d, 'old.json'), old, old);
  assert.equal(readings(d).length, 2);
  assert.equal(prune(d), 1);
  assert.deepEqual(fs.readdirSync(d), ['fresh.json']);
});
