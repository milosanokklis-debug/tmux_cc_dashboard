'use strict';
// One desktop screenshot of the terminal view with the conversation cards for the README (tests/stack/phase-g.sh with SCREENSHOT=1).
const test = require('node:test');
const { OUT, BASE, USER, PASS, eventually, launch } = require('./lib');

test('desktop screenshot of the terminal view with the conversation cards', async () => {
  const browser = await launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 1, baseURL: BASE, serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.goto('/login');
    await page.fill('#username', USER);
    await page.fill('#password', PASS);
    await page.click('button[type=submit]');
    await page.waitForURL((u) => u.pathname === '/');
    // The conversation cards are in the agent tree of a project's terminal view, with "All projects" ticked.
    await page.evaluate(() => { location.hash = '#/term/alpha'; });
    await page.locator('#view-terminal').waitFor({ state: 'visible' });
    if ((await page.locator('#tree-toggle').getAttribute('aria-expanded')) !== 'true') await page.click('#tree-toggle');
    const all = page.locator('#tree-all-projects');
    await all.waitFor({ state: 'visible' });
    if (!(await all.isChecked())) await all.check();
    await eventually(async () => { if ((await page.getByTestId('tree-node').count()) < 3) throw new Error('nodes'); }, 'three conversations');
    await new Promise((r) => setTimeout(r, 2500));
    await page.screenshot({ path: `${OUT}/screenshot.png` });
  } finally { await browser.close(); }
});
