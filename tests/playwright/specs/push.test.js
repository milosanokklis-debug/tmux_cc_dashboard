'use strict';
// Web push end to end. Chromium cannot reach a real push service, so the page's PushManager is stubbed
// to return a subscription whose endpoint is a fake push service started here (https, self-signed; the
// dashboard trusts its cert through NODE_EXTRA_CA_CERTS). The dashboard really encrypts and POSTs to it;
// this test decrypts the request and hands the payload to the service worker over CDP, then looks at the
// notifications the worker showed. Needs conversation pc (waiting) started by tests/stack/phase-c.sh.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const https = require('node:https');
const ece = require('http_ece');
const { BASE, OUT, sleep, eventually, launch, phoneContext, login, card, apiGet, sendPrompt } = require('./lib');

const PORT = Number(process.env.PUSH_PORT || 8443);
const SECRET = 'secret-word-zq81'; // appears in prompts only; must never show up in a push
const ORIGIN = new URL(BASE).origin;

const ecdh = crypto.createECDH('prime256v1');
ecdh.generateKeys();
const authSecret = crypto.randomBytes(16);
const sub = {
  endpoint: `https://localhost:${PORT}/push/${crypto.randomBytes(6).toString('hex')}`,
  p256dh: ecdh.getPublicKey().toString('base64url'),
  auth: authSecret.toString('base64url'),
};

const received = []; // { headers, url, payload (decrypted text) }
let server, browser, context, page, cdp;
const registrations = new Map();

test.before(async () => {
  server = https.createServer({ key: process.env.PUSH_KEY, cert: process.env.PUSH_CERT }, (rq, rs) => {
    const chunks = [];
    rq.on('data', (c) => chunks.push(c));
    rq.on('end', () => {
      let payload = null;
      try { payload = ece.decrypt(Buffer.concat(chunks), { version: 'aes128gcm', privateKey: ecdh, authSecret }).toString(); } catch { /* recorded as null */ }
      received.push({ headers: rq.headers, url: rq.url, payload });
      rs.writeHead(201);
      rs.end();
    });
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  browser = await launch();
  context = await phoneContext(browser);
  await context.addInitScript((s) => {
    const KEY = '__fakesub';
    const mk = () => ({
      endpoint: s.endpoint,
      expirationTime: null,
      toJSON: () => ({ endpoint: s.endpoint, expirationTime: null, keys: { p256dh: s.p256dh, auth: s.auth } }),
      unsubscribe: async () => { localStorage.removeItem(KEY); return true; },
    });
    PushManager.prototype.getSubscription = async () => (localStorage.getItem(KEY) ? mk() : null);
    PushManager.prototype.subscribe = async (opts) => {
      localStorage.setItem(KEY, '1');
      localStorage.setItem('__vapidlen', String(new Uint8Array(opts.applicationServerKey).length));
      return mk();
    };
  }, sub);
  page = await context.newPage();
  cdp = await context.newCDPSession(page);
  cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => { for (const r of e.registrations) registrations.set(r.scopeURL, r.registrationId); });
  await cdp.send('ServiceWorker.enable');
  await login(page);
});
test.after(async () => {
  await context?.close();
  await browser?.close();
  await new Promise((r) => { if (!server) return r(); server.close(r); server.closeAllConnections(); });
});

const notifications = () => page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg.getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag }));
});
// Hands one decrypted push to the service worker, as the browser would after fetching it from the push service.
async function deliver(payload) {
  const registrationId = await eventually(() => {
    const id = registrations.get(`${ORIGIN}/`);
    if (!id) throw new Error('service worker registration not seen yet');
    return id;
  }, 'service worker registration');
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: ORIGIN, registrationId, data: payload });
}
const config = () => apiGet(page, '/api/push/config');
const openSettings = async () => { await page.getByTestId('notifications').click(); await page.locator('#notif-dialog').waitFor({ state: 'visible' }); };

async function untilStatus(project, status) {
  await eventually(async () => {
    const t = await apiGet(page, '/api/tree?all=1');
    const c = t.projects.find((p) => p.project === project).conversations.find((x) => x.status !== 'ended' && x.status !== 'sleeping');
    assert.equal(c.status, status);
  }, `${project} is ${status}`);
}

// Clicks Interrupt and waits for the /interrupt POST, asserting it succeeded; the status check follows separately.
async function interrupt(project) {
  const [res] = await Promise.all([
    page.waitForResponse((r) => /\/interrupt$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST', { timeout: 15000 }),
    card(page, project).getByTestId('interrupt').click(),
  ]);
  assert.ok(res.ok(), `interrupt POST returned ${res.status()} ${await res.text().catch(() => '')}`);
}

test('enabling notifications in the settings dialog subscribes this browser', async () => {
  await eventually(async () => assert.equal(await card(page, 'pc').getByTestId('prompt').isDisabled(), false), 'pc waiting');
  await openSettings();
  await page.getByTestId('enable-notifications').waitFor({ state: 'visible' });
  assert.match(await page.getByTestId('notif-state').innerText(), /off/);
  await page.getByTestId('enable-notifications').click();
  await eventually(async () => assert.match(await page.getByTestId('notif-state').innerText(), /are on/), 'state is on');
  for (const k of ['approval', 'error', 'finished']) assert.equal(await page.getByTestId(`toggle-${k}`).isChecked(), true, k);
  assert.equal(await page.evaluate(() => localStorage.getItem('__vapidlen')), '65', 'subscribed with the server VAPID public key');
  const cfg = await config();
  assert.equal(cfg.subscribed, true);
  await page.screenshot({ path: `${OUT}/settings.png` });
  await page.locator('#notif-close').click();
  assert.equal(received.length, 0, 'no push yet');
});

test('an approval request produces exactly one push, and one notification, with only {project,status}', async () => {
  await sendPrompt(page, 'pc', `/perm ${SECRET}`);
  await eventually(async () => assert.ok(received.length >= 1), 'push for the approval reaches the push service');
  await sleep(2500); // a duplicate (broker plus reconciler) would show up by now
  assert.equal(received.length, 1, `one push request, got ${received.length}`);
  const r = received[0];
  assert.match(r.headers.authorization, /^vapid /);
  assert.equal(r.headers['content-encoding'], 'aes128gcm');
  assert.deepEqual(JSON.parse(r.payload), { project: 'pc', status: 'needs_approval' });
  assert.deepEqual(Object.keys(JSON.parse(r.payload)).sort(), ['project', 'status']);
  await deliver(r.payload);
  await eventually(async () => {
    const n = (await notifications()).filter((x) => x.tag === 'pc:needs_approval');
    assert.equal(n.length, 1);
    assert.equal(n[0].title, 'pc');
    assert.equal(n[0].body, 'Needs your approval');
  }, 'one approval notification');
  assert.equal((await notifications()).length, 1, 'exactly one notification so far');
  await card(page, 'pc').getByTestId('approve').click();
  await untilStatus('pc', 'waiting');
});

test('a finished turn (working to waiting) produces exactly one push and one notification', async () => {
  const before = received.length;
  await sendPrompt(page, 'pc', `/long ${SECRET}`);
  await untilStatus('pc', 'working');
  await sleep(1500); // let the reconciler see "working" before the turn ends
  await interrupt('pc');
  await eventually(async () => assert.ok(received.length > before), 'push for the finished turn');
  await sleep(2500);
  assert.equal(received.length, before + 1, 'exactly one push for the finished turn');
  const r = received[received.length - 1];
  assert.deepEqual(JSON.parse(r.payload), { project: 'pc', status: 'waiting' });
  await deliver(r.payload);
  await eventually(async () => {
    const n = (await notifications()).filter((x) => x.tag === 'pc:waiting');
    assert.equal(n.length, 1);
    assert.equal(n[0].body, 'Finished, waiting for you');
  }, 'one finished notification');
  assert.equal((await notifications()).length, 2);
  for (const x of received) assert.ok(!x.payload.includes(SECRET) && !x.payload.includes('perm') && !x.payload.includes('long'), 'no prompt text in any push');
  for (const n of await notifications()) assert.ok(!JSON.stringify(n).includes(SECRET));
});

test('a pref switched off in the UI stops that push', async () => {
  await openSettings();
  await page.getByTestId('toggle-finished').uncheck();
  await eventually(async () => assert.equal((await config()).prefs.finished, false), 'finished pref saved on the server');
  assert.deepEqual((await config()).prefs, { approval: true, error: true, finished: false });
  await page.locator('#notif-close').click();
  const before = received.length;
  await untilStatus('pc', 'waiting'); // the server's view, not just the UI, before sending
  await eventually(async () => assert.equal(await card(page, 'pc').getByTestId('prompt').isDisabled(), false), 'pc waiting');
  await sendPrompt(page, 'pc', `/long ${SECRET}`);
  await untilStatus('pc', 'working');
  await sleep(1500); // let the reconciler see "working" before the turn ends (as in the test above)
  await interrupt('pc');
  await untilStatus('pc', 'waiting');
  await sleep(3000); // negative check: a push, if one were wrongly sent, would arrive within this window
  assert.equal(received.length, before, 'no push for a finished turn once that pref is off');
});

test('signing out deletes the subscription', async () => {
  assert.equal((await config()).subscribed, true);
  await page.click('#logout');
  await page.waitForFunction(() => location.pathname === '/login');
  await login(page);
  assert.equal((await config()).subscribed, false);
  await openSettings();
  await page.getByTestId('enable-notifications').waitFor({ state: 'visible' });
  assert.match(await page.getByTestId('notif-state').innerText(), /off/);
});
