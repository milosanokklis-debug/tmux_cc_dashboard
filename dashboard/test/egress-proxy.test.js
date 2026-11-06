'use strict';
// The egress proxy (egress/proxy.js): allow/deny matching, CONNECT, plain http, live reload of the
// extra-hosts file, the forwarder, and the dashboard's CONNECT client (lib/proxy.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { parseList, createMatcher, createProxy, createForwarder } = require('../../egress/proxy');
const { fetchViaProxy } = require('../lib/proxy');

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'egress-'));

test('matcher: exact, wildcard, ports, comments, case, and reload on change', () => {
  const dir = tmp();
  const f = path.join(dir, 'a.txt'); const extra = path.join(dir, 'extra.txt');
  fs.writeFileSync(f, '# c\napi.github.com\n*.example.org  # trailing\nstandin:8443\nEvil..\n');
  const a = createMatcher({ files: [f, extra], inline: 'inline.test' });
  assert.ok(a('api.github.com', 443) && a('API.GitHub.com.', 80));
  assert.ok(!a('api.github.com', 22) && !a('api.github.com', 8443));
  assert.ok(a('x.example.org', 443) && !a('example.org', 443) && !a('badexample.org', 443));
  assert.ok(a('standin', 8443) && !a('standin', 443));
  assert.ok(a('inline.test', 443));
  assert.ok(!a('github.com', 443) && !a('api.github.com.evil.com', 443));
  assert.ok(!a('late.test', 443));
  fs.writeFileSync(extra, 'late.test\n'); // appended later, no restart
  assert.ok(a('late.test', 443));
  assert.deepStrictEqual(parseList('a b\nok.test\n;;'), [{ wild: false, host: 'ok.test', port: 0 }]);
});

test('the shipped allowlist has the default hosts', () => {
  const a = createMatcher({ files: [path.join(__dirname, '../../egress/allowlist.txt')] });
  for (const h of ['api.anthropic.com', 'console.anthropic.com', 'claude.ai', 'github.com', 'api.github.com', 'registry.npmjs.org',
    'pypi.org', 'files.pythonhosted.org', 'fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']) assert.ok(a(h, 443), h);
  assert.ok(!a('example.com', 443));
});

function connect(proxyPort, target) {
  return new Promise((resolve, reject) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let buf = '';
    s.on('data', (d) => { buf += d; if (buf.includes('\r\n\r\n')) resolve({ status: Number(buf.split(' ')[1]), socket: s }); });
    s.on('error', reject);
  });
}

test('proxy: CONNECT allowed host tunnels, denied host gets 403 and a DENY line', async () => {
  const echo = net.createServer((c) => c.pipe(c));
  const echoPort = await listen(echo);
  const lines = [];
  const proxy = createProxy({ allowed: createMatcher({ inline: `localhost:${echoPort}` }), log: (l) => lines.push(l) });
  const pp = await listen(proxy);
  try {
    const ok = await connect(pp, `localhost:${echoPort}`);
    assert.strictEqual(ok.status, 200);
    const got = await new Promise((r) => { ok.socket.once('data', r); ok.socket.write('ping'); });
    assert.strictEqual(String(got), 'ping');
    ok.socket.destroy();
    const no = await connect(pp, 'example.com:443');
    assert.strictEqual(no.status, 403);
    assert.strictEqual((await connect(pp, `localhost:${echoPort + 1}`)).status, 403); // right host, wrong port
    assert.strictEqual((await connect(pp, 'nonsense')).status, 403);
    assert.deepStrictEqual(lines.slice(0, 2), [`ALLOW localhost:${echoPort}`, 'DENY example.com:443']);
  } finally { proxy.close(); echo.close(); }
});

test('proxy: plain http is forwarded when allowed, refused when not', async () => {
  const web = http.createServer((q, r) => { r.end(`hello ${q.url} ${q.headers['proxy-authorization'] || 'noproxyhdr'}`); });
  const wp = await listen(web);
  const lines = [];
  const proxy = createProxy({ allowed: createMatcher({ inline: `localhost:${wp}` }), log: (l) => lines.push(l) });
  const pp = await listen(proxy);
  const get = (url) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: pp, path: url, headers: { 'proxy-authorization': 'x' } }, (r) => {
      let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve({ status: r.statusCode, b }));
    }).on('error', reject);
  });
  try {
    assert.deepStrictEqual(await get(`http://localhost:${wp}/a?b=1`), { status: 200, b: 'hello /a?b=1 noproxyhdr' });
    assert.strictEqual((await get('http://example.com/')).status, 403);
    assert.strictEqual((await get('/relative')).status, 400);
    assert.ok(lines.includes('DENY example.com:80'));
  } finally { proxy.close(); web.close(); }
});

test('forwarder: bytes pass both ways', async () => {
  const echo = net.createServer((c) => c.pipe(c));
  const ep = await listen(echo);
  const fw = createForwarder({ host: '127.0.0.1', port: ep });
  const fp = await listen(fw);
  try {
    const s = net.connect(fp, '127.0.0.1');
    const got = await new Promise((r) => { s.once('data', r); s.write('hi'); });
    assert.strictEqual(String(got), 'hi');
    s.destroy();
  } finally { fw.close(); echo.close(); }
});

test('fetchViaProxy: HTTPS through CONNECT to an allowed host; a denied host fails', async (t) => {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { return t.skip('openssl not available'); }
  const dir = tmp();
  const key = path.join(dir, 'k.pem'); const crt = path.join(dir, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', crt,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  const srv = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(crt) }, (q, r) => {
    r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ path: q.url, auth: q.headers.authorization }));
  });
  const sp = await listen(srv);
  const lines = [];
  const proxy = createProxy({ allowed: createMatcher({ inline: `localhost:${sp}` }), log: (l) => lines.push(l) });
  const pp = await listen(proxy);
  // The child trusts the test cert only for itself: NODE_EXTRA_CA_CERTS is read at startup.
  const { execFile } = require('node:child_process');
  const script = `const { fetchViaProxy } = require(${JSON.stringify(path.join(__dirname, '../lib/proxy.js'))});
    (async () => {
      const r = await fetchViaProxy('https://localhost:${sp}/x', { headers: { Authorization: 'Bearer t' } }, 'http://127.0.0.1:${pp}');
      console.log(r.status, JSON.stringify(await r.json()));
      try { await fetchViaProxy('https://example.com/', {}, 'http://127.0.0.1:${pp}'); console.log('NOT-REFUSED'); } catch (e) { console.log('refused', e.message); }
    })();`;
  try {
    const out = await new Promise((resolve, reject) => execFile(process.execPath, ['-e', script], { env: { ...process.env, NODE_EXTRA_CA_CERTS: crt } },
      (e, so, se) => (e ? reject(new Error(se || e.message)) : resolve(so))));
    assert.match(out, /^200 \{"path":"\/x","auth":"Bearer t"\}\nrefused proxy refused CONNECT \(HTTP 403\)\n$/);
    assert.ok(lines.includes('DENY example.com:443'));
  } finally { proxy.close(); srv.close(); }
});

test('lib/proxy fetchViaProxy is exported', () => assert.strictEqual(typeof fetchViaProxy, 'function'));
