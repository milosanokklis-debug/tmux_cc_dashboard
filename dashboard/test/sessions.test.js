'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionStore, IDLE_MS, ABSOLUTE_MS } = require('../lib/sessions');
const { fakeClock } = require('./helpers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-sess-'));

test('id is 256 bits, only a hash is persisted (mode 0600)', () => {
  const dir = tmp();
  const s = new SessionStore({ dir, clock: fakeClock() });
  const id = s.create();
  assert.strictEqual(Buffer.from(id, 'base64url').length, 32);
  const file = path.join(dir, 'sessions.json');
  assert.ok(!fs.readFileSync(file, 'utf8').includes(id));
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
});

test('expires after 12h idle, idle timer is refreshed by use', () => {
  const clock = fakeClock();
  const s = new SessionStore({ dir: tmp(), clock });
  const id = s.create();
  clock.advance(IDLE_MS - 1000);
  assert.ok(s.validate(id));
  clock.advance(IDLE_MS - 1000);
  assert.ok(s.validate(id));
  clock.advance(IDLE_MS + 1);
  assert.ok(!s.validate(id));
});

test('expires after 7 days absolute even if active', () => {
  const clock = fakeClock();
  const s = new SessionStore({ dir: tmp(), clock });
  const id = s.create();
  for (let t = 0; t < ABSOLUTE_MS - 3600e3; t += 3600e3) { clock.advance(3600e3); assert.ok(s.validate(id)); }
  clock.advance(2 * 3600e3);
  assert.ok(!s.validate(id));
});

test('survives restart; generation change ends all sessions', () => {
  const dir = tmp();
  const clock = fakeClock();
  const id = new SessionStore({ dir, clock, generation: 1 }).create();
  const s2 = new SessionStore({ dir, clock, generation: 1 });
  assert.ok(s2.validate(id));
  assert.ok(s2.setGeneration(2));
  assert.ok(!s2.validate(id));
  assert.ok(!new SessionStore({ dir, clock, generation: 2 }).validate(id));
});
