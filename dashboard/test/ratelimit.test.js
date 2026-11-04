'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { LoginLimiter, LOCK_MS, MAX_DELAY_MS } = require('../lib/ratelimit');
const { fakeClock } = require('./helpers');

test('no delay for 5 failures, then exponential capped delay', () => {
  const l = new LoginLimiter({ clock: fakeClock() });
  for (let i = 0; i < 5; i++) assert.strictEqual(l.begin('1.1.1.1').delayMs, 0);
  assert.strictEqual(l.begin('1.1.1.1').delayMs, 1000);
  assert.strictEqual(l.begin('1.1.1.1').delayMs, 2000);
  assert.strictEqual(l.begin('1.1.1.1').delayMs, 4000);
  for (let i = 0; i < 5; i++) l.begin('1.1.1.1');
  assert.strictEqual(l.begin('1.1.1.1').delayMs, MAX_DELAY_MS);
  assert.strictEqual(l.begin('2.2.2.2').delayMs, 0); // other clients unaffected
});

test('client counter resets after 15 minutes', () => {
  const clock = fakeClock();
  const l = new LoginLimiter({ clock });
  for (let i = 0; i < 6; i++) l.begin('a');
  clock.advance(15 * 60 * 1000 + 1);
  assert.strictEqual(l.begin('a').delayMs, 0);
});

test('success refunds the attempt', () => {
  const l = new LoginLimiter({ clock: fakeClock() });
  for (let i = 0; i < 20; i++) l.begin('a').finish(true);
  assert.strictEqual(l.begin('a').delayMs, 0);
});

test('50 failures in an hour from many clients lock everyone for 15 minutes', () => {
  const clock = fakeClock();
  const l = new LoginLimiter({ clock });
  for (let i = 0; i < 50; i++) { l.begin(`ip${i}`); clock.advance(1000); }
  const locked = l.begin('fresh');
  assert.ok(locked.locked);
  assert.ok(locked.retryAfterMs > 0 && locked.retryAfterMs <= LOCK_MS);
  clock.advance(LOCK_MS + 1);
  assert.ok(!l.begin('fresh').locked);
});
