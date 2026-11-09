'use strict';
// The multi-account UI in a browser, with /api/accounts and the open call stubbed (no real sessions or logins):
// one account shows no account controls at all; two show the pickers, the settings list and the Add account flow.
const test = require('node:test');
const assert = require('node:assert/strict');
const { BASE, USER, PASS, eventually, launch } = require('./lib');

const ONE = { accounts: [{ name: 'default', loggedIn: true }] };
const TWO = { accounts: [{ name: 'default', loggedIn: true }, { name: 'work', loggedIn: false }] };
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

let browser;
test.before(async () => { browser = await launch(); });
test.after(async () => { await browser.close(); });

// A signed-in page whose accounts answer is `list`; records the open/add request bodies and /term WebSocket URLs.
// addReply: [status, body] for POST /api/accounts.
async function setup(list, addReply = [200, { name: 'second', project: '_login', account: 'second' }]) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: BASE, serviceWorkers: 'block' });
  const page = await context.newPage();
  const seen = { open: [], add: [], ws: [] };
  await page.route('**/api/accounts', (route) => {
    const req = route.request();
    if (req.method() === 'POST') { seen.add.push(req.postDataJSON()); return json(route, ...addReply); }
    return json(route, 200, list);
  });
  // The stack has no cloned repos, so the project list is stubbed too (ph is the page the browser may attach to).
  await page.route(/\/api\/projects$/, (route) => (route.request().method() === 'GET'
    ? json(route, 200, { projects: [{ name: 'ph', state: 'claude' }] }) : route.continue()));
  await page.route(/\/api\/projects\/[^/]+\/open$/, (route) => {
    const raw = route.request().postData();
    seen.open.push(raw ? JSON.parse(raw) : null);
    return json(route, 200, { ok: true });
  });
  page.on('websocket', (ws) => { if (new URL(ws.url()).pathname.startsWith('/term/')) seen.ws.push(ws.url()); });
  await page.goto('/login');
  await page.fill('#username', USER);
  await page.fill('#password', PASS);
  await Promise.all([page.waitForURL((u) => u.pathname === '/'), page.click('button[type=submit]')]);
  await page.locator('#project-list li.card').first().waitFor();
  return { context, page, seen };
}

const visibleCount = (page, id) => page.getByTestId(id).evaluateAll((els) => els.filter((e) => e.offsetParent !== null).length);
const lastWs = (seen) => seen.ws[seen.ws.length - 1];

test('one account: no account controls, no account in the WS URL or the open body', async () => {
  const { context, page, seen } = await setup(ONE);
  try {
    await page.click('#add-open');
    await page.locator('#add-dialog').waitFor({ state: 'visible' });
    assert.equal(await visibleCount(page, 'account-select-add'), 0);
    await page.keyboard.press('Escape');
    assert.equal(await visibleCount(page, 'account-select-open'), 0);
    assert.equal(await visibleCount(page, 'account-label'), 0);

    await page.locator('#project-list li.card').first().locator('.card-open').click();
    await eventually(async () => assert.equal(seen.open.length, 1), 'open was called');
    assert.ok(!seen.open[0] || !('account' in seen.open[0]), `open body: ${JSON.stringify(seen.open[0])}`);
    await page.locator('#view-terminal').waitFor({ state: 'visible' });
    await eventually(async () => assert.ok(seen.ws.length >= 1), 'terminal socket opened');
    assert.ok(!new URL(lastWs(seen)).searchParams.has('account'), lastWs(seen));
    assert.equal(await visibleCount(page, 'account-select-term'), 0);
    assert.equal(await visibleCount(page, 'account-label'), 0);
  } finally { await context.close(); }
});

test('two accounts: pickers, open body, header reconnect, settings list', async () => {
  const { context, page, seen } = await setup(TWO);
  try {
    await page.click('#add-open');
    await page.getByTestId('account-select-add').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');

    const first = page.locator('#project-list li.card').first();
    const pick = first.getByTestId('account-select-open');
    await pick.waitFor({ state: 'visible' });
    await pick.selectOption('work');
    await first.locator('.card-open').click();
    await eventually(async () => assert.equal(seen.open.length, 1), 'open was called');
    assert.equal(seen.open[0].account, 'work');

    await page.locator('#view-terminal').waitFor({ state: 'visible' });
    await eventually(async () => assert.ok(seen.ws.length >= 1), 'terminal socket opened');
    const head = page.getByTestId('account-select-term');
    await head.waitFor({ state: 'visible' });
    await head.selectOption('default');
    await eventually(async () => assert.ok(!new URL(lastWs(seen)).searchParams.has('account')), 'default: no account param');
    const n = seen.ws.length;
    await head.selectOption('work');
    await eventually(async () => assert.ok(seen.ws.length > n && new URL(lastWs(seen)).searchParams.get('account') === 'work'), 'reconnect with ?account=work');

    await page.getByTestId('usage').click();
    await page.getByTestId('usage-account').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');

    await page.evaluate(() => { location.hash = '#/'; });
    await page.getByRole('button', { name: /Settings/ }).click();
    await page.getByTestId('settings-accounts').waitFor({ state: 'visible' });
    const rows = page.getByTestId('account-row');
    assert.equal(await rows.count(), 2);
    assert.match(await rows.filter({ has: page.locator('.acct-name', { hasText: /^default$/ }) }).innerText(), /logged in/);
    assert.match(await page.locator('[data-account="work"]').innerText(), /not logged in/i);
  } finally { await context.close(); }
});

test('Add account: validation, success goes to the sign-in terminal, a 400 stays inline', async () => {
  const { context, page, seen } = await setup(TWO);
  try {
    await page.getByRole('button', { name: /Settings/ }).click();
    const name = page.getByTestId('account-add-name');
    const submit = page.getByTestId('account-add-submit');
    await name.waitFor({ state: 'visible' });
    for (const bad of ['Bad Name', 'default']) {
      await name.fill(bad);
      await name.blur();
      assert.ok((await page.locator('#acct-name-err').innerText()).length > 0, `${bad}: inline error`);
    }
    await name.fill('second');
    assert.equal(await submit.isDisabled(), false);
    await submit.click();
    await eventually(async () => assert.deepEqual(seen.add, [{ name: 'second' }]), 'POST /api/accounts body');
    await eventually(async () => assert.equal(await page.evaluate(() => location.hash), '#/term/_login?account=second'), 'hash');
    await page.getByTestId('login-hint').waitFor({ state: 'visible' });
    assert.match(await page.getByTestId('login-hint').innerText(), /\/login/);
  } finally { await context.close(); }

  const err = await setup(TWO, [400, { error: 'name taken' }]);
  try {
    await err.page.getByRole('button', { name: /Settings/ }).click();
    await err.page.getByTestId('account-add-name').fill('third');
    await err.page.getByTestId('account-add-submit').click();
    await eventually(async () => assert.match(await err.page.locator('#acct-name-err').innerText(), /name taken/), 'inline 400 error');
    assert.equal(await err.page.getByTestId('settings-accounts').isVisible(), true, 'settings dialog stays open');
    assert.match(await err.page.evaluate(() => location.hash), /^(#\/?)?$/);
  } finally { await err.context.close(); }
});
