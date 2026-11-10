'use strict';
// The agent kit opt-in UI in a browser, with the project list and the kit API stubbed (the stack has no
// cloned repos and no kit source): Add project checkbox, per-card switch, warning, Settings > Agent kit.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { BASE, USER, PASS, OUT, eventually, launch } = require('./lib');

const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const A = 'a'.repeat(40), B = 'b'.repeat(40);

let browser;
test.before(async () => { browser = await launch(); });
test.after(async () => { await browser.close(); });

// opts.project: the project object; opts.kit: GET /api/kit body (or function); opts.update: [status, body]
async function setup(opts = {}, viewport = { width: 1280, height: 800 }) {
  const context = await browser.newContext({ viewport, baseURL: BASE, serviceWorkers: 'block' });
  const page = await context.newPage();
  const seen = { toggle: [], update: [], kit: 0, errors: [] };
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) seen.errors.push(m.text()); });
  page.on('pageerror', (e) => seen.errors.push(String(e)));
  const proj = { name: 'ph', state: 'claude', kitEnabled: false, kit: null, kitError: null, ...(opts.project || {}) };
  await page.route(/\/api\/projects$/, (r) => (r.request().method() === 'GET' ? json(r, 200, { projects: [proj] }) : r.continue()));
  await page.route(/\/api\/projects\/[^/]+\/kit$/, (r) => {
    const body = r.request().postDataJSON();
    seen.toggle.push(body);
    if (opts.toggleFail) return json(r, 500, { error: 'boom', message: 'toggle exploded' });
    proj.kitEnabled = body.enabled;
    proj.kit = body.enabled ? { version: '1.2.3', memory: 'ok' } : null;
    return json(r, 200, { kitEnabled: proj.kitEnabled, kit: proj.kit, kitError: null });
  });
  await page.route('**/api/kit', (r) => {
    seen.kit++;
    const k = typeof opts.kit === 'function' ? opts.kit(seen) : opts.kit;
    return json(r, 200, k || { active: { sha: A, version: '1.0.0' }, image: { sha: A }, newest: { sha: A }, updateAvailable: false });
  });
  await page.route('**/api/kit/update', (r) => {
    seen.update.push(r.request().postDataJSON());
    return json(r, ...(opts.update || [200, { old: A, new: B, versions: { old: '1.0.0', new: '1.1.0' }, projects: [] }]));
  });
  await page.goto('/login');
  await page.fill('#username', USER);
  await page.fill('#password', PASS);
  await Promise.all([page.waitForURL((u) => u.pathname === '/'), page.click('button[type=submit]')]);
  await page.locator('#project-list li.card').first().waitFor();
  return { context, page, seen };
}

const openKit = async (page) => {
  await page.getByRole('button', { name: /Settings/ }).click();
  await page.locator('#kit-section summary').click();
  await page.getByTestId('kit-active').waitFor({ state: 'visible' });
};

test('Add project: kit unticked by default, no design/code pack controls', async () => {
  const { context, page, seen } = await setup();
  try {
    await page.click('#add-open');
    await page.locator('#add-dialog').waitFor({ state: 'visible' });
    const kit = page.getByTestId('add-kit');
    assert.equal(await kit.isChecked(), false);
    assert.match(await page.locator('label.check', { has: kit }).innerText(), /Install agent kit \(skills, plugins, MCP servers\)/);
    assert.equal(await page.locator('#add-design, #add-code').count(), 0);
    assert.deepEqual(seen.errors, []);
  } finally { await context.close(); }
});

test('card: switch on then off posts {enabled}, shows version', async () => {
  const { context, page, seen } = await setup();
  try {
    const card = page.locator('#project-list li.card').first();
    const sw = card.getByTestId('kit-toggle');
    assert.equal(await sw.getAttribute('role'), 'switch');
    assert.equal(await sw.getAttribute('aria-checked'), 'false');
    await sw.click();
    await eventually(async () => assert.equal(await sw.getAttribute('aria-checked'), 'true'), 'switch on');
    await eventually(async () => assert.match(await card.innerText(), /kit 1\.2\.3/), 'version shown');
    await sw.click();
    await eventually(async () => assert.equal(await sw.getAttribute('aria-checked'), 'false'), 'switch off');
    assert.deepEqual(seen.toggle, [{ enabled: true }, { enabled: false }]);
    assert.deepEqual(seen.errors, []);
  } finally { await context.close(); }
});

test('card: failed toggle reverts the switch and says why', async () => {
  const { context, page } = await setup({ toggleFail: true });
  try {
    const card = page.locator('#project-list li.card').first();
    const sw = card.getByTestId('kit-toggle');
    await sw.click();
    await eventually(async () => assert.match(await card.innerText(), /toggle exploded/), 'error shown');
    assert.equal(await sw.getAttribute('aria-checked'), 'false');
  } finally { await context.close(); }
});

test('card: kitError shows the warning badge, none without it', async () => {
  const bad = await setup({ project: { kitEnabled: true, kit: { version: '1.0.0', memory: 'ok' }, kitError: { code: 'x', message: 'Kit files are out of date' } } });
  try {
    const w = bad.page.locator('#project-list li.card').first().getByTestId('kit-warning');
    await w.waitFor({ state: 'visible' });
    assert.match(await w.innerText(), /Kit files are out of date/);
  } finally { await bad.context.close(); }
  const good = await setup({ project: { kitEnabled: true, kit: { version: '1.0.0', memory: 'ok' } } });
  try {
    assert.equal(await good.page.getByTestId('kit-warning').first().isVisible(), false);
  } finally { await good.context.close(); }
});

const off = async (l) => (await l.getAttribute('aria-disabled')) === 'true';

test('settings: update available -> update succeeds and shows the new version', async () => {
  const { context, page, seen } = await setup({
    kit: (s) => (s.update.length ? { active: { sha: B, version: '1.1.0' }, image: { sha: A }, newest: { sha: B }, updateAvailable: false }
      : { active: { sha: A, version: '1.0.0' }, image: { sha: A }, newest: { sha: B }, updateAvailable: true }),
  });
  try {
    await openKit(page);
    await eventually(async () => assert.match(await page.getByTestId('kit-newest').innerText(), /update available/), 'update available');
    assert.match(await page.getByTestId('kit-active').innerText(), /1\.0\.0/);
    const upd = page.getByTestId('kit-update');
    assert.equal(await off(upd), false);
    await upd.click();
    await eventually(async () => assert.match(await page.getByTestId('kit-status').innerText(), /Kit updated\. Active kit is now 1\.1\.0/), 'success text');
    await eventually(async () => assert.match(await page.getByTestId('kit-active').innerText(), /1\.1\.0/), 'active refreshed');
    assert.equal(await off(upd), true);
    assert.deepEqual(seen.update, [{}]);
    assert.deepEqual(seen.errors, []);
  } finally { await context.close(); }
});

test('settings: up to date disables Update; Check re-queries', async () => {
  const { context, page, seen } = await setup();
  try {
    await openKit(page);
    await eventually(async () => assert.match(await page.getByTestId('kit-newest').innerText(), /up to date/), 'up to date');
    assert.equal(await off(page.getByTestId('kit-update')), true);
    const n = seen.kit;
    await page.getByTestId('kit-check').click();
    await eventually(async () => assert.ok(seen.kit > n), 'GET /api/kit again');
  } finally { await context.close(); }
});

test('settings: failed updates (500, 502, 409) and per-project failures are shown', async () => {
  const avail = { active: { sha: A, version: '1.0.0' }, image: { sha: A }, newest: { sha: B }, updateAvailable: true };
  for (const [status, re] of [[500, /failed: boom/], [502, /failed: boom/], [409, /busy/]]) {
    const { context, page } = await setup({ kit: avail, update: [status, { error: 'boom', message: 'boom' }] });
    try {
      await openKit(page);
      await eventually(async () => assert.equal(await off(page.getByTestId('kit-update')), false), 'enabled');
      await page.getByTestId('kit-update').click();
      await eventually(async () => assert.match(await page.getByTestId('kit-status').innerText(), re), `${status} message`);
      assert.equal(await page.getByTestId('kit-status').evaluate((e) => e.classList.contains('is-error')), true);
    } finally { await context.close(); }
  }
  const { context, page } = await setup({ kit: avail, update: [200, { old: A, new: B, versions: { new: '1.1.0' }, projects: [
    { name: 'alpha', status: 'ok' }, { name: 'gamma', status: 'changed' }, { name: 'beta', status: 'failed', message: 'git conflict' }] }] });
  try {
    await openKit(page);
    await eventually(async () => assert.equal(await off(page.getByTestId('kit-update')), false), 'enabled');
    await page.getByTestId('kit-update').click();
    await eventually(async () => assert.match(await page.getByTestId('kit-status').innerText(), /1 project failed/), 'count');
    const list = page.getByTestId('kit-failed');
    assert.match(await list.innerText(), /beta: git conflict/);
    assert.doesNotMatch(await list.innerText(), /alpha|gamma/);
  } finally { await context.close(); }
});

test('settings: reset asks first, then posts {reset:true}', async () => {
  const { context, page, seen } = await setup();
  try {
    await openKit(page);
    await page.getByTestId('kit-reset').click();
    assert.equal(await page.locator('#kit-confirm').isVisible(), true);
    assert.equal(seen.update.length, 0);
    await page.getByTestId('kit-reset-confirm').click();
    await eventually(async () => assert.deepEqual(seen.update, [{ reset: true }]), 'reset posted');
  } finally { await context.close(); }
});

for (const [w, h] of [[390, 844], [1280, 800]]) {
  test(`screenshots at ${w}px, no horizontal overflow`, async () => {
    const { context, page, seen } = await setup({ project: { kitEnabled: true, kit: { version: '1.0.0', memory: 'ok' }, kitError: { message: 'Kit files are out of date' } },
      kit: { active: { sha: A, version: '1.0.0' }, image: { sha: A }, newest: { sha: B }, updateAvailable: true } }, { width: w, height: h });
    try {
      await page.locator('#project-list li.card').first().screenshot({ path: path.join(OUT, `kit-card-${w}.png`) });
      await openKit(page);
      await page.getByTestId('kit-update').waitFor({ state: 'visible' });
      await eventually(async () => assert.equal(await off(page.getByTestId('kit-update')), false), 'loaded');
      await page.locator('#kit-section').screenshot({ path: path.join(OUT, `kit-settings-${w}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal scroll');
      assert.deepEqual(seen.errors, []);
    } finally { await context.close(); }
  });
}
