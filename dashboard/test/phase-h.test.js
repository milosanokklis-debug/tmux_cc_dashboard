'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');

const { req, ORIGIN } = h;
const POSTH = { origin: ORIGIN, 'x-ccdash': '1' };
const post = (s, p, json) => req(s.base, p, { method: 'POST', headers: POSTH, json, cookie: s.cookie });
const get = (s, p) => req(s.base, p, { cookie: s.cookie });

const HEAD = 'c'.repeat(40);
const KIT = { version: '0.9.2', packs: ['kit-core', 'kit-design'], memory: 'connected' };

function setup(record = { repo: 'octo/demo', head: HEAD, kit: KIT }) {
  const svc = h.fakeServices();
  fs.mkdirSync(path.join(svc.workspace, 'demo'));
  fs.mkdirSync(svc.projectsDir);
  if (record) fs.writeFileSync(path.join(svc.projectsDir, 'demo.json'), JSON.stringify(record));
  return svc;
}
// svc.runOp is captured when the server starts, so call withOp before h.authed and switch behaviour through svc.next.
const withOp = (svc, fn) => { svc.next = fn; svc.runOp = async (o) => { svc.calls.runOp.push(o.argv); return svc.next(o); }; };
const kitErr = (n, msg) => ({ rc: 8, log: `kit-error ${n} ${msg}\nline one\nline two\n` });

test('GET /api/projects carries kit {version, packs, memory}; null without a record or with a bad one', async (t) => {
  const svc = setup({ repo: 'octo/demo', head: HEAD, kit: { ...KIT, memory: 'weird' } });
  fs.mkdirSync(path.join(svc.workspace, 'bad'));
  fs.writeFileSync(path.join(svc.projectsDir, 'bad.json'), JSON.stringify({ repo: 'o/bad', kit: { version: 'x y', packs: ['kit-core'] } }));
  fs.mkdirSync(path.join(svc.workspace, 'plain'));
  const s = await h.authed(svc);
  t.after(s.stop);
  const by = Object.fromEntries((await (await get(s, '/api/projects')).json()).projects.map((p) => [p.name, p]));
  assert.deepStrictEqual(by.demo.kit, { version: '0.9.2', packs: ['kit-core', 'kit-design'], memory: 'unknown' });
  assert.strictEqual(by.bad.kit, null);
  assert.strictEqual(by.plain.kit, null);
});

test('POST /api/projects passes --design/--code only when true; non-booleans are 400', async (t) => {
  const svc = h.fakeServices();
  const s = await h.authed(svc);
  t.after(s.stop);
  assert.strictEqual((await post(s, '/api/projects', { repo: 'octo/one', design: true, code: true })).status, 200);
  assert.strictEqual((await post(s, '/api/projects', { repo: 'octo/two', design: false })).status, 200);
  assert.deepStrictEqual(svc.calls.runOp, [['ccd-onboard', '--design', '--code', 'octo/one'], ['ccd-onboard', 'octo/two']]);
  for (const body of [{ design: 'yes' }, { code: 1 }, { design: null }]) {
    const r = await post(s, '/api/projects', { repo: 'octo/three', ...body });
    assert.strictEqual(r.status, 400, JSON.stringify(body));
  }
  assert.strictEqual(svc.calls.runOp.length, 2);
});

test('kit failure (exit 8) -> 409 kit-failed with code, message and log; no session is started', async (t) => {
  const svc = h.fakeServices();
  withOp(svc, () => kitErr(4, 'Kit marketplace failed (network?); retry once the network is back'));
  const s = await h.authed(svc);
  t.after(s.stop);
  const r = await post(s, '/api/projects', { repo: 'octo/hello' });
  assert.strictEqual(r.status, 409);
  assert.deepStrictEqual(await r.json(), {
    error: 'kit-failed', code: 4, message: 'Kit marketplace failed (network?); retry once the network is back', log: 'line one\nline two',
  });
  assert.deepStrictEqual(svc.calls.runFile, []);
});

test('pull: kit failure maps the same way; the head used is the last head line', async (t) => {
  const svc = setup();
  withOp(svc, () => kitErr(5, 'Plugin install or update failed; retry'));
  const s = await h.authed(svc);
  t.after(s.stop);
  const r = await post(s, '/api/projects/demo/pull', {});
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await r.json()).error, 'kit-failed');
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  svc.next = () => ({ rc: 0, log: `old aaaaaaa\npulled\nhead ${A}\nkit 0.9.2 changed\nhead ${B}\n` });
  const j = await (await post(s, '/api/projects/demo/pull', {})).json();
  assert.strictEqual(j.head, B.slice(0, 7));
});

test('POST /api/projects/:proj/packs: explicit flags both ways, returns the summary, never starts a session', async (t) => {
  const svc = setup();
  withOp(svc, () => {
    fs.writeFileSync(path.join(svc.projectsDir, 'demo.json'),
      JSON.stringify({ repo: 'octo/demo', head: HEAD, kit: { version: '0.9.2', packs: ['kit-core', 'kit-code'], memory: 'missing' } }));
    return { rc: 0, log: `kit 0.9.2 changed\npacks kit-core,kit-code\nmemory missing\nhead ${HEAD}\n` };
  });
  const s = await h.authed(svc);
  t.after(s.stop);
  const r = await post(s, '/api/projects/demo/packs', { design: false, code: true });
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.deepStrictEqual(svc.calls.runOp, [['ccd-onboard', '--no-design', '--code', 'octo/demo']]);
  assert.deepStrictEqual({ name: j.name, state: j.state, repo: j.repo, head: j.head, kit: j.kit },
    { name: 'demo', state: 'none', repo: 'octo/demo', head: 'ccccccc', kit: { version: '0.9.2', packs: ['kit-core', 'kit-code'], memory: 'missing' } });
  assert.deepStrictEqual(svc.calls.runFile, []);
  await post(s, '/api/projects/demo/packs', { design: true, code: false });
  assert.deepStrictEqual(svc.calls.runOp[1], ['ccd-onboard', '--design', '--no-code', 'octo/demo']);
});

test('packs: validation, missing record, kit failure, hooks refusal', async (t) => {
  const svc = setup();
  withOp(svc, () => ({ rc: 0, log: '' }));
  const s = await h.authed(svc);
  t.after(s.stop);
  for (const body of [{}, { design: true }, { design: 'x', code: true }, { design: true, code: 0 }]) {
    assert.strictEqual((await post(s, '/api/projects/demo/packs', body)).status, 400, JSON.stringify(body));
  }
  assert.strictEqual((await post(s, '/api/projects/..%2Fx/packs', { design: true, code: true })).status, 400);
  assert.strictEqual((await post(s, '/api/projects/nothere/packs', { design: true, code: true })).status, 404);
  assert.strictEqual((await get(s, '/api/projects/demo/packs')).status, 405);
  assert.strictEqual(svc.calls.runOp.length, 0);
  svc.next = () => kitErr(6, 'Could not write project files');
  let r = await post(s, '/api/projects/demo/packs', { design: true, code: true });
  assert.strictEqual(r.status, 409);
  assert.deepStrictEqual(await r.json(), { error: 'kit-failed', code: 6, message: 'Could not write project files', log: 'line one\nline two' });
  svc.next = () => ({ rc: 5, log: 'hooks: Stop\n' });
  r = await post(s, '/api/projects/demo/packs', { design: true, code: true });
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await r.json()).error, 'repo-has-hooks');
  fs.unlinkSync(path.join(svc.projectsDir, 'demo.json'));
  assert.strictEqual((await post(s, '/api/projects/demo/packs', { design: true, code: true })).status, 409);
});

test('pull during packs, and packs during pull, are 409 (one lock per project)', async (t) => {
  const svc = setup();
  let release;
  const gate = new Promise((r) => { release = r; });
  withOp(svc, async () => { await gate; return { rc: 0, log: `head ${HEAD}\n` }; });
  const s = await h.authed(svc);
  t.after(s.stop);
  const flags = { design: true, code: true };
  const packing = post(s, '/api/projects/demo/packs', flags);
  await new Promise((r) => setTimeout(r, 100));
  let r = await post(s, '/api/projects/demo/pull', {});
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await r.json()).error, 'another change to this project is in progress');
  release();
  assert.strictEqual((await packing).status, 200);

  let release2;
  const gate2 = new Promise((x) => { release2 = x; });
  svc.next = async () => { await gate2; return { rc: 0, log: `head ${HEAD}\n` }; };
  const pulling = post(s, '/api/projects/demo/pull', {});
  await new Promise((x) => setTimeout(x, 100));
  r = await post(s, '/api/projects/demo/packs', flags);
  assert.strictEqual(r.status, 409);
  release2();
  assert.strictEqual((await pulling).status, 200);
  assert.strictEqual((await post(s, '/api/projects/demo/packs', flags)).status, 200); // lock released
});
