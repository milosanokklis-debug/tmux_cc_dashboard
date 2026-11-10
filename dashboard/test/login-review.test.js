'use strict';
// Step 3 review regressions: exact login pane target, strict sign-in URL, select owner check,
// auth "unknown" -> null, session-name collisions refused at add.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');

const { req, ORIGIN } = h;
const post = (s, p, json) => req(s.base, p, { method: 'POST', headers: { origin: ORIGIN, 'x-ccdash': '1' }, json, cookie: s.cookie });
const get = (s, p) => req(s.base, p, { cookie: s.cookie });

function svcWith({ auth = 'logged-out\n', pane = '', names = ['x', 'xy'], tmuxRun } = {}) {
  const svc = h.fakeServices();
  for (const n of names) fs.mkdirSync(path.join(svc.workspace, n));
  svc.calls.tmux = [];
  svc.runFile = async (file, args) => {
    svc.calls.runFile.push([file, ...args]);
    if (args[0] === 'auth') return { stdout: auth, stderr: '' };
    return { stdout: `claude-${args[1]}\n`, stderr: '' };
  };
  svc.tmux.run = tmuxRun || (async (argv) => { svc.calls.tmux.push(argv); return argv[0] === 'capture-pane' ? pane : ''; });
  return svc;
}
const loginUrl = async (pane) => {
  const s = await h.authed(svcWith({ pane }));
  try { return (await (await get(s, '/api/projects/x/login')).json()).url; } finally { await s.stop(); }
};

test('login pane is read with exact session and window anchors', async (t) => {
  const OTHER = 'https://claude.ai/oauth/authorize?state=XY';
  const svc = svcWith();
  svc.tmux.run = async (argv) => {
    svc.calls.tmux.push(argv);
    if (argv[0] !== 'capture-pane') return '';
    const target = argv[argv.indexOf('-t') + 1];
    if (target === '=claude-x:=login') return '';
    if (/^claude-x:login$|^claude-x:/.test(target)) return OTHER; // prefix-matched claude-xy
    throw new Error('no such pane');
  };
  const s = await h.authed(svc);
  t.after(s.stop);
  const j = await (await get(s, '/api/projects/x/login')).json();
  assert.strictEqual(j.url, null);
  assert.ok(svc.calls.tmux.some((a) => a[0] === 'capture-pane' && a.includes('=claude-x:=login')));
});

test('sign-in URL: only https on claude.com, claude.ai or anthropic.com (or subdomains)', async () => {
  assert.strictEqual(await loginUrl('go to https://evil.example/oauth/authorize?x=1'), null);
  assert.strictEqual(await loginUrl('https://claude.com.evil.example/oauth'), null);
  assert.strictEqual(await loginUrl('https://notclaude.ai/oauth'), null);
  assert.strictEqual(await loginUrl('http://claude.ai/oauth'), null);
  const real = 'https://claude.com/cai/oauth/authorize?code=true&state=S';
  assert.strictEqual(await loginUrl(`Visit ${real}\npaste`), real);
  assert.strictEqual(await loginUrl('https://console.anthropic.com/oauth/x'), 'https://console.anthropic.com/oauth/x');
});

test('sign-in URL: prefers the link whose path has oauth, ignores other links', async () => {
  const real = 'https://claude.com/cai/oauth/authorize?state=S';
  assert.strictEqual(await loginUrl(`docs https://docs.anthropic.com/help\n${real}\nhttps://evil.example/oauth`), real);
  assert.strictEqual(await loginUrl('see https://evil.example/oauth\nhttps://claude.ai/help'), 'https://claude.ai/help');
});

test('auth printing unknown gives loggedIn:null', async (t) => {
  const s = await h.authed(svcWith({ auth: 'unknown\n' }));
  t.after(s.stop);
  assert.strictEqual((await (await get(s, '/api/projects/x/login')).json()).loggedIn, null);
});

test('select needs an owner session equal to the project session', async (t) => {
  for (const owner of ['', 'claude-xy\tg', 'web-1\t']) {
    const calls = [];
    const svc = svcWith({ tmuxRun: async (argv) => {
      calls.push(argv);
      if (argv[0] === 'display-message') return `${owner}\n`;
      return '';
    } });
    const s = await h.authed(svc);
    try {
      const r = await post(s, '/api/projects/x/windows/%405/select');
      assert.strictEqual(r.status, 404, `owner ${JSON.stringify(owner)}`);
      assert.ok(!calls.some((a) => a[0] === 'select-window'));
    } finally { await s.stop(); }
  }
  const calls = [];
  const svc = svcWith({ tmuxRun: async (argv) => { calls.push(argv); return argv[0] === 'display-message' ? 'claude-x\t\n' : ''; } });
  const s = await h.authed(svc);
  t.after(s.stop);
  assert.strictEqual((await post(s, '/api/projects/x/windows/%405/select')).status, 200);
  assert.ok(calls.some((a) => a[0] === 'select-window'));
});

test('add refuses a project whose tmux session name collides with an existing one', async (t) => {
  const svc = svcWith({ names: ['a_b'] });
  const s = await h.authed(svc);
  t.after(s.stop);
  const r = await post(s, '/api/projects', { repo: 'o/a.b' });
  assert.strictEqual(r.status, 409);
  assert.match((await r.json()).error, /a_b/);
  assert.strictEqual(svc.calls.runOp.length, 0);
});
