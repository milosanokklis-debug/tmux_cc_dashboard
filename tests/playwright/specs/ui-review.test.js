'use strict';
// Regression tests for the UI review findings (1), (2), (3) and (5). API stubbed (projectPage in lib.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { eventually, launch, projectPage } = require('./lib');

let browser;
test.before(async () => { browser = await launch(); });
test.after(async () => { await browser.close(); });

const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

test('(1) a conversation whose state has no project or another project is hidden in the Windows panel', async () => {
  const { context, page } = await projectPage(browser, { windows: [{ id: '@1', index: 0, name: 'claude', active: true, kind: 'claude', pid: 1 }] });
  try {
    await page.routeWebSocket(/\/events$/, (ws) => {
      ws.send(JSON.stringify({ type: 'state', states: {
        'noproj-0001': { status: 'waiting' },
        'other-00002': { project: 'other', status: 'waiting' },
        'mine-000003': { project: 'ph', status: 'waiting' },
      } }));
    });
    await page.reload();
    await page.locator('#project-list li.card').first().waitFor();
    await page.evaluate(() => { location.hash = '#/term/ph'; });
    await page.getByRole('region', { name: 'Windows' }).waitFor({ state: 'visible', timeout: 5000 });
    await eventually(async () => assert.equal(await page.locator('li[data-testid="conversation"][data-sid="mine-000003"]').count(), 1), 'own conversation shown', 5000);
    assert.equal(await page.locator('li[data-testid="conversation"][data-sid="noproj-0001"]').count(), 0, 'conversation without a project is hidden');
    assert.equal(await page.locator('li[data-testid="conversation"][data-sid="other-00002"]').count(), 0, 'conversation of another project is hidden');
  } finally { await context.close(); }
});

test('(2) a failing sign-in status check shows "Could not check sign-in. Retrying." as a status', async () => {
  const { context, page } = await projectPage(browser, { loggedIn: true });
  try {
    await page.route(/\/api\/projects\/[^/]+\/login$/, (route) => json(route, 500, { error: 'boom' }));
    await page.evaluate(() => { location.hash = '#/term/ph'; });
    const msg = page.getByRole('status').filter({ hasText: 'Could not check sign-in. Retrying.' });
    await msg.waitFor({ state: 'visible', timeout: 6000 });
  } finally { await context.close(); }
});

test('(3) Start Claude is not left busy after leaving the project mid-POST and coming back', async () => {
  const { context, page, state } = await projectPage(browser, { loggedIn: false });
  try {
    let release;
    const held = new Promise((r) => { release = r; });
    await page.locator('#project-list li.card').first().locator('.card-open').click();
    await page.getByRole('link', { name: 'Open sign-in link' }).waitFor({ state: 'visible', timeout: 5000 });
    state.loggedIn = true;
    await page.route(/\/api\/projects\/[^/]+\/open$/, async (route) => { await held; await json(route, 200, { ok: true }); });
    const start = page.getByRole('button', { name: 'Start Claude' });
    await start.waitFor({ state: 'visible', timeout: 15000 });
    await start.click();
    await page.waitForFunction(() => document.getElementById('signin-start').getAttribute('aria-busy') === 'true');
    await page.evaluate(() => { location.hash = '#/'; });
    await page.evaluate(() => { location.hash = '#/term/ph'; });
    await page.waitForTimeout(500);
    const attrs = await page.locator('#signin-start').evaluate((e) => ({ busy: e.getAttribute('aria-busy'), disabled: e.getAttribute('aria-disabled') }));
    release();
    assert.equal(attrs.busy, null, 'aria-busy cleared after switching projects');
    assert.equal(attrs.disabled, null, 'aria-disabled cleared after switching projects');
  } finally { await context.close(); }
});

test('(5) after Close, focus moves to the next window, then to New Claude window when none are left', async () => {
  const wins = [
    { id: '@1', index: 0, name: 'one', active: true, kind: 'shell', pid: 1 },
    { id: '@2', index: 1, name: 'two', active: false, kind: 'shell', pid: 2 },
  ];
  const { context, page } = await projectPage(browser, { windows: wins });
  try {
    await page.evaluate(() => { location.hash = '#/term/ph'; });
    const region = page.getByRole('region', { name: 'Windows' });
    await region.waitFor({ state: 'visible', timeout: 5000 });
    await eventually(async () => assert.equal(await region.getByRole('listitem').count(), 2), 'two rows', 5000);
    await region.getByRole('button', { name: 'Close one' }).click();
    await eventually(async () => assert.equal(await region.getByRole('listitem').count(), 1), 'one row left', 5000);
    const rowOf = () => page.evaluate(() => { const a = document.activeElement; const li = a && a.closest && a.closest('li'); return li ? li.innerText : (a && a.id) || a.tagName; });
    await eventually(async () => assert.match(await rowOf(), /two/), 'focus on the next item', 2000);
    await region.getByRole('button', { name: 'Close two' }).click();
    await eventually(async () => assert.equal(await region.getByRole('listitem').count(), 0), 'no rows left', 5000);
    await eventually(async () => assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'win-new-claude'), 'focus on New Claude window', 2000);
  } finally { await context.close(); }
});
