'use strict';
// selectWindow with a grouped viewer session attached: display-message answers with the viewer session
// (web-1) and the group (claude-a); the window still belongs to project a.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');

const { req, ORIGIN } = h;
const post = (s, p) => req(s.base, p, { method: 'POST', headers: { origin: ORIGIN, 'x-ccdash': '1' }, json: {}, cookie: s.cookie });

function svcWith(owner) {
  const svc = h.fakeServices();
  fs.mkdirSync(path.join(svc.workspace, 'a'));
  svc.calls.tmux = [];
  svc.runFile = async (file, args) => { svc.calls.runFile.push([file, ...args]); return { stdout: 'logged-in\n', stderr: '' }; };
  svc.tmux.run = async (argv) => {
    svc.calls.tmux.push(argv);
    if (argv[0] === 'display-message') return `${owner}\n`;
    if (argv[0] === 'list-sessions') return 'claude-a\tclaude-a\t0\nweb-1\tclaude-a\t1\n';
    return '';
  };
  return svc;
}

test('select accepts a window owned by a viewer session grouped with the project session', async (t) => {
  const svc = svcWith('web-1\tclaude-a');
  const s = await h.authed(svc);
  t.after(s.stop);
  const r = await post(s, '/api/projects/a/windows/%405/select');
  assert.strictEqual(r.status, 200);
  assert.ok(svc.calls.tmux.some((c) => c[0] === 'select-window' && c[2] === 'web-1:@5'));
});

test('select still refuses a viewer session grouped with another project', async (t) => {
  const svc = svcWith('web-2\tclaude-b');
  const s = await h.authed(svc);
  t.after(s.stop);
  assert.strictEqual((await post(s, '/api/projects/a/windows/%405/select')).status, 404);
});
