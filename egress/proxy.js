'use strict';
// ccdash egress proxy: an HTTP CONNECT (and plain http) proxy that only lets the allowlisted hosts
// through, plus a TCP forwarder so the published port can reach the dashboard on the internal
// network. No dependencies; runs on the pinned node image.
//
// Env: EGRESS_ALLOWLIST (default /app/allowlist.txt), EGRESS_EXTRA_FILE (default /data/extra.txt,
// appended to by host/ccdash-egress-allow; re-read whenever it changes, so no reload is needed),
// EGRESS_EXTRA_HOSTS (comma separated, for compose), EGRESS_PORT (3128),
// EGRESS_FORWARD ("7690=ccdash:7690": listen port = target host:port; empty for none).
// Log: one line per request, `ALLOW host:port` or `DENY host:port`.
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');

function parseList(text) {
  const out = [];
  for (const raw of String(text).split(/[\n,]/)) {
    const line = raw.replace(/#.*/, '').trim().toLowerCase();
    if (!line) continue;
    const m = /^(\*\.)?([a-z0-9]([a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?$/.exec(line);
    if (m) out.push({ wild: !!m[1], host: m[2], port: m[4] ? Number(m[4]) : 0 });
  }
  return out;
}

// files are re-read when their mtime changes; `inline` is a fixed list (env).
function createMatcher({ files = [], inline = '' } = {}) {
  const cache = new Map(); // file -> { key, entries }
  const fixed = parseList(inline);
  const entriesOf = (f) => {
    let key = 'none';
    try { const st = fs.statSync(f); key = `${st.mtimeMs}:${st.size}`; } catch { /* missing file: no entries */ }
    const c = cache.get(f);
    if (c && c.key === key) return c.entries;
    let entries = [];
    if (key !== 'none') { try { entries = parseList(fs.readFileSync(f, 'utf8')); } catch { /* unreadable */ } }
    cache.set(f, { key, entries });
    return entries;
  };
  return function allowed(host, port) {
    host = String(host).toLowerCase().replace(/\.$/, '');
    for (const e of [...files.flatMap(entriesOf), ...fixed]) {
      const hostOk = e.wild ? host.endsWith(`.${e.host}`) : host === e.host;
      if (hostOk && (e.port ? e.port === port : port === 443 || port === 80)) return true;
    }
    return false;
  };
}

function createProxy({ allowed, log = console.log, connectTimeoutMs = 15000 }) {
  const server = http.createServer((req, res) => {
    let u;
    try { u = new URL(req.url); } catch { u = null; }
    if (!u || u.protocol !== 'http:') { res.writeHead(400); return res.end('ccdash-egress: use CONNECT or an absolute http:// URL\n'); }
    const port = Number(u.port || 80);
    if (!allowed(u.hostname, port)) {
      log(`DENY ${u.hostname}:${port}`);
      res.writeHead(403); return res.end('ccdash-egress: host not allowed\n');
    }
    log(`ALLOW ${u.hostname}:${port}`);
    const headers = { ...req.headers, host: u.host }; // the allowlisted host, not the client's Host
    for (const h of Object.keys(headers)) if (h.startsWith('proxy-')) delete headers[h];
    const up = http.request({ host: u.hostname, port, method: req.method, path: u.pathname + u.search, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers); r.pipe(res);
    });
    up.setTimeout(connectTimeoutMs * 4, () => up.destroy());
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  server.on('connect', (req, client, head) => {
    const m = /^([^:\[\]]+):([0-9]{1,5})$/.exec(req.url || '');
    const host = m && m[1]; const port = m && Number(m[2]);
    if (!m || !allowed(host, port)) {
      log(`DENY ${m ? `${host}:${port}` : 'malformed'}`);
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    log(`ALLOW ${host}:${port}`);
    const up = net.connect({ host, port });
    const fail = () => { if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); up.destroy(); };
    up.setTimeout(connectTimeoutMs, fail);
    up.once('connect', () => {
      up.setTimeout(0);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(client); client.pipe(up);
    });
    up.on('error', () => { if (up.connecting) fail(); else client.destroy(); });
    client.on('error', () => up.destroy());
    client.on('close', () => up.destroy());
    up.on('close', () => client.destroy());
  });
  server.on('clientError', (e, s) => { if (s.writable) s.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
  return server;
}

// TCP forwarder: `listen` port on all interfaces -> host:port (the dashboard on the internal network).
function createForwarder({ port, host }) {
  return net.createServer((c) => {
    const up = net.connect({ host, port });
    up.on('error', () => c.destroy());
    c.on('error', () => up.destroy());
    c.on('close', () => up.destroy());
    up.on('close', () => c.destroy());
    c.pipe(up); up.pipe(c);
  });
}

function main(env = process.env) {
  const allowed = createMatcher({
    files: [env.EGRESS_ALLOWLIST || '/app/allowlist.txt', env.EGRESS_EXTRA_FILE || '/data/extra.txt'],
    inline: env.EGRESS_EXTRA_HOSTS || '',
  });
  const port = Number(env.EGRESS_PORT || 3128);
  createProxy({ allowed }).listen(port, '0.0.0.0', () => console.log(`egress proxy listening on ${port}`));
  const m = /^([0-9]+)=([^:]+):([0-9]+)$/.exec(env.EGRESS_FORWARD || '');
  if (m) createForwarder({ port: Number(m[3]), host: m[2] }).listen(Number(m[1]), '0.0.0.0', () => console.log(`forwarding ${m[1]} to ${m[2]}:${m[3]}`));
}

if (require.main === module) main();
module.exports = { parseList, createMatcher, createProxy, createForwarder };
