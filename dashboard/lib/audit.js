'use strict';
// Audit log: JSON lines {ts, event, ...fields} in <dir>/audit.log (mode 0600). Ids and outcomes only:
// fields outside the whitelist are dropped, and values must be short plain strings/numbers, so a
// prompt, tool input, token, secret or code can never reach the file. The user agent is not logged.
// Rotation: at maxBytes audit.log becomes audit.log.1 (older ones shift up); audit.log.<keep-1> is
// the oldest, so `keep` = 5 means 5 files in total (audit.log plus audit.log.1 .. audit.log.4).
const fs = require('node:fs');
const path = require('node:path');

const FIELDS = new Set(['ip', 'outcome', 'reason', 'project', 'window', 'sid', 'request', 'session', 'old', 'new']);
const MAX_VALUE = 100;
const SAFE = /^[A-Za-z0-9._:@\/-]*$/; // ids, ips, names, codes: no spaces, quotes or free text

function clean(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (!FIELDS.has(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string' && v.length <= MAX_VALUE && SAFE.test(v)) out[k] = v;
  }
  return out;
}

function createAudit({ dir = '/var/lib/ccdash-web', maxBytes = 10 * 1024 * 1024, keep = 5 } = {}) {
  const file = path.join(dir, 'audit.log');

  function rotate() {
    for (let i = keep - 1; i >= 1; i--) {
      const from = i === 1 ? file : `${file}.${i - 1}`;
      const to = `${file}.${i}`;
      try { fs.renameSync(from, to); } catch { /* absent */ }
    }
  }

  function log(event, fields) {
    try {
      const line = `${JSON.stringify({ ts: new Date().toISOString(), event: String(event), ...clean(fields) })}\n`;
      let size = 0;
      try { size = fs.statSync(file).size; } catch { /* new file */ }
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) rotate();
      const fd = fs.openSync(file, 'a', 0o600);
      try { fs.fchmodSync(fd, 0o600); fs.writeSync(fd, line); } finally { fs.closeSync(fd); }
    } catch (e) {
      console.error('audit log write failed:', e.code || e.message);
    }
  }
  return { log, file };
}

module.exports = { createAudit };
