'use strict';
// AC-4.1: the per-project sign-in view. API stubbed with page.route (see projectPage in lib.js); roles and
// accessible names only, no CSS classes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { eventually, launch, projectPage } = require('./lib');

const URL_ = 'https://claude.ai/oauth/authorize?code=true&state=stub';
let browser;
test.before(async () => { browser = await launch(); });
test.after(async () => { await browser.close(); });

test('after Add project: sign-in link with the API url, then Start Claude once logged in', async () => {
  const { context, page, state } = await projectPage(browser, { loggedIn: false, url: URL_ });
  try {
    await page.click('#add-open');
    await page.fill('#add-repo', 'owner/ph');
    await page.press('#add-repo', 'Enter');
    const link = page.getByRole('link', { name: 'Open sign-in link' });
    await link.waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await link.getAttribute('href'), URL_);
    assert.equal(await page.getByRole('button', { name: 'Start Claude' }).count(), 0, 'no Start Claude while logged out');
    state.loggedIn = true;
    await page.getByRole('button', { name: 'Start Claude' }).waitFor({ state: 'visible', timeout: 15000 });
  } finally { await context.close(); }
});

test('opening a logged-out project (409 login-required) shows the sign-in view', async () => {
  const { context, page } = await projectPage(browser, { loggedIn: false, url: URL_ });
  try {
    await page.locator('#project-list li.card').first().locator('.card-open').click();
    const link = page.getByRole('link', { name: 'Open sign-in link' });
    await eventually(async () => assert.equal(await link.getAttribute('href', { timeout: 500 }), URL_), 'sign-in link href', 5000);
  } finally { await context.close(); }
});

test('Start Claude opens the window through the API', async () => {
  const { context, page, seen } = await projectPage(browser, { loggedIn: true });
  try {
    await page.evaluate(() => { location.hash = '#/term/ph'; });
    await page.getByRole('region', { name: 'Windows' }).waitFor({ state: 'visible', timeout: 5000 });
    await page.getByRole('button', { name: 'New Claude window' }).click();
    await eventually(async () => assert.ok(seen.posts.some((p) => /POST \/api\/projects\/ph\/windows \{"kind":"claude"\}/.test(p))), 'POST windows claude', 5000);
  } finally { await context.close(); }
});
