#!/usr/bin/env node
'use strict';
// ccd-reader: a tiny read-only service that runs as ccd and lets the dashboard (user web, group
// ccd) read Claude's transcripts, which are 0600 inside a 0700 projects/ directory.
// Protocol: one JSON object per line over a unix socket, one JSON answer per line.
//   {op:"stat", path}                        -> {ok, size, inode, mtimeMs}
//   {op:"tail", path, bytes}                 -> {ok, data(base64), offset, size, inode}
//   {op:"read", path, offset, length}        -> {ok, data(base64), offset, size, inode}
// Every path is resolved with realpath and must be a regular file inside ROOT (compared with a
// trailing separator, so projects-evil is not projects). Errors never repeat a path.
// Allowed roots: the default root plus <config root>/<project>/projects for every real (non-symlink) project
// config dir, found on each request so a new project needs no restart. A path must resolve inside one of them.
// Standard library only. Env: CCDASH_READER_SOCK, CCDASH_READER_ROOT, CCDASH_CONFIG_ROOT (overridable for tests).
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const DEFAULT_ROOT = '/home/ccd/.claude/projects';
const DEFAULT_CONFIG_ROOT = '/home/ccd/.claude-projects';
const DEFAULT_SOCK = '/run/ccdash/reader.sock';
const MAX_LENGTH = 1024 * 1024; // bytes per read/tail
const MAX_REQUEST = 8 * 1024; // bytes per request line
const MAX_CONNECTIONS = 32;
const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW;

class ReadError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const PROJECT_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const isRealDir = (d) => { try { return fs.lstatSync(d).isDirectory(); } catch { return false; } };

// Roots of the project config dirs. A config dir or its projects dir that is a symlink is skipped, so a
// link cannot point the reader at some other directory.
function projectRoots(base = process.env.CCDASH_CONFIG_ROOT || DEFAULT_CONFIG_ROOT) {
  let names;
  try { names = fs.readdirSync(base); } catch { return []; }
  const out = [];
  for (const n of names.sort()) {
    if (!PROJECT_NAME.test(n) || n.includes('..')) continue;
    const d = path.join(base, n);
    const projects = path.join(d, 'projects');
    if (isRealDir(d) && isRealDir(projects)) out.push(projects);
  }
  return out;
}
const defaultRoots = (root = process.env.CCDASH_READER_ROOT || DEFAULT_ROOT) => [root, ...projectRoots()];
// `root` is a path, a list of paths or a function returning one of those
const rootList = (root) => [].concat(typeof root === 'function' ? root() : root);

// Real path of `p` when it names an existing entry inside one of `roots`; throws ReadError('not_found')
// for everything else (relative, NUL, missing, outside, symlink escape), so a caller cannot
// tell a file outside the root from one that does not exist.
function resolveInside(roots, p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096 || p.includes('\0') || !path.isAbsolute(p)) {
    throw new ReadError('bad_path');
  }
  let real;
  try { real = fs.realpathSync(p); } catch { throw new ReadError('not_found'); }
  for (const root of rootList(roots)) {
    let base;
    try { base = fs.realpathSync(root); } catch { continue; }
    if (real.startsWith(base.endsWith(path.sep) ? base : base + path.sep)) return real;
  }
  throw new ReadError('not_found');
}

const int = (v, min, max, dflt) => {
  if (v === undefined) return dflt;
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new ReadError('bad_args');
  return v;
};

// Opens the resolved path without following a final symlink and without blocking; the
// descriptor must be a regular file. Runs fn(fd, stat).
function withFile(root, p, fn) {
  const real = resolveInside(root, p);
  let fd;
  try {
    try { fd = fs.openSync(real, OPEN_FLAGS); } catch { throw new ReadError('not_found'); }
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new ReadError('not_regular');
    return fn(fd, st);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* closed */ } }
  }
}

function readAt(fd, st, offset, length) {
  const len = Math.max(0, Math.min(length, st.size - offset));
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, offset + got);
    if (n === 0) break;
    got += n;
  }
  return { ok: true, data: buf.subarray(0, got).toString('base64'), offset, length: got, size: st.size, inode: st.ino };
}

// One request object -> one answer object. Never throws.
function handle(root, req) {
  try {
    if (!req || typeof req !== 'object' || Array.isArray(req)) throw new ReadError('bad_request');
    switch (req.op) {
      case 'stat':
        return withFile(root, req.path, (fd, st) => ({ ok: true, size: st.size, inode: st.ino, mtimeMs: st.mtimeMs }));
      case 'tail':
        return withFile(root, req.path, (fd, st) => {
          const bytes = int(req.bytes, 0, MAX_LENGTH, 65536);
          const offset = Math.max(0, st.size - bytes);
          return readAt(fd, st, offset, bytes);
        });
      case 'read':
        return withFile(root, req.path, (fd, st) => {
          const offset = int(req.offset, 0, Number.MAX_SAFE_INTEGER, undefined);
          if (offset === undefined) throw new ReadError('bad_args');
          return readAt(fd, st, offset, int(req.length, 0, MAX_LENGTH, MAX_LENGTH));
        });
      default:
        throw new ReadError('bad_op');
    }
  } catch (e) {
    return { ok: false, error: e instanceof ReadError ? e.code : 'error' };
  }
}

function serve({ sock = DEFAULT_SOCK, root = defaultRoots, log = console.error } = {}) {
  try { fs.unlinkSync(sock); } catch { /* none */ }
  let open = 0;
  const server = net.createServer((c) => {
    if (open >= MAX_CONNECTIONS) { c.destroy(); return; }
    open++;
    c.on('close', () => { open--; });
    c.on('error', () => {});
    c.setTimeout(10000, () => c.destroy());
    let buf = '';
    c.setEncoding('utf8');
    // Answers the complete lines in buf; stops (and returns) when the peer is not taking replies.
    const pump = () => {
      let nl;
      while (!c.destroyed && (nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let req = null;
        try { req = JSON.parse(line); } catch { /* answered as bad_request */ }
        if (!c.write(`${JSON.stringify(handle(root, req))}\n`)) {
          c.pause(); // backpressure: no more requests until the replies are taken
          c.once('drain', () => { c.resume(); pump(); });
          return;
        }
      }
      if (buf.length > MAX_REQUEST) { buf = ''; c.end(`${JSON.stringify({ ok: false, error: 'too_large' })}\n`); c.destroy(); }
    };
    c.on('data', (d) => { buf += d; pump(); });
  });
  const prev = process.umask(0o007); // the socket is created 0660
  server.listen(sock, () => {
    process.umask(prev);
    try { fs.chmodSync(sock, 0o660); } catch (e) { log('reader: chmod failed:', e.message); }
  });
  server.on('error', (e) => { log('reader:', e.message); process.exit(1); });
  return server;
}

module.exports = { handle, serve, defaultRoots, MAX_LENGTH };

if (require.main === module) {
  serve({ sock: process.env.CCDASH_READER_SOCK || DEFAULT_SOCK });
}
