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

// Inside the image only dashboard/ is present (as /opt/ccdash/dashboard), so these cases skip there.
const SKIP = fs.existsSync(path.join(ROOT, 'rootfs')) && fs.existsSync(CCD) ? false : 'rootfs/ and bin/ not found (running inside the image)';

const run = (file, args, input, env = {}) =>
  spawnSync(file, args, { input, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

test('git-credential-ccdash: https + github.com + valid owner with token file returns the token', { skip: SKIP }, () => {
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

test('ccd-session validates arguments before touching tmux', { skip: SKIP }, () => {
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

test('ccd-project validates the repo argument', { skip: SKIP }, () => {
  assert.strictEqual(run(PROJECT, []).status, 2);
  assert.strictEqual(run(PROJECT, ['clone']).status, 2);
  assert.strictEqual(run(PROJECT, ['push', 'a/b']).status, 2);
  for (const bad of ['a', 'a/', '/b', 'a/b/c', 'a/..', 'a/.hidden', 'a/b..c', 'a b/c', 'a/b c', '-o/x', 'a_b/c', 'a/b;rm']) {
    const r = run(PROJECT, ['clone', bad]);
    assert.strictEqual(r.status, 2, bad);
    assert.match(r.stderr, /invalid repo/);
  }
});

test('ccd (host wrapper) rejects unknown commands and missing arguments', { skip: SKIP }, () => {
  for (const args of [[], ['nope'], ['attach'], ['clone'], ['attach', 'a', 'b']]) {
    assert.strictEqual(run(CCD, args, undefined, { CCDASH_DOCKER: 'false' }).status, 2, args.join(' '));
  }
});

// The prompt is the last argument of tmux new-session; tmux treats a trailing ';' as a command
// separator unless it is written `\;`. A stub `claude` records its argv; compare byte for byte.
const HAS_TMUX = spawnSync('tmux', ['-V']).status === 0;
test('ccd-session hands the prompt to claude unchanged (trailing ;, newlines, quotes, leading -)',
  { skip: SKIP || (HAS_TMUX ? false : 'tmux not installed') }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-sess-'));
    fs.mkdirSync(path.join(dir, 'ws', 'p'), { recursive: true }); fs.mkdirSync(path.join(dir, 'bin')); fs.mkdirSync(path.join(dir, 'home'));
    fs.writeFileSync(path.join(dir, 'bin', 'claude'), '#!/bin/bash\n[ "$1" = mcp ] && { echo "basic-memory: x - ok Connected"; exit 0; } # the start gate\nprintf \'%s\\0\' "$@" > "$OUTF"\n', { mode: 0o755 });
    // a login shell resets PATH from /etc/profile: put the stub back from ~/.bash_profile
    fs.writeFileSync(path.join(dir, 'home', '.bash_profile'), `export PATH=${dir}/bin:$PATH\n`);
    const sock = path.join(dir, 'sock');
    const out = path.join(dir, 'out');
    const env = { PATH: `${dir}/bin:${process.env.PATH}`, HOME: path.join(dir, 'home'), OUTF: out, CCDASH_WS: path.join(dir, 'ws'), CCDASH_TMUX: sock };
    try {
      for (const prompt of ['a;', 'a\;', 'a\\\;', ';', '-x;;', 'two\nlines;', '$(id) "q" \'s\';', '\\', 'plain', '-x', '']) {
        fs.rmSync(out, { force: true });
        fs.rmSync(sock, { force: true });
        const r = run(SESSION, ['start', 'p', prompt], undefined, env);
        assert.strictEqual(r.status, 0, r.stderr);
        for (let i = 0; i < 100 && !fs.existsSync(out); i++) await new Promise((x) => setTimeout(x, 50));
        // an empty prompt is skipped, as on the web path: claude gets only the `--`
        assert.strictEqual(fs.readFileSync(out, 'utf8'), prompt === '' ? '--\0' : `--\0${prompt}\0`, JSON.stringify(prompt));
        spawnSync('tmux', ['-S', sock, 'kill-server']);
      }
    } finally {
      spawnSync('tmux', ['-S', sock, 'kill-server']);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
