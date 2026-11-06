'use strict';
// Stand-in for GitHub and a push service on the egress network (tests/stack/egress.sh).
//   :8080 http  - a git repo "demo.git" over smart http (git http-backend)
//   :8443 https - a push endpoint: logs `PUSH <method> <path> <bytes>` and answers 201
// Everything else it sees goes to stdout, which the test reads with `compose logs standin`.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const { execFileSync, spawn } = require('node:child_process');

const root = '/srv/git';
const sh = (c) => execFileSync('sh', ['-ec', c], { stdio: 'inherit' });
fs.mkdirSync(root, { recursive: true });
sh(`git init -q --bare -b main ${root}/demo.git
    rm -rf /tmp/seed && git clone -q ${root}/demo.git /tmp/seed 2>/dev/null
    cd /tmp/seed && git checkout -q -b main 2>/dev/null || true
    echo one > f && git add f && git -c user.name=seed -c user.email=s@example.com commit -qm one && git push -q origin main`);

function collect(req) {
  return new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); });
}

http.createServer(async (req, res) => {
  const body = await collect(req);
  const u = new URL(req.url, 'http://standin');
  console.log(`GIT ${req.method} ${u.pathname}${u.search}`);
  const cgi = spawn('git', ['http-backend'], {
    env: {
      PATH: process.env.PATH, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: req.method, PATH_INFO: u.pathname,
      QUERY_STRING: u.search.slice(1), CONTENT_TYPE: req.headers['content-type'] || '', CONTENT_LENGTH: String(body.length),
      ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] } : {}),
    },
  });
  const out = [];
  cgi.stdout.on('data', (d) => out.push(d));
  cgi.stdin.on('error', () => {});
  cgi.stdin.end(body);
  cgi.on('close', () => {
    const buf = Buffer.concat(out);
    const i = buf.indexOf('\r\n\r\n');
    const head = buf.subarray(0, i).toString().split('\r\n');
    const headers = {}; let status = 200;
    for (const l of head) {
      const k = l.indexOf(':'); if (k < 0) continue;
      const name = l.slice(0, k).toLowerCase(); const val = l.slice(k + 1).trim();
      if (name === 'status') status = Number(val.split(' ')[0]); else headers[name] = val;
    }
    res.writeHead(status, headers); res.end(buf.subarray(i + 4));
  });
}).listen(8080, '0.0.0.0', () => console.log('git http on 8080'));

https.createServer({ key: fs.readFileSync('/srv/key.pem'), cert: fs.readFileSync('/srv/cert.pem') }, async (req, res) => {
  const body = await collect(req);
  console.log(`PUSH ${req.method} ${req.url} ${body.length}`);
  res.writeHead(201); res.end();
}).listen(8443, '0.0.0.0', () => console.log('push https on 8443'));
