'use strict';
// Shared helpers. Project ph is only the page the browser opens (its terminal view attaches a tmux client,
// which redraws that project's pane), so no test uses ph's conversation. The browser runs in a container that shares the dashboard container's network
// namespace, so http://localhost:7690 is the dashboard (the default allowed Origin).
const fs = require('node:fs');
const { chromium, devices } = require('playwright');

const BASE = process.env.CCDASH_URL || 'http://localhost:7690';
const USER = process.env.CCDASH_USER || 't';
const PASS = process.env.CCDASH_PASS || 'test-password-123';
const OUT = process.env.OUT_DIR || '/out';
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry fn until it stops throwing (or returns without throwing), for up to `ms`.
async function eventually(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try { return await fn(); } catch (e) { last = e; }
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms: ${what}: ${last && last.message}`);
    await sleep(150);
  }
}

async function launch() {
  // Not the default headless shell: it reports Notification.permission as denied whatever the context grants.
  return chromium.launch({ channel: 'chromium' });
}

// A phone: Pixel 5 (393x851, touch, mobile UA), notifications allowed, service workers on.
async function phoneContext(browser, extra = {}) {
  const context = await browser.newContext({ ...devices['Pixel 5'], baseURL: BASE, serviceWorkers: 'allow', ...extra });
  await context.grantPermissions(['notifications'], { origin: BASE });
  return context;
}

async function login(page, home = 'ph') {
  await page.goto('/login');
  await page.fill('#username', USER);
  await page.fill('#password', PASS);
  await Promise.all([page.waitForURL((u) => u.pathname === '/'), page.click('button[type=submit]')]);
  // The agents panel lives in a project's terminal view; on a phone it starts collapsed behind the
  // "Agents" button, and it only lists the current project until "All projects" is ticked.
  await page.evaluate((p) => { location.hash = `#/term/${p}`; }, home);
  await page.locator('#view-terminal').waitFor({ state: 'visible' });
  if ((await page.locator('#tree-toggle').getAttribute('aria-expanded')) !== 'true') await page.click('#tree-toggle');
  const all = page.locator('#tree-all-projects');
  await all.waitFor({ state: 'visible' });
  if (!(await all.isChecked())) await all.check();
}

// The conversation card of a project. Test ids repeat per card, so always scope by it.
const card = (page, project) => page
  .locator('li.project', { has: page.locator('h3.project-name', { hasText: new RegExp(`^${project}$`) }) })
  .locator('li.conv').first();

// Calls the dashboard API with the page's session cookie (same-origin, with the CSRF headers).
async function apiGet(page, path) {
  return page.evaluate(async (p) => (await fetch(p, { credentials: 'same-origin' })).json(), path);
}

async function previewText(page, project) {
  const tree = await apiGet(page, '/api/tree?all=1');
  const conv = tree.projects.find((p) => p.project === project).conversations.find((c) => c.status !== 'ended' && c.status !== 'sleeping');
  const pv = await apiGet(page, `/api/conversations/${conv.sid}/preview`);
  return { sid: conv.sid, status: conv.status, text: pv.text };
}

// Types a prompt in a card's prompt box and presses Send.
async function sendPrompt(page, project, text) {
  const c = card(page, project);
  const box = c.getByTestId('prompt');
  await eventually(async () => { if (await box.isDisabled()) throw new Error('prompt box disabled'); }, `prompt box of ${project} enabled`);
  await box.fill(text);
  await c.getByTestId('send').click();
}


// Step 4 (project sessions): a signed-in desktop page with the per-project API stubbed (no tmux, no logins).
// opts: loggedIn (bool, default true), windows (array), url (sign-in URL), approval ({id,tool,input}) pushed on /events.
// Returns { context, page, seen } where seen.posts lists "METHOD path [json body]" for every stubbed write.
async function projectPage(browser, opts = {}) {
  const state = { loggedIn: opts.loggedIn !== false, windows: [...(opts.windows || [])], next: 10 };
  const url = opts.url || 'https://claude.ai/oauth/authorize?code=true&state=stub';
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: BASE, serviceWorkers: 'block' });
  const page = await context.newPage();
  const seen = { posts: [] };
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(/\/api\/projects$/, (route) => {
    if (route.request().method() === 'POST') return json(route, 200, { project: 'ph' });
    return json(route, 200, { projects: [{ name: 'ph', state: 'claude' }] });
  });
  await page.route(/\/api\/projects\/[^/]+\/(login|windows|open)(\/.*)?$/, (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const m = req.method();
    if (m !== 'GET') seen.posts.push(`${m} ${path}${req.postData() ? ' ' + req.postData() : ''}`);
    if (/\/login$/.test(path)) return json(route, 200, { loggedIn: state.loggedIn, url: state.loggedIn ? null : url });
    if (/\/open$/.test(path)) return state.loggedIn ? json(route, 200, { ok: true }) : json(route, 409, { error: 'login-required' });
    if (/\/windows$/.test(path) && m === 'GET') return json(route, 200, { windows: state.windows });
    if (/\/windows$/.test(path)) {
      const kind = JSON.parse(req.postData() || '{}').kind;
      const id = `@${state.next++}`;
      state.windows.push({ id, index: state.windows.length, name: kind, active: false, kind, pid: state.next });
      return json(route, 200, { id });
    }
    const close = path.match(/\/windows\/([^/]+)\/close$/);
    if (close) { state.windows = state.windows.filter((w) => w.id !== decodeURIComponent(close[1])); return json(route, 200, { ok: true }); }
    return json(route, 200, { ok: true });
  });
  await page.route(/\/api\/approvals\/[^/]+\/decision$/, (route) => {
    seen.posts.push(`POST ${new URL(route.request().url()).pathname} ${route.request().postData() || ''}`);
    return json(route, 200, { ok: true });
  });
  await page.routeWebSocket(/\/events$/, (ws) => {
    const states = opts.approval ? { s1: { project: 'ph', status: 'needs_approval', approval: { truncated: false, since: 1, ...opts.approval } } } : {};
    ws.send(JSON.stringify({ type: 'state', states }));
  });
  await page.routeWebSocket(/\/term\//, () => { /* no terminal behind the stub */ });
  await page.goto('/login');
  await page.fill('#username', USER);
  await page.fill('#password', PASS);
  await Promise.all([page.waitForURL((u) => u.pathname === '/'), page.click('button[type=submit]')]);
  await page.locator('#project-list li.card').first().waitFor();
  return { context, page, seen, state };
}

module.exports = {
  projectPage, BASE, USER, PASS, OUT, sleep, eventually, launch, phoneContext, login, card, apiGet, previewText, sendPrompt };
