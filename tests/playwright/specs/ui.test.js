'use strict';
// Approve and Deny from a phone-sized browser reach the right conversation; the prompt box follows the status.
// Needs conversations pa and pb (waiting, fake claude) started by tests/stack/phase-c.sh.
const test = require('node:test');
const assert = require('node:assert/strict');
const { OUT, USER, PASS, eventually, launch, phoneContext, apiGet, login } = require('./lib');

// ---- local helpers (lib.js is locked and still waits for the removed agent tree) ----
const conv = (project) => `[data-testid="conversation"]:is([data-project="${project}"], :not([data-project]))`;

// Opens the terminal view of a project and expands the Windows panel (collapsed behind its toggle on a phone).
async function openProject(page, project) {
  if (await page.evaluate(() => location.hash) !== `#/term/${project}`) await page.evaluate((p) => { location.hash = `#/term/${p}`; }, project);
  await page.locator('#view-terminal').waitFor({ state: 'visible' });
  const toggle = page.locator('#tree-toggle');
  if (await toggle.isVisible() && (await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page.locator('#windows').waitFor({ state: 'visible' });
}

// The live conversation item of a project in the Windows panel. Test ids repeat per item, so scope by it.
// States from /events carry no project yet; until they do every conversation is listed and the first is used.
async function card(page, project) {
  await openProject(page, project);
  return page.locator(`${conv(project)}:not([data-status="ended"]):not([data-status="sleeping"])`).first();
}

let browser, context, page;
// Types a prompt in the item's prompt box and presses Send.
async function sendPrompt(page, project, text) {
  const c = await card(page, project);
  const box = c.getByTestId('prompt');
  await eventually(async () => { if (await box.isDisabled()) throw new Error('prompt box disabled'); }, `prompt box of ${project} enabled`);
  await box.fill(text);
  await c.getByTestId('send').click();
}

// Status (from the item) and pane text (preview endpoint) of a project's live conversation.
async function previewText(page, project) {
  const c = await card(page, project);
  const sid = await c.getAttribute('data-sid');
  const status = await c.getAttribute('data-status');
  const pv = await apiGet(page, `/api/conversations/${sid}/preview`);
  return { sid, status, text: pv.text };
}

test.before(async () => {
  browser = await launch();
  context = await phoneContext(browser);
  page = await context.newPage();
  await login(page);
});
test.after(async () => { await context.close(); await browser.close(); });

const waitingBoxEnabled = (project) => eventually(async () => {
  assert.equal(await (await card(page, project)).getByTestId('prompt').isDisabled(), false);
}, `${project}: prompt box enabled`);

test('approval cards appear on the right conversations; Approve one and Deny the other with a message', async () => {
  await waitingBoxEnabled('pa');
  await waitingBoxEnabled('pb');
  await sendPrompt(page, 'pa', '/perm');
  await sendPrompt(page, 'pb', '/perm');
  for (const p of ['pa', 'pb']) {
    await card(page, p).getByTestId('approval-card').waitFor({ state: 'visible', timeout: 20000 });
    assert.equal(await card(page, p).getByTestId('approval-card').count(), 1);
    assert.equal(await card(page, p).getByTestId('approval-tool').innerText(), 'Bash');
  }
  // The status of each conversation, as the server sees it: both wait on a decision.
  assert.equal((await previewText(page, 'pa')).status, 'needs_approval');
  assert.equal((await previewText(page, 'pb')).status, 'needs_approval');
  await page.screenshot({ path: `${OUT}/approval-card.png`, fullPage: false });
  await (await card(page, 'pa')).getByTestId('approval-card').scrollIntoViewIfNeeded();
  await (await card(page, 'pa')).getByTestId('approval-card').screenshot({ path: `${OUT}/approval-card-element.png` });

  await (await card(page, 'pa')).getByTestId('approve').click();
  await (await card(page, 'pb')).getByTestId('deny-message').fill('nope-xyz');
  await (await card(page, 'pb')).getByTestId('deny').click();

  for (const p of ['pa', 'pb']) {
    await eventually(async () => assert.equal(await card(page, p).getByTestId('approval-card').count(), 0), `${p}: approval card gone`);
  }
  await eventually(async () => {
    const a = await previewText(page, 'pa');
    const b = await previewText(page, 'pb');
    assert.match(a.text, /permission: allow/);
    assert.doesNotMatch(a.text, /permission: deny|nope-xyz/);
    assert.match(b.text, /permission: deny/);
    assert.match(b.text, /permission-message: nope-xyz/);
    assert.doesNotMatch(b.text, /permission: allow/);
  }, 'pane of pa shows allow, pane of pb shows deny and the message');
});

test('the prompt box is disabled while working and enabled when waiting', async () => {
  await waitingBoxEnabled('pa');
  const c = await card(page, 'pa');
  await sendPrompt(page, 'pa', '/long');
  await eventually(async () => {
    assert.equal(await c.getByTestId('prompt').isDisabled(), true);
    assert.equal(await c.getByTestId('send').isDisabled(), true);
    assert.equal(await c.getByTestId('interrupt').isDisabled(), false);
  }, 'pa working: prompt and Send disabled, Interrupt enabled');
  await c.getByTestId('interrupt').click();
  await waitingBoxEnabled('pa');
  assert.equal(await c.getByTestId('interrupt').isDisabled(), true);
  // Not waiting means disabled too: pb is untouched and waiting, so it stays enabled throughout.
  assert.equal(await (await card(page, 'pb')).getByTestId('prompt').isDisabled(), false);
});
