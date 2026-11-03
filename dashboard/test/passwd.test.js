'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyPassword } = require('../ccdash-passwd');
const authstore = require('../lib/authstore');
const { FAST } = require('./helpers');

test('ccdash-passwd applyPassword rejects mismatch, short password, empty username; nothing written', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-pw-'));
  const ok = { username: 'carol', password: 'p'.repeat(14), repeat: 'p'.repeat(14), dir, hashOptions: FAST };
  await assert.rejects(applyPassword({ ...ok, repeat: 'q'.repeat(14) }), /do not match/);
  await assert.rejects(applyPassword({ ...ok, password: 'short', repeat: 'short' }), /at least 14/);
  await assert.rejects(applyPassword({ ...ok, username: '  ' }), /username/);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});
