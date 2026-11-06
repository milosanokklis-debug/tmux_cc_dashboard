'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const totp = require('../lib/totp');
const authstore = require('../lib/authstore');
const { enrollTotp, removeTotp } = require('../ccdash-passwd');
const h = require('./helpers');

const { FAST, ORIGIN, POST_HEADERS } = h;
const SEED = Buffer.from('12345678901234567890');
const B32 = totp.base32Encode(SEED);

test('RFC 6238 vectors (SHA1) and base32 round trip', () => {
  for (const [t, c] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037']]) {
    assert.strictEqual(totp.hotp(SEED, Math.floor(t / 30), 8), c);
  }
  assert.strictEqual(B32, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepStrictEqual(totp.base32Decode(B32), SEED);
  assert.strictEqual(totp.generateSecret().length, 32);
});

test('verify accepts +-1 step, returns the step, rejects others', () => {
  const now = 1_700_000_000_000;
  const cur = totp.stepAt(now);
  for (const d of [-1, 0, 1]) assert.strictEqual(totp.verify(B32, totp.hotp(B32, cur + d), now), cur + d);
  assert.strictEqual(totp.verify(B32, totp.hotp(B32, cur + 2), now), null);
  assert.strictEqual(totp.verify(B32, totp.hotp(B32, cur - 2), now), null);
  assert.strictEqual(totp.verify(B32, 'abcdef', now), null);
  assert.match(totp.otpauthUri({ secret: B32, account: 'a b' }), /^otpauth:\/\/totp\/ccdash:a%20b\?secret=GEZ.*&issuer=ccdash/);
});

async function withTotp(t, opts = {}) {
  const s = await h.start(opts);
  t.after(s.stop);
  const secret = totp.generateSecret();
  const codes = await authstore.enableTotp({ dir: s.dir, secret, step: 0, hashOptions: FAST });
  s.app.refreshAuth();
  const code = (d = 0) => totp.hotp(secret, totp.stepAt(s.clock.now()) + d);
  const tryLogin = (extra) => h.login(s.base, {}, { username: h.USER, password: h.PASS, ...extra });
  return { s, secret, codes, code, tryLogin };
}

test('password without code: 401 {totp:true}, no session, not counted as a failure', async (t) => {
  const { s, tryLogin } = await withTotp(t);
  for (let i = 0; i < 8; i++) {
    const r = await tryLogin({});
    assert.strictEqual(r.status, 401);
    assert.strictEqual((await r.json()).totp, true);
    assert.strictEqual(r.headers.get('set-cookie'), null);
  }
  assert.deepStrictEqual(s.delays, []);
  assert.strictEqual(s.app.limiter.global.length, 0);
});

test('wrong code refused and counted; right code works; reuse refused; auth.json is 0600', async (t) => {
  const { s, code, tryLogin } = await withTotp(t);
  const bad = await tryLogin({ code: '000000' });
  assert.strictEqual(bad.status, 401);
  assert.strictEqual((await bad.json()).totp, undefined);
  assert.strictEqual(s.app.limiter.global.length, 1);
  const c = code(0);
  const ok = await tryLogin({ code: c });
  assert.strictEqual(ok.status, 200);
  assert.ok(ok.headers.get('set-cookie'));
  assert.strictEqual((await tryLogin({ code: c })).status, 401); // same step
  assert.strictEqual((await tryLogin({ code: code(-1) })).status, 401); // older step
  assert.strictEqual((await tryLogin({ code: code(1) })).status, 200); // newer step ok
  assert.strictEqual(fs.statSync(path.join(s.dir, 'auth.json')).mode & 0o777, 0o600);
  assert.ok(s.app.limiter.global.length >= 3);
});

test('wrong password with a valid code is still refused', async (t) => {
  const { code, tryLogin } = await withTotp(t);
  assert.strictEqual((await tryLogin({ password: 'wrong password!!', code: code() })).status, 401);
});

test('repeated wrong codes hit the global lockout', async (t) => {
  const { s, tryLogin } = await withTotp(t);
  let last;
  for (let i = 0; i < 51; i++) last = await tryLogin({ code: '111111' });
  assert.strictEqual(last.status, 429);
});

test('recovery code works once then is refused; password change keeps TOTP', async (t) => {
  const { s, codes, tryLogin } = await withTotp(t);
  assert.strictEqual(codes.length, 10);
  assert.strictEqual((await tryLogin({ code: codes[3] })).status, 200);
  assert.strictEqual((await tryLogin({ code: codes[3] })).status, 401);
  assert.strictEqual((await tryLogin({ code: codes[4].toUpperCase() })).status, 200);
  assert.strictEqual(authstore.readAuth(s.dir).recovery.length, 8);
  await authstore.setCredentials({ dir: s.dir, username: h.USER, password: h.PASS, hashOptions: FAST });
  assert.ok(authstore.readAuth(s.dir).totp);
});

test('ccd passwd --totp stores after a valid code; wrong code changes nothing; --no-totp removes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-totp-'));
  await authstore.setCredentials({ dir, username: 'carol', password: 'p'.repeat(14), hashOptions: FAST });
  const out = [];
  const now = () => 1_700_000_000_000;
  await assert.rejects(enrollTotp({ dir, askCode: async () => '000000', out: (x) => out.push(x), now, hashOptions: FAST }), /not valid/);
  assert.strictEqual(authstore.readAuth(dir).totp, undefined);
  out.length = 0;
  const gen = authstore.readAuth(dir).generation;
  const codes = await enrollTotp({
    dir, now, hashOptions: FAST, out: (x) => out.push(x),
    askCode: async () => totp.hotp(/secret=([A-Z2-7]+)/.exec(out.join('\n'))[1], totp.stepAt(now())),
  });
  const a = authstore.readAuth(dir);
  assert.strictEqual(codes.length, 10);
  assert.strictEqual(a.recovery.length, 10);
  assert.ok(a.recovery[0].startsWith('$argon2id$'));
  assert.strictEqual(a.totp.lastStep, totp.stepAt(now()));
  assert.notStrictEqual(a.generation, gen);
  assert.ok(out.join('\n').includes('otpauth://'));
  assert.strictEqual(fs.statSync(path.join(dir, 'auth.json')).mode & 0o777, 0o600);
  removeTotp({ dir, out: () => {} });
  const b = authstore.readAuth(dir);
  assert.strictEqual(b.totp, undefined);
  assert.strictEqual(b.recovery, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('enrol mode: limited session reaches only /api/totp/enroll, then upgrades', async (t) => {
  const s = await h.start();
  t.after(s.stop);
  await authstore.setCredentials({ dir: s.dir, username: h.USER, password: h.PASS, hashOptions: FAST });
  authstore.setTotpRequired({ dir: s.dir, required: true });
  s.app.refreshAuth();
  const r = await h.login(s.base);
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).enroll, true);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  for (const p of ['/', '/api/projects', '/api/totp/other']) {
    const x = await h.req(s.base, p, { cookie });
    assert.ok([403].includes(x.status), `${p} -> ${x.status}`);
  }
  assert.strictEqual((await h.req(s.base, '/logout', { method: 'POST', headers: POST_HEADERS, cookie })).status, 403);
  const ws = await fetch(s.base + '/events', { headers: { cookie, origin: ORIGIN, upgrade: 'websocket', connection: 'upgrade' } }).catch(() => null);
  assert.ok(!ws || ws.status !== 200);
  const g = await h.req(s.base, '/api/totp/enroll', { cookie });
  const { uri, qrSvg } = await g.json();
  assert.match(qrSvg, /^<svg/);
  const secret = /secret=([A-Z2-7]+)/.exec(uri)[1];
  const post = (code, headers = POST_HEADERS) => h.req(s.base, '/api/totp/enroll', { method: 'POST', headers, json: { code }, cookie });
  assert.strictEqual((await post('123456', {})).status, 403); // no Origin / X-CCDash
  assert.strictEqual((await post('000000')).status, 401);
  const ok = await post(totp.hotp(secret, totp.stepAt(s.clock.now())));
  assert.strictEqual(ok.status, 200);
  const body = await ok.json();
  assert.strictEqual(body.recovery.length, 10);
  const full = ok.headers.get('set-cookie').split(';')[0];
  assert.strictEqual((await h.req(s.base, '/', { cookie: full })).status, 200);
  assert.strictEqual((await h.req(s.base, '/', { cookie })).status, 302); // limited session is gone
  assert.ok(authstore.readAuth(s.dir).totp);
  assert.strictEqual((await h.login(s.base)).status, 401); // now a code is needed
});

test('enrol mode: already enrolled -> 409; a generation change drops the limited session', async (t) => {
  const s = await h.start();
  t.after(s.stop);
  await authstore.setCredentials({ dir: s.dir, username: h.USER, password: h.PASS, hashOptions: FAST });
  authstore.setTotpRequired({ dir: s.dir, required: true });
  s.app.refreshAuth();
  const cookie = (await h.login(s.base)).headers.get('set-cookie').split(';')[0];
  assert.strictEqual((await h.req(s.base, '/api/totp/enroll', { cookie })).status, 200);
  await authstore.enableTotp({ dir: s.dir, secret: totp.generateSecret(), hashOptions: FAST }); // `ccd passwd --totp` elsewhere, no rotation
  s.app.refreshAuth();
  const post = h.req(s.base, '/api/totp/enroll', { method: 'POST', headers: POST_HEADERS, json: { code: '000000' }, cookie });
  assert.strictEqual((await post).status, 409);
  assert.strictEqual((await h.req(s.base, '/api/totp/enroll', { cookie })).status, 409);
  await authstore.setCredentials({ dir: s.dir, username: h.USER, password: h.PASS, hashOptions: FAST });
  s.app.refreshAuth();
  assert.notStrictEqual((await h.req(s.base, '/api/totp/enroll', { cookie })).status, 200);
});
