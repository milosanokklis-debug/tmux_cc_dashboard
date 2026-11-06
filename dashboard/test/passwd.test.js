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

test('ccdash-passwd --stdin takes the first line as the password and rejects a short one', async () => {
  const { passwordFromStdin } = require('../ccdash-passwd');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-pw-'));
  await assert.rejects(passwordFromStdin({ username: 'dave', input: 'short\n', dir, hashOptions: FAST }), /at least 14/);
  await passwordFromStdin({ username: 'dave', input: `${'x'.repeat(24)}\r\nignored\n`, dir, hashOptions: FAST });
  const auth = authstore.readAuth(dir);
  assert.strictEqual(auth.username, 'dave');
  assert.ok(await authstore.verifyLogin(auth, 'dave', 'x'.repeat(24)));
});
