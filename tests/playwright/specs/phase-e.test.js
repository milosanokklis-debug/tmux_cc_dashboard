'use strict';
// Phase E in a browser, against the stack of tests/stack/phase-e.sh (10 live conversations, SUB_PROJECT has a
// subagent): at 390x844 and 1280x800 the cards view, the Usage panel, the agent tree and a subagent transcript
// sheet, with screenshots in OUT_DIR; and an idle cards view that makes no HTTP requests, only the /events socket.
const test = require('node:test');
const assert = require('node:assert/strict');
const { OUT, BASE, USER, PASS, sleep, eventually, launch } = require('./lib');

const EXPECT_GAUGES = process.env.EXPECT_GAUGES || 'unknown';
const SUB = process.env.SUB_PROJECT || 'l1';
const MIN_CARDS = Number(process.env.MIN_CARDS || 10);
const IDLE_SEC = Number(process.env.IDLE_SEC || 15);

let browser;
test.before(async () => { browser = await launch(); });
test.after(async () => { await browser.close(); });

async function signedIn(viewport) {
  const context = await browser.newContext({ viewport, baseURL: BASE, serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.goto('/login');
  await page.fill('#username', USER);
  await page.fill('#password', PASS);
  await Promise.all([page.waitForURL((u) => u.pathname === '/'), page.click('button[type=submit]')]);
  return { context, page };
}

for (const [w, h] of [[390, 844], [1280, 800]]) {
  test(`${w}x${h}: cards, Usage panel, tree, subagent transcript`, async () => {
    const { context, page } = await signedIn({ width: w, height: h });
    try {
      await eventually(async () => assert.ok((await page.locator('#project-list li.card').count()) >= MIN_CARDS), `at least ${MIN_CARDS} conversation cards`);
      await page.screenshot({ path: `${OUT}/cards-${w}.png`, fullPage: true });

      await page.getByTestId('usage').click();
      await page.getByTestId('usage-panel').waitFor({ state: 'visible' });
      for (const k of ['five_hour', 'seven_day']) {
        const g = page.getByTestId(`gauge-${k}`);
        await eventually(async () => assert.equal(await g.getAttribute('data-status'), EXPECT_GAUGES), `gauge ${k} is ${EXPECT_GAUGES}`);
        if (EXPECT_GAUGES === 'unknown') assert.match(await g.innerText(), /unknown/i);
      }
      await page.getByTestId('token-table').waitFor({ state: 'visible' });
      assert.ok((await page.getByTestId('token-row').count()) >= 1, 'token table has rows');
      assert.ok((await page.getByTestId('price-note').first().innerText()).length > 0);
      await page.screenshot({ path: `${OUT}/usage-${w}.png` });
      await page.keyboard.press('Escape');
      await page.getByTestId('usage-panel').waitFor({ state: 'hidden' });

      await page.evaluate((p) => { location.hash = `#/term/${p}`; }, SUB);
      await page.locator('#view-terminal').waitFor({ state: 'visible' });
      if ((await page.locator('#tree-toggle').getAttribute('aria-expanded')) !== 'true') await page.click('#tree-toggle');
      const all = page.locator('#tree-all-projects');
      await all.waitFor({ state: 'visible' });
      if (!(await all.isChecked())) await all.check();
      await eventually(async () => assert.ok((await page.getByTestId('tree-node').count()) >= MIN_CARDS), 'tree has the conversations');
      await page.screenshot({ path: `${OUT}/tree-${w}.png` });

      const open = page.getByTestId('agent-open').first();
      await open.waitFor({ state: 'visible', timeout: 20000 });
      await open.click();
      await page.getByTestId('transcript-panel').waitFor({ state: 'visible' });
      await eventually(async () => assert.ok((await page.getByTestId('transcript-entry').count()) >= 2), 'transcript entries');
      assert.match(await page.getByTestId('transcript-log').innerText(), /subagent reply/);
      await page.screenshot({ path: `${OUT}/transcript-${w}.png` });
      await page.getByTestId('transcript-close').click();
      await page.getByTestId('transcript-panel').waitFor({ state: 'hidden' });
    } finally { await context.close(); }
  });
}

test('idle cards view: after it settles only the /events socket is open, no HTTP requests', async () => {
  const { context, page: first } = await signedIn({ width: 1280, height: 800 });
  try {
    await first.close();
    const page = await context.newPage(); // a fresh page: a reload would leave a socket of the dying document in the count
    const sockets = [];
    page.on('websocket', (ws) => sockets.push(ws));
    await page.goto('/');
    await eventually(async () => assert.ok((await page.locator('#project-list li.card').count()) >= MIN_CARDS), 'cards loaded');
    await eventually(async () => assert.ok(sockets.some((w) => w.url().endsWith('/events'))), '/events socket opened');
    await sleep(8000); // settle: previews, the one tree fetch, service-worker-free page
    const requests = [];
    page.on('request', (r) => requests.push(`${r.method()} ${r.url()}`));
    await sleep(IDLE_SEC * 1000);
    await page.screenshot({ path: `${OUT}/idle-cards.png`, fullPage: true });
    assert.deepEqual(requests, [], `HTTP requests while idle: ${requests.join(', ')}`);
    const open = sockets.filter((w) => !w.isClosed());
    assert.deepEqual(open.map((w) => w.url()), [`${BASE.replace(/^http/, 'ws')}/events`], 'the only open socket is /events');
    console.log(`idle ${IDLE_SEC}s: 0 HTTP requests; open sockets: ${open.map((w) => w.url()).join(', ')}`);
  } finally { await context.close(); }
});
