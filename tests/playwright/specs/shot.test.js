'use strict';
// One desktop screenshot of the terminal view with the Windows panel for the README (tests/stack/phase-g.sh with SCREENSHOT=1).
const test = require('node:test');
const { OUT, BASE, USER, PASS, launch, sleep } = require('./lib');

test('desktop screenshot of the terminal view with the Windows panel', async () => {
  const browser = await launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 1, baseURL: BASE, serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.goto('/login');
    await page.fill('#username', USER);
    await page.fill('#password', PASS);
    await Promise.all([page.waitForURL((u) => u.pathname === '/'), page.click('button[type=submit]')]);
    await page.evaluate(() => { location.hash = '#/term/alpha'; });
    await page.getByRole('region', { name: 'Windows' }).waitFor({ state: 'visible' });
    await sleep(2500);
    await page.screenshot({ path: `${OUT}/screenshot.png` });
  } finally { await browser.close(); }
});
