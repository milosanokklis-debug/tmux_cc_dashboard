'use strict';
// One desktop screenshot of the terminal view with the conversation cards for the README (tests/stack/phase-g.sh with SCREENSHOT=1).
const test = require('node:test');
const { OUT, BASE, eventually, launch, login, sleep } = require('./lib');

test('desktop screenshot of the terminal view with the conversation cards', async () => {
  const browser = await launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 1, baseURL: BASE, serviceWorkers: 'block' });
    const page = await context.newPage();
    await login(page, 'alpha');
    await eventually(async () => { if ((await page.getByTestId('tree-node').count()) < 3) throw new Error('nodes'); }, 'three conversations');
    await sleep(2500);
    await page.screenshot({ path: `${OUT}/screenshot.png` });
  } finally { await browser.close(); }
});
