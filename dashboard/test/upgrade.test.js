'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { SessionStore } = require('../lib/sessions');
const { SocketRegistry } = require('../lib/registry');
const { guardUpgrade, COOKIE_NAME } = require('../lib/security');
const { fakeClock, ORIGIN } = require('./helpers');

function fakeSocket() {
  const s = new EventEmitter();
  s.writable = true; s.written = ''; s.destroyed = false;
  s.write = (d) => { s.written += d; return true; };
  s.destroy = () => { if (!s.destroyed) { s.destroyed = true; s.emit('close'); } };
  return s;
}
const setup = () => {
  const sessions = new SessionStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-up-')), clock: fakeClock() });
  return { sessions, origins: new Set([ORIGIN]) };
};
const request = (id, origin) => ({ headers: { ...(id ? { cookie: `${COOKIE_NAME}=${id}` } : {}), ...(origin ? { origin } : {}) } });

test('upgrade guard accepts valid session + allowed origin', () => {
  const ctx = setup();
  const id = ctx.sessions.create();
  const sock = fakeSocket();
  const g = guardUpgrade(request(id, ORIGIN), sock, ctx);
  assert.strictEqual(g.key, ctx.sessions.keyOf(id));
  assert.ok(!sock.destroyed);
});

test('upgrade guard: 401 without/with bad session, 403 for bad or missing origin; socket destroyed', () => {
  const ctx = setup();
  const id = ctx.sessions.create();
  const cases = [
    [request(null, ORIGIN), 401],
    [request('x'.repeat(43), ORIGIN), 401],
    [request(id, 'https://evil.example'), 403],
    [request(id, null), 403],
  ];
  for (const [r, status] of cases) {
    const sock = fakeSocket();
    assert.strictEqual(guardUpgrade(r, sock, ctx), null);
    assert.ok(sock.written.startsWith(`HTTP/1.1 ${status} `), sock.written);
    assert.ok(sock.destroyed);
  }
});

test('registry closes a session\'s sockets', () => {
  const reg = new SocketRegistry();
  const a = fakeSocket(); const b = fakeSocket(); const c = fakeSocket();
  reg.add('s1', a); reg.add('s1', b); reg.add('s2', c);
  reg.closeSession('s1');
  assert.ok(a.destroyed && b.destroyed && !c.destroyed);
  reg.closeAll();
  assert.ok(c.destroyed);
});

test('expiry sweep closes sockets via app tick', async () => {
  const h = require('./helpers');
  const s = await h.start();
  try {
    const cookie = await h.loginCookie(s.base);
    const key = s.app.sessions.keyOf(cookie.split('=')[1]);
    const sock = fakeSocket();
    s.app.registry.add(key, sock);
    s.clock.advance(12 * 3600e3 + 1);
    s.app.tick();
    assert.ok(sock.destroyed);
  } finally { await s.stop(); }
});
