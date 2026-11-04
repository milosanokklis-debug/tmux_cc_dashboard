'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTmux, readProcTable, hasClaude, runOp, sweepOps } = require('../lib/tmux');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-tmux-'));

function fakeExec(reply) {
  const calls = [];
  const exec = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    const r = reply(file, args);
    if (r instanceof Error) cb(Object.assign(r, { code: 1 }), '', r.stderr || '');
    else cb(null, r.stdout ?? '', r.stderr ?? '');
  };
  return { exec, calls };
}

test('tmux is called with an argv array and the socket; no shell', async () => {
  const f = fakeExec(() => ({ stdout: 'ok' }));
  const tmux = createTmux({ sock: '/s.sock', exec: f.exec });
  assert.strictEqual(await tmux.run(['has-session', '-t', '=a; rm -rf /']), 'ok');
  assert.strictEqual(f.calls[0].file, 'tmux');
  assert.deepStrictEqual(f.calls[0].args, ['-S', '/s.sock', 'has-session', '-t', '=a; rm -rf /']);
  assert.ok(!f.calls[0].opts.shell);
});

test('"access not allowed" with exit 0 is an error', async () => {
  const tmux = createTmux({ sock: '/s', exec: fakeExec(() => ({ stdout: '', stderr: 'access not allowed\n' })).exec });
  await assert.rejects(tmux.run(['list-sessions']), /access not allowed/);
  const t2 = createTmux({ sock: '/s', exec: fakeExec(() => ({ stdout: 'access not allowed\n' })).exec });
  await assert.rejects(t2.listPanes(), /access not allowed/);
});

test('"access not allowed" inside ccd-controlled stdout is not a denial', async () => {
  const out = 'access not allowed\t0\t%3\t100\t1\t1\t/workspace/access not allowed\n';
  const panes = await createTmux({ sock: '/s', exec: fakeExec(() => ({ stdout: out })).exec }).listPanes();
  assert.strictEqual(panes[0].session, 'access not allowed');
  assert.strictEqual(panes[0].projectDir, '/workspace/access not allowed');
  const tmux = createTmux({ sock: '/s', exec: fakeExec(() => ({ stdout: 'my access not allowed note\n' })).exec });
  assert.strictEqual(await tmux.run(['show-options']), 'my access not allowed note\n');
});

test('a missing tmux socket is an error from listPanes (the API answers 503), not an empty list', async () => {
  const f = fakeExec(() => Object.assign(new Error('x'), { stderr: 'error connecting to /s (No such file or directory)' }));
  await assert.rejects(createTmux({ sock: '/s', exec: f.exec }).listPanes(), /error connecting/);
});

test('sweepOps removes only old generated regular files', () => {
  const dir = tmp();
  const old = (n, mk = (f) => fs.writeFileSync(f, 'x')) => {
    const f = path.join(dir, n); mk(f);
    if (!fs.lstatSync(f).isSymbolicLink()) fs.utimesSync(f, 1000, 1000);
    return f;
  };
  const gone = ['0123456789abcdef.rc', '0123456789abcdef.log', '0123456789abcdef.rc.tmp'].map((n) => old(n));
  const keep = [
    old('0123456789abcdef.txt'), old('short.rc'), old('0123456789ABCDEF.rc'), old('0123456789abcdef.rc.bak'),
    old('fedcba9876543210.rc', (f) => fs.symlinkSync('/etc/passwd', f)),
    old('aaaaaaaaaaaaaaaa.log', (f) => fs.mkdirSync(f)),
  ];
  const fresh = path.join(dir, 'bbbbbbbbbbbbbbbb.rc');
  fs.writeFileSync(fresh, '0');
  assert.strictEqual(sweepOps(dir, { maxAgeMs: 3600 * 1000, now: Date.now() }), 3);
  for (const f of gone) assert.ok(!fs.existsSync(f), f);
  for (const f of [...keep, fresh]) assert.ok(fs.existsSync(f) || fs.lstatSync(f), f);
  assert.ok(fs.existsSync(fresh) && fs.existsSync('/etc/passwd'));
  assert.strictEqual(sweepOps(path.join(dir, 'nope')), 0);
});

test('listPanes parses format lines; no server means no panes', async () => {
  const out = 'claude-demo\t0\t%3\t100\t1\t1\t/workspace/demo\nweb-1\t0\t%3\t100\t1\t1\t\nbroken line\n';
  const panes = await createTmux({ sock: '/s', exec: fakeExec(() => ({ stdout: out })).exec }).listPanes();
  assert.deepStrictEqual(panes[0], {
    session: 'claude-demo', window: '0', paneId: '%3', panePid: 100, active: true, projectDir: '/workspace/demo',
  });
  assert.strictEqual(panes.length, 2);
  const none = fakeExec(() => Object.assign(new Error('x'), { stderr: 'no server running on /s' }));
  assert.deepStrictEqual(await createTmux({ sock: '/s', exec: none.exec }).listPanes(), []);
});

test('ensureOps creates _ops once and tolerates a concurrent creator', async () => {
  const seen = [];
  const f = fakeExec((_, args) => {
    seen.push(args.slice(2).join(' '));
    if (args[2] === 'has-session') return Object.assign(new Error('x'), { stderr: "can't find session: _ops" });
    return Object.assign(new Error('x'), { stderr: 'duplicate session: _ops' });
  });
  await createTmux({ sock: '/s', exec: f.exec }).ensureOps();
  assert.deepStrictEqual(seen, ['has-session -t =_ops', 'new-session -d -s _ops']);
});

test('readProcTable reads /proc/<pid>/stat, including odd comm names', () => {
  const dir = tmp();
  const put = (pid, stat) => { fs.mkdirSync(path.join(dir, String(pid))); fs.writeFileSync(path.join(dir, String(pid), 'stat'), stat); };
  put(10, '10 (bash) S 1 10 10 0 -1 0');
  put(11, '11 (cl) aude) (x) S 10 10 10 0 -1 0');
  put(12, '12 (claude) S 10 10 10 0 -1 0');
  fs.mkdirSync(path.join(dir, 'self')); // non-numeric entries are ignored
  const t = readProcTable(dir);
  assert.deepStrictEqual(t.get(10), { ppid: 1, comm: 'bash' });
  assert.deepStrictEqual(t.get(11), { ppid: 10, comm: 'cl) aude) (x' });
  assert.strictEqual(t.get(12).comm, 'claude');
  assert.strictEqual(readProcTable(path.join(dir, 'nope')).size, 0);
});

test('hasClaude walks descendants only', () => {
  const table = new Map([
    [1, { ppid: 0, comm: 'init' }], [10, { ppid: 1, comm: 'bash' }], [11, { ppid: 10, comm: 'node' }],
    [12, { ppid: 11, comm: 'claude' }], [20, { ppid: 1, comm: 'bash' }], [21, { ppid: 20, comm: 'vim' }],
    [30, { ppid: 31, comm: 'a' }], [31, { ppid: 30, comm: 'b' }], // cycle must not hang
  ]);
  assert.ok(hasClaude(table, 10));
  assert.ok(hasClaude(table, 12));
  assert.ok(!hasClaude(table, 20));
  assert.ok(!hasClaude(table, 30));
  assert.ok(!hasClaude(table, 999));
});

function opHarness({ rcAfter, rc = '0\n', log = 'cloning...\n', timeoutMs = 5000 }) {
  const dir = tmp();
  const runs = [];
  const tmux = { ensureOps: async () => runs.push('ensure'), run: async (a) => { runs.push(a); return a[0] === 'new-window' ? '@7\n' : ''; } };
  let t = 0;
  let polls = 0;
  const run = () => runOp({
    tmux, argv: ['ccd-project', 'clone', 'o/r'], dir, timeoutMs, intervalMs: 500, now: () => t,
    wait: async (ms) => {
      t += ms; polls++;
      const id = runs[1][runs[1].indexOf('ccd-ops') + 1];
      if (rcAfter !== undefined && polls === rcAfter) {
        fs.writeFileSync(path.join(dir, `${id}.log`), log);
        fs.writeFileSync(path.join(dir, `${id}.rc`), rc);
      }
    },
  });
  return { dir, runs, run };
}

test('runOp: uses ccd-ops with a 16-hex id as argv, polls, returns rc 0 and deletes both files', async () => {
  const h = opHarness({ rcAfter: 3 });
  const r = await h.run();
  assert.deepStrictEqual(r, { rc: 0, log: 'cloning...\n' });
  const argv = h.runs[1];
  assert.deepStrictEqual(argv.slice(0, 9), ['new-window', '-d', '-P', '-F', '#{window_id}', '-t', '=_ops:', '--', 'ccd-ops']);
  assert.match(argv[9], /^[0-9a-f]{16}$/);
  assert.deepStrictEqual(argv.slice(10), ['ccd-project', 'clone', 'o/r']);
  assert.deepStrictEqual(fs.readdirSync(h.dir), []);
});

test('runOp: non-zero rc returns the log tail (<= 4 KB)', async () => {
  const h = opHarness({ rcAfter: 1, rc: '128\n', log: `${'x'.repeat(10000)}fatal: nope\n` });
  const r = await h.run();
  assert.strictEqual(r.rc, 128);
  assert.ok(r.log.length <= 4096 && r.log.endsWith('fatal: nope\n'));
  assert.deepStrictEqual(fs.readdirSync(h.dir), []);
});

test('runOp: times out with the injected clock, kills the _ops window and removes the files', async () => {
  const h = opHarness({ timeoutMs: 2000 });
  fs.writeFileSync(path.join(h.dir, 'stale.log'), 'kept'); // other files are not touched
  const r = await h.run();
  assert.strictEqual(r.timedOut, true);
  assert.deepStrictEqual(h.runs.at(-1), ['kill-window', '-t', '@7']);
  assert.deepStrictEqual(fs.readdirSync(h.dir), ['stale.log']);
});

test('runOp: a half-written rc (not digits) is not accepted', async () => {
  const h = opHarness({ rcAfter: 1, rc: '', timeoutMs: 1000 });
  assert.strictEqual((await h.run()).timedOut, true);
});

// ccd can plant anything in the ops directory; none of it may block or be read whole.

test('runOp: a FIFO or symlink planted as <id>.rc/.log is never opened blockingly; rc stays pending', async () => {
  const dir = tmp();
  const id = '0123456789abcdef';
  const tmux = { ensureOps: async () => {}, run: async () => '@1\n' };
  const secret = path.join(dir, 'secret');
  fs.writeFileSync(secret, '0\nSECRET');
  require('node:child_process').execFileSync('mkfifo', [path.join(dir, `${id}.rc`)]);
  fs.symlinkSync(secret, path.join(dir, `${id}.log`));
  let t = 0;
  const guard = setTimeout(() => { throw new Error('runOp blocked'); }, 5000);
  const r = await runOp({ tmux, argv: ['x'], dir, id, timeoutMs: 1000, now: () => t, wait: async (ms) => { t += ms; } });
  clearTimeout(guard);
  assert.strictEqual(r.timedOut, true);
  assert.strictEqual(r.log, ''); // the symlinked log was not followed
  assert.ok(fs.existsSync(secret)); // only the planted names were removed
  assert.deepStrictEqual(fs.readdirSync(dir), ['secret']);
});

test('runOp: a symlinked rc is ignored; a huge log is read only from its tail; a huge rc is not a number', async () => {
  const dir = tmp();
  const id = 'fedcba9876543210';
  const tmux = { ensureOps: async () => {}, run: async () => '@1\n' };
  fs.writeFileSync(path.join(dir, 'real'), '0\n');
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, `${id}.rc`));
  let t = 0;
  const wait = async (ms) => { t += ms; };
  assert.strictEqual((await runOp({ tmux, argv: ['x'], dir, id, timeoutMs: 1000, now: () => t, wait })).timedOut, true);

  fs.writeFileSync(path.join(dir, `${id}.rc`), '1'.repeat(1000)); // digits, but far over 16 bytes
  assert.strictEqual((await runOp({ tmux, argv: ['x'], dir, id, timeoutMs: 1000, now: () => t, wait })).timedOut, true);

  fs.writeFileSync(path.join(dir, `${id}.rc`), '3\n');
  const fd = fs.openSync(path.join(dir, `${id}.log`), 'w');
  fs.ftruncateSync(fd, 200 * 1024 * 1024); // sparse 200 MB
  fs.writeSync(fd, Buffer.from('the end\n'), 0, 8, 200 * 1024 * 1024 - 8);
  fs.closeSync(fd);
  const before = process.memoryUsage().rss;
  const r = await runOp({ tmux, argv: ['x'], dir, id, timeoutMs: 1000, now: () => t, wait });
  assert.strictEqual(r.rc, 3);
  assert.ok(r.log.length <= 4096 && r.log.endsWith('the end\n'));
  assert.ok(process.memoryUsage().rss - before < 50 * 1024 * 1024);
});

test('listPanes: a denied or unreachable tmux throws; only "no server running" means no panes', async () => {
  for (const msg of ['error connecting to /s (No such file or directory)', 'error connecting to /s (Connection refused)']) {
    const f = fakeExec(() => Object.assign(new Error('x'), { stderr: msg }));
    await assert.rejects(createTmux({ sock: '/s', exec: f.exec }).listPanes(), /error connecting/);
  }
});
