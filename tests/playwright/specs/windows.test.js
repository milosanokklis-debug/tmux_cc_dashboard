'use strict';
// AC-4.2..4.4: Windows panel, approvals inside it, and the removed account/agent UI. API stubbed (projectPage in lib.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { eventually, launch, projectPage } = require('./lib');

const WINDOWS = [
  { id: '@1', index: 0, name: 'claude', active: true, kind: 'claude', pid: 1 },
  { id: '@2', index: 1, name: 'shell', active: false, kind: 'shell', pid: 2 },
];
let browser;
test.before(async () => { browser = await launch(); });
test.after(async () => { await browser.close(); });

async function open(opts) {
  const t = await projectPage(browser, { windows: WINDOWS, ...opts });
  await t.page.evaluate(() => { location.hash = '#/term/ph'; });
  const region = t.page.getByRole('region', { name: 'Windows' });
  await region.waitFor({ state: 'visible', timeout: 5000 });
  return { ...t, region };
}

test('AC-4.2 lists one item per window with name and kind', async () => {
  const { context, region } = await open();
  try {
    const items = region.getByRole('listitem');
    await eventually(async () => assert.equal(await items.count(), 2), 'two rows', 5000);
    assert.match(await items.nth(0).innerText(), /claude/i);
    assert.match(await items.nth(1).innerText(), /shell/i);
  } finally { await context.close(); }
});

test('AC-4.2 New shell and New Claude window POST the kind and the row appears', async () => {
  const { context, region, seen } = await open();
  try {
    await region.getByRole('button', { name: 'New shell' }).click();
    await eventually(async () => assert.ok(seen.posts.some((p) => /POST \/api\/projects\/ph\/windows \{"kind":"shell"\}/.test(p))), 'shell POST', 5000);
    await eventually(async () => assert.equal(await region.getByRole('listitem').count(), 3), 'third row', 5000);
    await region.getByRole('button', { name: 'New Claude window' }).click();
    await eventually(async () => assert.ok(seen.posts.some((p) => /windows \{"kind":"claude"\}/.test(p))), 'claude POST', 5000);
    await eventually(async () => assert.equal(await region.getByRole('listitem').count(), 4), 'fourth row', 5000);
  } finally { await context.close(); }
});

test('AC-4.2 closing a claude window asks first; the row goes away', async () => {
  const { context, page, region, seen } = await open();
  try {
    const row = region.getByRole('listitem').filter({ hasText: /claude/i }).first();
    let asked = 0;
    page.on('dialog', (d) => { asked += 1; d.accept(); });
    await row.getByRole('button', { name: 'Close' }).click();
    // a confirm may be a native dialog or an in-page dialog; accept either
    const confirm = page.getByRole('dialog').getByRole('button', { name: /^(Close|Yes|Confirm)/ });
    const inPage = await confirm.count();
    if (inPage) await confirm.first().click();
    await eventually(async () => assert.ok(seen.posts.some((p) => /POST \/api\/projects\/ph\/windows\/@1\/close/.test(p))), 'close POST', 5000);
    await eventually(async () => assert.equal(await region.getByRole('listitem').count(), 1), 'row removed', 5000);
    assert.ok(asked > 0 || inPage > 0, 'a confirmation was shown');
  } finally { await context.close(); }
});

test('AC-4.2 closing a claude window does nothing until confirmed (dismissed dialog)', async () => {
  const { context, page, region, seen } = await open();
  try {
    page.on('dialog', (d) => d.dismiss());
    const row = region.getByRole('listitem').filter({ hasText: /claude/i }).first();
    await row.getByRole('button', { name: 'Close' }).click();
    await page.waitForTimeout(300);
    assert.ok(!seen.posts.some((p) => /close/.test(p)), 'no close POST without confirmation');
    assert.equal(await region.getByRole('listitem').count(), 2);
  } finally { await context.close(); }
});

test('AC-4.2 clicking a row POSTs select', async () => {
  const { context, region, seen } = await open();
  try {
    await region.getByRole('listitem').filter({ hasText: /shell/i }).first().click();
    await eventually(async () => assert.ok(seen.posts.some((p) => /POST \/api\/projects\/ph\/windows\/@2\/select/.test(p))), 'select POST', 5000);
  } finally { await context.close(); }
});

test('AC-4.3 a pending approval shows Allow and Deny inside the Windows region', async () => {
  const { context, region, seen } = await open({ approval: { id: 'ap1', tool: 'Bash', input: { command: 'ls' } } });
  try {
    await region.getByRole('button', { name: /^(Allow|Approve)$/ }).waitFor({ state: 'visible', timeout: 5000 });
    await region.getByRole('button', { name: 'Deny' }).waitFor({ state: 'visible', timeout: 5000 });
    await region.getByRole('button', { name: /^(Allow|Approve)$/ }).click();
    await eventually(async () => assert.ok(seen.posts.some((p) => /\/api\/approvals\/ap1\/decision \{"behavior":"allow"\}/.test(p))), 'decision POST', 5000);
  } finally { await context.close(); }
});

test('AC-4.4 no Agents panel, account select or Claude accounts section', async () => {
  const { context, page } = await open();
  try {
    assert.equal(await page.getByRole('heading', { name: 'Agents' }).count(), 0, 'Agents heading');
    assert.equal(await page.getByRole('button', { name: 'Agents' }).count(), 0, 'Agents toggle');
    assert.equal(await page.getByRole('combobox', { name: /account/i }).count(), 0, 'account select');
    await page.evaluate(() => { location.hash = '#/'; });
    await page.getByRole('button', { name: /Settings/ }).click();
    await page.getByRole('dialog').waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('heading', { name: /Claude accounts/i }).count(), 0, 'Claude accounts section');
  } finally { await context.close(); }
});

test('AC-4.4 the Windows region is reachable by keyboard', async () => {
  const { context, page, region } = await open();
  try {
    const btn = region.getByRole('button', { name: 'New shell' });
    await btn.focus();
    assert.equal(await btn.evaluate((e) => e === document.activeElement), true);
    await page.keyboard.press('Enter');
    await eventually(async () => assert.equal(await region.getByRole('listitem').count(), 3), 'row via keyboard', 5000);
  } finally { await context.close(); }
});
