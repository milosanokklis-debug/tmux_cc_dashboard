'use strict';
// Tests the shell helpers' validation paths. No tmux, git or docker needed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const CRED = path.join(ROOT, 'rootfs/usr/local/lib/ccdash/git-credential-ccdash');
const SESSION = path.join(ROOT, 'rootfs/usr/local/bin/ccd-session');
const PROJECT = path.join(ROOT, 'rootfs/usr/local/bin/ccd-project');
const CCD = path.join(ROOT, 'bin/ccd');

const run = (file, args, input, env = {}) =>
  spawnSync(file, args, { input, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

test('git-credential-ccdash: https + github.com + valid owner with token file returns the token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-git-'));
  fs.writeFileSync(path.join(dir, 'octo-cat'), 'tok123\n');
  const input = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join('\n') + '\n\n';
  const good = { protocol: 'https', host: 'github.com', path: 'octo-cat/repo.git' };
  const env = { CCDASH_GIT_DIR: dir };
  const r = run(CRED, ['get'], input(good), env);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, 'username=x-access-token\npassword=tok123\n');
  const denied = [
    { ...good, protocol: 'http' },
    { ...good, protocol: 'ssh' },
    { host: good.host, path: good.path },               // no protocol
    { ...good, host: 'github.com.evil.example' },
    { ...good, host: 'gitlab.com' },
    { ...good, path: '../octo-cat/repo' },
    { ...good, path: 'other/repo' },                    // no token file for this owner
    { ...good, path: 'octo.cat/repo' },
    { ...good, path: '' },
  ];
  for (const d of denied) {
    const x = run(CRED, ['get'], input(d), env);
    assert.strictEqual(x.status, 0, JSON.stringify(d));
    assert.strictEqual(x.stdout, '', JSON.stringify(d));
  }
  for (const verb of ['store', 'erase']) assert.strictEqual(run(CRED, [verb], input(good), env).stdout, '');
});

test('ccd-session validates arguments before touching tmux', () => {
  assert.strictEqual(run(SESSION, []).status, 2);
  assert.strictEqual(run(SESSION, ['bogus']).status, 2);
  assert.strictEqual(run(SESSION, ['start']).status, 2);
  assert.strictEqual(run(SESSION, ['attach']).status, 2);
  for (const bad of ['a/b', '..', 'a..b', 'a b', '-x', '', 'a;b', '$(id)']) {
    const r = run(SESSION, ['start', bad]);
    assert.strictEqual(r.status, 2, JSON.stringify(bad));
    assert.match(r.stderr, /invalid project name/);
  }
  const missing = run(SESSION, ['start', 'ccdash-no-such-project']);
  assert.strictEqual(missing.status, 1);
  assert.match(missing.stderr, /no such project/);
});

test('ccd-project validates the repo argument', () => {
  assert.strictEqual(run(PROJECT, []).status, 2);
  assert.strictEqual(run(PROJECT, ['clone']).status, 2);
  assert.strictEqual(run(PROJECT, ['push', 'a/b']).status, 2);
  for (const bad of ['a', 'a/', '/b', 'a/b/c', 'a/..', 'a/.hidden', 'a/b..c', 'a b/c', 'a/b c', '-o/x', 'a_b/c', 'a/b;rm']) {
    const r = run(PROJECT, ['clone', bad]);
    assert.strictEqual(r.status, 2, bad);
    assert.match(r.stderr, /invalid repo/);
  }
});

test('ccd (host wrapper) rejects unknown commands and missing arguments', () => {
  for (const args of [[], ['nope'], ['attach'], ['clone'], ['attach', 'a', 'b']]) {
    assert.strictEqual(run(CCD, args, undefined, { CCDASH_DOCKER: 'false' }).status, 2, args.join(' '));
  }
});
