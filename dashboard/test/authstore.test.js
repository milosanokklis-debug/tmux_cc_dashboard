'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const authstore = require('../lib/authstore');
const { FAST } = require('./helpers');

test('password length rule: 13 rejected, 14 accepted', () => {
  assert.ok(authstore.checkPasswordRule('a'.repeat(13)));
  assert.strictEqual(authstore.checkPasswordRule('a'.repeat(14)), null);
});

test('setCredentials stores argon2id hash, mode 0600, new random generation, removes sessions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-auth-'));
  const g1 = await authstore.setCredentials({ dir, username: 'bob', password: 'x'.repeat(14), hashOptions: FAST });
  fs.writeFileSync(path.join(dir, 'sessions.json'), '{}');
  const g2 = await authstore.setCredentials({ dir, username: 'bob', password: 'y'.repeat(14), hashOptions: FAST });
  assert.match(g1, /^[0-9a-f]{32}$/);
  assert.notStrictEqual(g2, g1);
  assert.ok(!fs.existsSync(path.join(dir, 'sessions.json')));
  assert.strictEqual(fs.statSync(path.join(dir, 'auth.json')).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(dir), ['auth.json']); // no leftover tmp file
  const a = authstore.readAuth(dir);
  assert.match(a.hash, /^\$argon2id\$/);
  assert.ok(!JSON.stringify(a).includes('y'.repeat(14)));
});

test('setCredentials refuses a 13 character password', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-auth-'));
  await assert.rejects(authstore.setCredentials({ dir, username: 'bob', password: 'z'.repeat(13), hashOptions: FAST }));
  assert.strictEqual(authstore.readAuth(dir), null);
});

test('verifyLogin: right pair ok; wrong password, wrong user fail', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-auth-'));
  await authstore.setCredentials({ dir, username: 'bob', password: 'p'.repeat(14), hashOptions: FAST });
  const a = authstore.readAuth(dir);
  assert.strictEqual(await authstore.verifyLogin(a, 'bob', 'p'.repeat(14)), true);
  assert.strictEqual(await authstore.verifyLogin(a, 'bob', 'q'.repeat(14)), false);
  assert.strictEqual(await authstore.verifyLogin(a, 'eve', 'p'.repeat(14)), false);
});

test('readAuth throws (without leaking contents) on empty, corrupt or malformed auth.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-auth-'));
  for (const body of ['', '{not json', '{"username":"a"}', 'null', '{"username":"a","hash":"SECRETHASH","generation":5}']) {
    fs.writeFileSync(path.join(dir, 'auth.json'), body);
    assert.throws(() => authstore.readAuth(dir), (e) => !/SECRETHASH/.test(e.message));
  }
});

