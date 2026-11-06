'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const svc = require('../../rootfs/usr/local/lib/ccdash/reader');
const { createReader } = require('../lib/reader');

// <tmp>/projects/p/a.jsonl (inside), <tmp>/projects-evil/x.jsonl and <tmp>/secret.txt (outside)
function layout() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-reader-')));
  const root = path.join(tmp, 'projects');
  fs.mkdirSync(path.join(root, 'p'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'projects-evil'));
  fs.writeFileSync(path.join(root, 'p', 'a.jsonl'), 'line1\nline2\nline3\n');
  fs.writeFileSync(path.join(tmp, 'projects-evil', 'x.jsonl'), 'evil');
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'secret');
  fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(root, 'p', 'link-file'));
  fs.symlinkSync(tmp, path.join(root, 'p', 'link-dir'));
  fs.symlinkSync(path.join(root, 'p', 'a.jsonl'), path.join(root, 'p', 'link-inside'));
  return { tmp, root, a: path.join(root, 'p', 'a.jsonl') };
}
const denied = (r) => r.ok === false;

test('reads inside the root: stat, read from an offset, tail', () => {
  const { root, a } = layout();
  const st = svc.handle(root, { op: 'stat', path: a });
  assert.equal(st.ok, true);
  assert.equal(st.size, 18);
  assert.ok(Number.isInteger(st.inode));
  const r = svc.handle(root, { op: 'read', path: a, offset: 6, length: 5 });
  assert.equal(Buffer.from(r.data, 'base64').toString(), 'line2');
  assert.equal(r.size, 18);
  assert.equal(r.inode, st.inode);
  const t = svc.handle(root, { op: 'tail', path: a, bytes: 6 });
  assert.equal(Buffer.from(t.data, 'base64').toString(), 'line3\n');
  assert.equal(t.offset, 12);
  assert.equal(svc.handle(root, { op: 'read', path: a, offset: 100, length: 5 }).length, 0);
});

test('a symlink inside the root that stays inside is fine; one that escapes is not', () => {
  const { root } = layout();
  assert.equal(svc.handle(root, { op: 'stat', path: path.join(root, 'p', 'link-inside') }).ok, true);
  assert.ok(denied(svc.handle(root, { op: 'stat', path: path.join(root, 'p', 'link-file') })));
  assert.ok(denied(svc.handle(root, { op: 'stat', path: path.join(root, 'p', 'link-dir', 'secret.txt') })));
});

test('../, the prefix trick, relative paths, NUL and non-strings are rejected', () => {
  const { tmp, root } = layout();
  const bad = [
    path.join(root, '..', 'secret.txt'),
    path.join(root, 'p', '..', '..', 'secret.txt'),
    path.join(tmp, 'projects-evil', 'x.jsonl'), // shares the "projects" prefix
    path.join(tmp, 'secret.txt'),
    root, // the root itself is a directory, not a file inside it
    'p/a.jsonl', './a.jsonl', '', `${root}/p/a.jsonl\0.txt`, null, 42, ['/etc/passwd'], '/etc/passwd',
  ];
  for (const op of ['stat', 'tail', 'read']) {
    for (const p of bad) assert.ok(denied(svc.handle(root, { op, path: p, offset: 0, length: 1, bytes: 1 })), `${op} ${String(p)}`);
  }
});

test('directories, FIFOs and bad arguments are refused; errors never echo a path', () => {
  const { root, a } = layout();
  const fifo = path.join(root, 'p', 'fifo');
  require('node:child_process').execFileSync('mkfifo', [fifo]);
  assert.equal(svc.handle(root, { op: 'stat', path: fifo }).error, 'not_regular');
  assert.equal(svc.handle(root, { op: 'stat', path: path.join(root, 'p') }).error, 'not_regular');
  assert.equal(svc.handle(root, { op: 'read', path: a }).error, 'bad_args');
  assert.equal(svc.handle(root, { op: 'read', path: a, offset: -1 }).error, 'bad_args');
  assert.equal(svc.handle(root, { op: 'read', path: a, offset: 0, length: svc.MAX_LENGTH + 1 }).error, 'bad_args');
  assert.equal(svc.handle(root, { op: 'write', path: a }).error, 'bad_op');
  assert.equal(svc.handle(root, null).error, 'bad_request');
  for (const p of [path.join(root, 'nope'), '/etc/passwd', path.join(root, 'p', 'link-file')]) {
    const r = svc.handle(root, { op: 'stat', path: p });
    assert.equal(r.error, 'not_found');
    assert.ok(!JSON.stringify(r).includes('etc') && !JSON.stringify(r).includes(path.basename(p)));
  }
});

test('length is capped at 1 MiB', () => {
  const { root } = layout();
  const big = path.join(root, 'p', 'big.jsonl');
  fs.writeFileSync(big, Buffer.alloc(svc.MAX_LENGTH + 10, 97));
  const r = svc.handle(root, { op: 'read', path: big, offset: 0 });
  assert.equal(r.length, svc.MAX_LENGTH);
  assert.equal(r.size, svc.MAX_LENGTH + 10);
});

test('the socket service answers line by line, mode 0660, and the client reads through it', async () => {
  const { tmp, root, a } = layout();
  const sock = path.join(tmp, 'reader.sock');
  const server = svc.serve({ sock, root });
  await new Promise((r) => server.once('listening', r));
  await new Promise((r) => setTimeout(r, 20)); // chmod runs in the listen callback
  try {
    assert.equal(fs.statSync(sock).mode & 0o777, 0o660);
    const reader = createReader({ sock, dir: null });
    assert.equal((await reader.read(a, 0, 5)).data.toString(), 'line1');
    assert.equal((await reader.tail(a, 6)).data.toString(), 'line3\n');
    assert.equal((await reader.stat(a)).size, 18);
    await assert.rejects(reader.stat('/etc/passwd'), { code: 'not_found' });
    // two requests on one connection, garbage in between
    const lines = await new Promise((resolve) => {
      const c = net.connect(sock);
      let buf = '';
      c.on('connect', () => c.write(`${JSON.stringify({ op: 'stat', path: a })}\nnot json\n`));
      c.on('data', (d) => { buf += d; if (buf.split('\n').length > 2) { c.destroy(); resolve(buf.trim().split('\n').map((l) => JSON.parse(l))); } });
    });
    assert.equal(lines[0].ok, true);
    assert.deepEqual(lines[1], { ok: false, error: 'bad_request' });
  } finally { server.close(); }
});

test('client without a socket reports unavailable; direct mode reads CCDASH_READER_DIR', async () => {
  const { tmp, root, a } = layout();
  await assert.rejects(createReader({ sock: path.join(tmp, 'none.sock'), dir: null }).stat(a), { code: 'unavailable' });
  const direct = createReader({ dir: root });
  assert.equal((await direct.read(a, 0, 5)).data.toString(), 'line1');
  await assert.rejects(direct.stat(path.join(tmp, 'secret.txt')), { code: 'not_found' });
});
