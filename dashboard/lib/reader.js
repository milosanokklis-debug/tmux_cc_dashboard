'use strict';
// Client for ccd-reader (rootfs/usr/local/lib/ccdash/reader.js): reads Claude's transcripts, which
// only user ccd can open. One short connection per request, line-delimited JSON. Without a socket
// (node tests, no s6) CCDASH_READER_DIR makes it read that directory directly, through the same
// request handler the service uses, so the path rules are identical.
const net = require('node:net');
const path = require('node:path');

const DEFAULT_SOCK = '/run/ccdash/reader.sock';
const MAX_LENGTH = 1024 * 1024;
const MAX_RESPONSE = 2 * MAX_LENGTH + 4096; // base64 of MAX_LENGTH plus the envelope

class ReaderError extends Error {
  constructor(code) { super(`reader: ${code}`); this.code = code; }
}

function loadService() {
  for (const p of ['/usr/local/lib/ccdash/reader.js',
    path.join(__dirname, '..', '..', 'rootfs', 'usr', 'local', 'lib', 'ccdash', 'reader.js')]) {
    try { return require(p); } catch { /* try the next */ }
  }
  throw new ReaderError('unavailable');
}

function socketCall(sock, req, timeoutMs) {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    let buf = '';
    let done = false;
    const end = (fn, v) => { if (!done) { done = true; c.destroy(); fn(v); } };
    c.setTimeout(timeoutMs, () => end(reject, new ReaderError('timeout')));
    c.on('error', () => end(reject, new ReaderError('unavailable')));
    c.on('close', () => end(reject, new ReaderError('unavailable')));
    c.on('connect', () => c.write(`${JSON.stringify(req)}\n`));
    c.on('data', (d) => {
      buf += d.toString('utf8');
      if (buf.length > MAX_RESPONSE) return end(reject, new ReaderError('too_large'));
      const nl = buf.indexOf('\n');
      if (nl < 0) return undefined;
      try { return end(resolve, JSON.parse(buf.slice(0, nl))); } catch { return end(reject, new ReaderError('bad_response')); }
    });
  });
}

// opts: { sock, dir (direct mode), timeoutMs }. Defaults from CCDASH_READER_SOCK / CCDASH_READER_DIR.
function createReader({
  sock = process.env.CCDASH_READER_SOCK || DEFAULT_SOCK,
  dir = process.env.CCDASH_READER_DIR || null,
  timeoutMs = 5000,
} = {}) {
  let service = null;
  const call = async (req) => {
    let res;
    if (dir) {
      service ??= loadService();
      res = service.handle(dir, req);
    } else {
      res = await socketCall(sock, req, timeoutMs);
    }
    if (!res || res.ok !== true) throw new ReaderError(typeof res?.error === 'string' ? res.error : 'error');
    return res;
  };
  const withData = (res) => ({ ...res, data: Buffer.from(res.data ?? '', 'base64') });
  return {
    stat: (p) => call({ op: 'stat', path: p }),
    tail: async (p, bytes = 65536) => withData(await call({ op: 'tail', path: p, bytes })),
    read: async (p, offset, length = MAX_LENGTH) => withData(await call({ op: 'read', path: p, offset, length })),
  };
}

module.exports = { createReader, ReaderError, MAX_LENGTH };
