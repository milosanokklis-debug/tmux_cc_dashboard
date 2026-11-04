'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const authstore = require('../lib/authstore');
const h = require('./helpers');
const { req, login, POST_HEADERS, ORIGIN } = h;

test('no auth.json: only /healthz works, everything else says run ccd passwd, login refused', async (t) => {
  const s = await h.start({ withAuth: false });
  t.after(s.stop);
  assert.strictEqual(await (await req(s.base, '/healthz')).text(), 'ok\n');
  for (const p of ['/', '/login', '/whatever']) {
    const r = await req(s.base, p);
    assert.strictEqual(r.status, 503);
    assert.match(await r.text(), /ccd passwd/);
  }
  const api = await req(s.base, '/api/x');
  assert.strictEqual(api.status, 503);
  const l = await login(s.base);
  assert.strictEqual(l.status, 503);
  assert.ok(!l.headers.get('set-cookie'));
});

test('auth.json created later is picked up without restart', async (t) => {
  const s = await h.start({ withAuth: false });
  t.after(s.stop);
  assert.strictEqual((await req(s.base, '/login')).status, 503);
  await authstore.setCredentials({ dir: s.dir, username: h.USER, password: h.PASS, hashOptions: h.FAST });
  assert.strictEqual((await req(s.base, '/login')).status, 200);
});

test('security headers on every response', async (t) => {
  const s = await h.start();
  t.after(s.stop);
  for (const p of ['/healthz', '/login', '/', '/api/x', '/assets/login.js', '/nope']) {
    const r = await req(s.base, p);
    assert.strictEqual(r.headers.get('content-security-policy'),
      "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", p);
    assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(r.headers.get('referrer-policy'), 'no-referrer');
    assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    assert.strictEqual(r.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.strictEqual(r.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.match(r.headers.get('permissions-policy'), /camera=\(\).*microphone=\(\).*geolocation=\(\)/);
    assert.ok(!r.headers.get('strict-transport-security'));
    await r.arrayBuffer();
  }
});

test('pages and assets contain no inline script/style and no external hosts', async () => {
  const dir = path.join(__dirname, '..', 'public');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/<script(?![^>]*\bsrc=)/i.test(src), `${f}: inline script`);
    assert.ok(!/<style|\sstyle=|\son\w+=/i.test(src), `${f}: inline style/handler`);
    assert.ok(!/https?:\/\//.test(src), `${f}: external URL`);
  }
});

test('default deny: unauth pages redirect to /login, /api/* gives 401 JSON', async (t) => {
  const s = await h.start();
  t.after(s.stop);
  const r = await req(s.base, '/');
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.get('location'), '/login');
  assert.strictEqual((await req(s.base, '/anything')).status, 302);
  const a = await req(s.base, '/api/x');
  assert.strictEqual(a.status, 401);
  assert.deepStrictEqual(await a.json(), { error: 'unauthorized' });
  assert.strictEqual((await req(s.base, '/api/x', { method: 'POST', headers: POST_HEADERS })).status, 401);
  assert.strictEqual((await req(s.base, '/login')).status, 200);
  assert.strictEqual((await req(s.base, '/assets/login.js')).status, 200);
  assert.strictEqual((await req(s.base, '/assets/server.js')).status, 404);
  assert.strictEqual((await req(s.base, '/assets/../server.js')).status, 302); // normalised to /server.js: default deny
  const lo = await req(s.base, '/logout', { method: 'POST', headers: POST_HEADERS });
  assert.strictEqual(lo.status, 302); // unauthenticated logout is not allowed (redirected to login)
});

test('login success: cookie attributes, signed-in page, then logout', async (t) => {
  const s = await h.start();
  t.after(s.stop);
  const r = await login(s.base);
  assert.strictEqual(r.status, 200);
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /^__Host-ccdash=[A-Za-z0-9_-]{43};/);
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(sc.includes(attr), attr);
  assert.ok(!/Domain/i.test(sc));
  const cookie = sc.split(';')[0];
  const page = await req(s.base, '/', { cookie });
  assert.strictEqual(page.status, 200);
  assert.match(await page.text(), /ccdash — signed in/);
  assert.strictEqual((await req(s.base, '/login', { cookie })).status, 302);
  const out = await req(s.base, '/logout', { method: 'POST', headers: POST_HEADERS, cookie });
  assert.strictEqual(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.strictEqual((await req(s.base, '/', { cookie })).status, 302);
});

test('unknown user and wrong password give identical responses', async (t) => {
  const s = await h.start();
  t.after(s.stop);
  const a = await login(s.base, {}, { username: 'nobody', password: h.PASS });
  const b = await login(s.base, {}, { username: h.USER, password: 'wrong password!!' });
  assert.strictEqual(a.status, 401);
  assert.strictEqual(b.status, 401);
  assert.strictEqual(await a.text(), await b.text());
  assert.ok(!a.headers.get('set-cookie') && !b.headers.get('set-cookie'));
});

test('Origin and X-CCDash enforced on state-changing requests', async (t) => {
  const s = await h.start();
  t.after(s.stop);
  const creds = { username: h.USER, password: h.PASS };
  const cases = [
    { 'x-ccdash': '1' },                                   // missing Origin
    { origin: 'https://evil.example', 'x-ccdash': '1' },   // wrong Origin
    { origin: ORIGIN },                                    // missing X-CCDash
    { origin: ORIGIN, 'x-ccdash': '0' },
  ];
  for (const headers of cases) {
    const r = await req(s.base, '/login', { method: 'POST', headers, json: creds });
    assert.strictEqual(r.status, 403, JSON.stringify(headers));
    assert.ok(!r.headers.get('set-cookie'));
  }
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    assert.strictEqual((await req(s.base, '/api/x', { method, headers: { 'x-ccdash': '1' } })).status, 403);
  }
  const cookie = await h.loginCookie(s.base);
  assert.strictEqual((await req(s.base, '/logout', { method: 'POST', headers: { 'x-ccdash': '1' }, cookie })).status, 403);
  assert.strictEqual((await req(s.base, '/', { cookie })).status, 200); // still signed in
  const tunnel = await req(s.base, '/login', { method: 'POST', headers: { origin: 'http://localhost:7690', 'x-ccdash': '1' }, json: creds });
  assert.strictEqual(tunnel.status, 200);
});

test('bad bodies: invalid JSON -> 400, oversize -> 413', async (t) => {
  const s = await h.start();
  t.after(s.stop);
  const bad = await req(s.base, '/login', { method: 'POST', headers: POST_HEADERS, body: '{nope' });
  assert.strictEqual(bad.status, 400);
  const wrongType = await req(s.base, '/login', { method: 'POST', headers: POST_HEADERS, json: { username: 1, password: 2 } });
  assert.strictEqual(wrongType.status, 400);
  const big = await req(s.base, '/login', { method: 'POST', headers: POST_HEADERS, body: JSON.stringify({ username: 'a', password: 'x'.repeat(9000) }) });
  assert.strictEqual(big.status, 413);
});

test('rate limit: delay after 5 failures, global lockout after 50, CF-Connecting-IP used', async (t) => {
  const s = await h.start();
  t.after(s.stop);
  const bad = { username: h.USER, password: 'nope nope nope nope' };
  for (let i = 0; i < 5; i++) await login(s.base, { 'cf-connecting-ip': '203.0.113.5' }, bad);
  assert.deepStrictEqual(s.delays, []);
  await login(s.base, { 'cf-connecting-ip': '203.0.113.5' }, bad);
  assert.deepStrictEqual(s.delays, [1000]);
  await login(s.base, { 'cf-connecting-ip': '203.0.113.6' }, bad); // different client: no delay
  assert.deepStrictEqual(s.delays, [1000]);
  // drive the global counter to 50
  for (let i = 0; i < 60; i++) await login(s.base, { 'cf-connecting-ip': `198.51.100.${i}` }, bad);
  const locked = await login(s.base, { 'cf-connecting-ip': '192.0.2.1' }); // correct credentials, still refused
  assert.strictEqual(locked.status, 429);
  assert.ok(locked.headers.get('retry-after'));
  assert.ok(!locked.headers.get('set-cookie'));
  s.clock.advance(15 * 60 * 1000 + 1);
  assert.strictEqual((await login(s.base, { 'cf-connecting-ip': '192.0.2.1' })).status, 200);
});

test('session expiry through the server (injected clock)', async (t) => {
  const s = await h.start();
  t.after(s.stop);
  const cookie = await h.loginCookie(s.base);
  s.clock.advance(11 * 3600e3);
  assert.strictEqual((await req(s.base, '/', { cookie })).status, 200);
  s.clock.advance(12 * 3600e3 + 1);
  assert.strictEqual((await req(s.base, '/', { cookie })).status, 302);
  assert.strictEqual((await req(s.base, '/api/x', { cookie })).status, 401);
});

test('password change ends existing sessions and closes sockets', async (t) => {
  const s = await h.start();
  t.after(s.stop);
  const cookie = await h.loginCookie(s.base);
  const key = s.app.sessions.keyOf(cookie.split('=')[1]);
  const { PassThrough } = require('node:stream');
  const sock = new PassThrough();
  s.app.registry.add(key, sock);
  await authstore.setCredentials({ dir: s.dir, username: h.USER, password: 'brand new password', hashOptions: h.FAST });
  assert.strictEqual((await req(s.base, '/', { cookie })).status, 302);
  assert.ok(sock.destroyed);
});

test('Origin must match exactly: null, suffix/prefix, port, trailing slash, case, scheme', async (t) => {
  const s = await h.start();
  t.after(s.stop);
  const creds = { username: h.USER, password: h.PASS };
  const bad = [
    'null', `${ORIGIN}.evil.example`, 'https://evil.example/https://ccdash.example.com', 'https://ccdash.example.com.evil.com',
    'https://evilccdash.example.com', 'https://ccdash.example.com:8443', `${ORIGIN}/`, ORIGIN.toUpperCase(),
    'http://ccdash.example.com', 'http://localhost:7691', 'http://localhost', 'http://localhost:7690/', '',
  ];
  for (const origin of bad) {
    const r = await req(s.base, '/login', { method: 'POST', headers: { origin, 'x-ccdash': '1' }, json: creds });
    assert.strictEqual(r.status, 403, JSON.stringify(origin));
    assert.ok(!r.headers.get('set-cookie'));
  }
  assert.strictEqual((await login(s.base)).status, 200);
});

test('rotating or spoofed CF-Connecting-IP still hits the global lockout', async (t) => {
  const s = await h.start();
  t.after(s.stop);
  const bad = { username: h.USER, password: 'nope nope nope nope' };
  for (let i = 0; i < 50; i++) await login(s.base, { 'cf-connecting-ip': `2001:db8::${i.toString(16)}` }, bad);
  assert.strictEqual((await login(s.base, { 'cf-connecting-ip': '8.8.8.8' })).status, 429);
});

test('invalid CF-Connecting-IP falls back to the socket address', async (t) => {
  const s = await h.start();
  t.after(s.stop);
  const bad = { username: h.USER, password: 'nope nope nope nope' };
  for (const v of ['not-an-ip', '1.2.3.4, 5.6.7.8', '999.1.1.1', 'a'.repeat(100), '']) {
    await login(s.base, { 'cf-connecting-ip': v }, bad);
  }
  assert.deepStrictEqual([...s.app.limiter.perClient.keys()], ['127.0.0.1']);
  await login(s.base, { 'cf-connecting-ip': '203.0.113.9' }, bad);
  assert.ok(s.app.limiter.perClient.has('203.0.113.9'));
});

test('odd paths: traversal, wrong extension, double slash, malformed targets are never 500', async (t) => {
  const s = await h.start();
  t.after(s.stop);
  for (const p of ['/assets/..%2f', '/assets/..%2fserver.js', '/assets/%2e%2e/server.js', '/assets/x.html', '/assets/', '/assets',
    '/assets/login.js/', '/assets/LOGIN.JS', '/assets/%00.js', '/assets/a%2fb.js', '/%', '/%zz', '/a%00b']) {
    const r = await req(s.base, p);
    assert.ok(r.status < 500, `${p} -> ${r.status}`);
    if (p.startsWith('/assets/') && !p.startsWith('/assets/login')) assert.ok([302, 404].includes(r.status), `${p} -> ${r.status}`);
    await r.arrayBuffer();
  }
  // "//host/path" is a plain path, not an authority: default deny
  const dbl = await req(s.base, '//evil.example/path');
  assert.strictEqual(dbl.status, 302);
  assert.strictEqual(dbl.headers.get('location'), '/login');
  // the served asset is fine but nothing outside public/ is reachable
  assert.strictEqual((await req(s.base, '/assets/login.js')).status, 200);
});

function rawRequest(port, text) {
  return new Promise((resolve) => {
    const sock = require('node:net').connect(port, '127.0.0.1', () => sock.write(text));
    let out = '';
    sock.on('data', (d) => { out += d; });
    sock.on('close', () => resolve(out));
    sock.on('error', () => resolve(out));
    setTimeout(() => sock.destroy(), 1500);
  });
}

test('malformed request targets answer 400, not 500', async (t) => {
  const s = await h.start();
  t.after(s.stop);
  const port = new URL(s.base).port;
  for (const target of ['http://[', '*', 'http://evil.example/']) {
    const out = await rawRequest(port, `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    assert.match(out, /^HTTP\/1\.1 400 /, `${target}: ${out.slice(0, 40)}`);
  }
});

test('oversized headers are refused (431) and the server keeps working', async (t) => {
  const s = await h.start();
  t.after(s.stop);
  const out = await rawRequest(new URL(s.base).port, `GET / HTTP/1.1\r\nHost: x\r\nX-Big: ${'a'.repeat(20000)}\r\nConnection: close\r\n\r\n`);
  assert.match(out, /^HTTP\/1\.1 431 /);
  assert.strictEqual((await req(s.base, '/healthz')).status, 200);
});

test('tampered, truncated, overlong and duplicate session cookies are rejected', async (t) => {
  const s = await h.start();
  t.after(s.stop);
  const cookie = await h.loginCookie(s.base);
  const id = cookie.split('=')[1];
  const flipped = id.slice(0, -1) + (id.endsWith('A') ? 'B' : 'A');
  for (const c of [`__Host-ccdash=${flipped}`, `__Host-ccdash=${id.slice(0, 20)}`, `__Host-ccdash=${'A'.repeat(5000)}`,
    `__Host-ccdash=`, `ccdash=${id}`, `__Host-ccdash=${id}x`]) {
    const r = await req(s.base, '/', { cookie: c });
    assert.strictEqual(r.status, 302, c.slice(0, 40));
    assert.strictEqual((await req(s.base, '/api/x', { cookie: c })).status, 401);
  }
  assert.strictEqual((await req(s.base, '/', { cookie })).status, 200);
  // first value wins, so a later forged duplicate cannot replace a real cookie
  assert.strictEqual((await req(s.base, '/', { cookie: `${cookie}; __Host-ccdash=forged` })).status, 200);
  // a cookie bigger than the header limit is refused outright
  const huge = await req(s.base, '/', { cookie: `__Host-ccdash=${'A'.repeat(30000)}` }).catch(() => ({ status: 431 }));
  assert.ok([431, 400].includes(huge.status));
});

test('HEAD requests: no body, same status rules, never create sessions', async (t) => {
  const s = await h.start();
  t.after(s.stop);
  const cookie = await h.loginCookie(s.base);
  for (const [p, c, status] of [['/healthz', undefined, 200], ['/login', undefined, 200], ['/', undefined, 302],
    ['/api/x', undefined, 401], ['/', cookie, 200], ['/nope', cookie, 404]]) {
    const r = await req(s.base, p, { method: 'HEAD', cookie: c });
    assert.strictEqual(r.status, status, `${p} ${c ? 'authed' : 'anon'}`);
    assert.strictEqual((await r.text()), '');
    assert.ok(!r.headers.get('set-cookie'));
  }
  // HEAD /logout must not log out
  await req(s.base, '/logout', { method: 'HEAD', cookie });
  assert.strictEqual((await req(s.base, '/', { cookie })).status, 200);
});

test('corrupt or empty auth.json at startup: server starts, refuses everything, recovers when fixed', async (t) => {
  for (const body of ['', '{broken', '{"username":"a"}']) {
    const s = await h.start({ authJson: body });
    s.app.refreshAuth();
    t.after(s.stop);
    assert.strictEqual((await req(s.base, '/healthz')).status, 200);
    assert.strictEqual((await req(s.base, '/login')).status, 503);
    assert.strictEqual((await login(s.base)).status, 503);
    await authstore.setCredentials({ dir: s.dir, username: h.USER, password: h.PASS, hashOptions: h.FAST });
    assert.strictEqual((await h.login(s.base)).status, 200);
  }
});

test('auth.json corrupted while running: tick and requests do not throw, old state is kept', async (t) => {
  const s = await h.start();
  t.after(s.stop);
  const cookie = await h.loginCookie(s.base);
  fs.writeFileSync(path.join(s.dir, 'auth.json'), '{"username":"a","hash":"SECRETHASH"');
  s.app.tick();
  s.app.tick();
  assert.strictEqual((await req(s.base, '/', { cookie })).status, 200); // existing session unaffected
  assert.strictEqual((await login(s.base)).status, 200);                // old credentials still verify
  fs.writeFileSync(path.join(s.dir, 'auth.json'), '');
  s.app.tick();
  const sock = new (require('node:stream').PassThrough)();
  s.app.onUpgrade({ headers: {} }, sock); // upgrade path with a broken file must not throw
  assert.ok(sock.destroyed); // refused, not crashed
  // fixing the file ends old sessions through the new generation
  await authstore.setCredentials({ dir: s.dir, username: h.USER, password: 'another long password', hashOptions: h.FAST });
  assert.strictEqual((await req(s.base, '/', { cookie })).status, 302);
});

test('password changed while a login is verifying: no session is issued', async (t) => {
  const s = await h.start();
  t.after(s.stop);
  const orig = authstore.verifyLogin;
  let release;
  const gate = new Promise((r) => { release = r; });
  let entered;
  const inVerify = new Promise((r) => { entered = r; });
  authstore.verifyLogin = async (...a) => { entered(); await gate; return orig(...a); };
  try {
    const pending = login(s.base); // correct old credentials
    await inVerify;
    await authstore.setCredentials({ dir: s.dir, username: h.USER, password: 'a different password', hashOptions: h.FAST });
    release();
    const r = await pending;
    assert.notStrictEqual(r.status, 200);
    assert.ok(!r.headers.get('set-cookie'));
    assert.strictEqual(s.app.sessions.map.size, 0);
  } finally { authstore.verifyLogin = orig; }
});

test('socket errors on upgraded or registered sockets do not throw', () => {
  const { EventEmitter } = require('node:events');
  const { SocketRegistry } = require('../lib/registry');
  const reg = new SocketRegistry();
  const sock = new EventEmitter();
  reg.add('k', sock);
  assert.doesNotThrow(() => sock.emit('error', new Error('ECONNRESET')));
});
