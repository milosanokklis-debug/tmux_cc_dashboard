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

test('legacy: design/code body fields are ignored (no flags passed)', async (t) => {
  const svc = h.fakeServices();
  const s = await h.authed(svc);
  t.after(s.stop);
  assert.strictEqual((await post(s, '/api/projects', { repo: 'octo/one', design: true, code: true })).status, 200);
  assert.deepStrictEqual(svc.calls.runOp, [['ccd-onboard', 'octo/one']]);
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

const SECRET = 'ghp_SECRETMARKER';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('POST /api/projects/:proj/kit: both ways, summary + message, no log, audit, no session', async (t) => {
  const svc = setup();
  withOp(svc, () => {
    fs.writeFileSync(path.join(svc.projectsDir, 'demo.json'),
      JSON.stringify({ repo: 'octo/demo', head: HEAD, kitEnabled: true, kit: { version: '0.9.2', packs: ['kit-core'], memory: 'missing' } }));
    return { rc: 0, log: `${SECRET}\nkit 0.9.2 changed\nhead ${HEAD}\n` };
  });
  const events = [];
  const s = await h.authed(svc, { audit: (e, f) => events.push([e, f]) });
  t.after(s.stop);
  let r = await post(s, '/api/projects/demo/kit', { enabled: true });
  assert.strictEqual(r.status, 200);
  const text = await r.text();
  assert.ok(!text.includes(SECRET) && !text.includes('"log"'));
  const j = JSON.parse(text);
  assert.deepStrictEqual(svc.calls.runOp, [['ccd-onboard', '--kit', 'octo/demo']]);
  assert.deepStrictEqual(j, { name: 'demo', session: null, state: 'none', repo: 'octo/demo', head: 'ccccccc',
    kit: { version: '0.9.2', packs: ['kit-core'], memory: 'missing' }, kitEnabled: true, kitCheck: null, kitError: null, message: 'kit enabled and updated' });
  assert.deepStrictEqual(svc.calls.runFile, []);
  r = await post(s, '/api/projects/demo/kit', { enabled: false });
  assert.deepStrictEqual(svc.calls.runOp[1], ['ccd-onboard', '--no-kit', 'octo/demo']);
  assert.deepStrictEqual(events.filter(([e, f]) => e.startsWith('kit.') && f.outcome === 'ok').map(([e, f]) => [e, f.project, f.outcome]), [['kit.enable', 'demo', 'ok'], ['kit.disable', 'demo', 'ok']]);
});

test('kit route: validation, missing record, failures never expose the log', async (t) => {
  const svc = setup();
  withOp(svc, () => ({ rc: 0, log: '' }));
  const s = await h.authed(svc);
  t.after(s.stop);
  for (const body of [{}, { enabled: 'x' }, { enabled: 1 }, { design: true }]) {
    assert.strictEqual((await post(s, '/api/projects/demo/kit', body)).status, 400, JSON.stringify(body));
  }
  assert.strictEqual((await post(s, '/api/projects/..%2Fx/kit', { enabled: true })).status, 400);
  assert.strictEqual((await post(s, '/api/projects/nothere/kit', { enabled: true })).status, 404);
  assert.strictEqual((await get(s, '/api/projects/demo/kit')).status, 405);
  assert.strictEqual((await post(s, '/api/projects/demo/packs', { design: true, code: true })).status, 404);
  assert.strictEqual(svc.calls.runOp.length, 0);
  const cases = [[() => kitErr(6, `x ${SECRET}`), 409], [() => ({ rc: 1, log: SECRET }), 502], [() => ({ rc: 3, log: SECRET }), 409],
    [() => ({ timedOut: true, log: SECRET }), 504], [() => ({ rc: 5, log: 'hooks: Stop\n' }), 409]];
  for (const [fn, status] of cases) {
    svc.next = fn;
    const r = await post(s, '/api/projects/demo/kit', { enabled: true });
    assert.strictEqual(r.status, status);
    const t2 = await r.text();
    assert.ok(!t2.includes('line one') && !t2.includes('"log"') && !t2.includes(`${SECRET}\n`) && !/"log"/.test(t2), t2);
    if (status === 502 || status === 504) assert.ok(!t2.includes(SECRET));
  }
  fs.unlinkSync(path.join(svc.projectsDir, 'demo.json'));
  assert.strictEqual((await post(s, '/api/projects/demo/kit', { enabled: true })).status, 409);
});

test('pull during kit change, and kit change during pull, are 409 (one lock per project)', async (t) => {
  const svc = setup();
  let release;
  const gate = new Promise((r) => { release = r; });
  withOp(svc, async () => { await gate; return { rc: 0, log: `head ${HEAD}\n` }; });
  const s = await h.authed(svc);
  t.after(s.stop);
  const body = { enabled: true };
  const packing = post(s, '/api/projects/demo/kit', body);
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
  r = await post(s, '/api/projects/demo/kit', body);
  assert.strictEqual(r.status, 409);
  release2();
  assert.strictEqual((await pulling).status, 200);
  assert.strictEqual((await post(s, '/api/projects/demo/kit', body)).status, 200);
});

test('POST /api/projects: kit must be boolean; --kit only when true', async (t) => {
  const svc = h.fakeServices();
  const s = await h.authed(svc);
  t.after(s.stop);
  assert.strictEqual((await post(s, '/api/projects', { repo: 'o/r', kit: 'yes' })).status, 400);
  assert.strictEqual(svc.calls.runOp.length, 0);
  await post(s, '/api/projects', { repo: 'o/kon', kit: true });
  await post(s, '/api/projects', { repo: 'o/koff' });
  assert.deepStrictEqual(svc.calls.runOp[0], ['ccd-onboard', '--kit', 'o/kon']);
  assert.deepStrictEqual(svc.calls.runOp[1], ['ccd-onboard', 'o/koff']);
});

test('project list: kitEnabled / kitCheck / kitError; legacy kit entry means enabled', async (t) => {
  const svc = setup({ repo: 'octo/demo', head: HEAD, kit: KIT });
  const mk = (n, rec) => { fs.mkdirSync(path.join(svc.workspace, n)); fs.writeFileSync(path.join(svc.projectsDir, `${n}.json`), JSON.stringify(rec)); };
  mk('off', { repo: 'o/off', kitEnabled: false, kit: KIT });
  mk('on', { repo: 'o/on', kitEnabled: true, kitCheck: { status: 'changed', message: 'ok\u0007\nx', account: 'a', ts: '2026-01-01T00:00:00Z' }, kitError: { code: 6, message: 'bad', log: SECRET } });
  mk('odd', { repo: 'o/odd', kitCheck: { status: 'weird' }, kitError: { code: '6', message: 'x' } });
  const s = await h.authed(svc);
  t.after(s.stop);
  const text = await (await get(s, '/api/projects')).text();
  assert.ok(!text.includes(SECRET));
  const by = Object.fromEntries(JSON.parse(text).projects.map((p) => [p.name, p]));
  assert.strictEqual(by.demo.kitEnabled, true);
  assert.strictEqual(by.off.kitEnabled, false);
  assert.strictEqual(by.odd.kitEnabled, false);
  assert.deepStrictEqual(by.on.kitCheck, { status: 'changed', message: 'ok  x', account: 'a', ts: '2026-01-01T00:00:00Z' });
  assert.deepStrictEqual(by.on.kitError, { code: 6, message: 'bad' });
  assert.strictEqual(by.odd.kitCheck, null);
  assert.strictEqual(by.odd.kitError, null);
  assert.strictEqual(by.demo.kitCheck, null);
});

test('GET /api/kit: parsing, newest-error, updateAvailable, no log', async (t) => {
  const svc = h.fakeServices();
  withOp(svc, () => ({ rc: 0, log: `active ${A} 0.9.2\nimage ${A}\nnewest ${B}\n` }));
  const s = await h.authed(svc);
  t.after(s.stop);
  let j = await (await get(s, '/api/kit')).json();
  assert.deepStrictEqual(j, { active: { sha: A, version: '0.9.2' }, image: { sha: A }, newest: { sha: B }, updateAvailable: true });
  assert.deepStrictEqual(svc.calls.runOp[0], ['ccd-kit', 'check']);
  svc.next = () => ({ rc: 0, log: `active ${A} -\nimage -\nnewest ${A}\n` });
  j = await (await get(s, '/api/kit')).json();
  assert.deepStrictEqual(j, { active: { sha: A, version: null }, image: { sha: null }, newest: { sha: A }, updateAvailable: false });
  svc.next = () => ({ rc: 1, log: `active ${A} 0.9.2\nimage ${A}\nnewest-error cannot read https://x/y\u0007 ${SECRET}\n` });
  const r = await get(s, '/api/kit');
  assert.strictEqual(r.status, 200);
  j = await r.json();
  assert.strictEqual(j.newest, null);
  assert.strictEqual(j.updateAvailable, false);
  assert.ok(j.error.startsWith('cannot read') && !/\u0007/.test(j.error));
  svc.next = () => ({ rc: 1, log: `ccd-kit: boom ${SECRET}\n` });
  let r2 = await get(s, '/api/kit');
  assert.strictEqual(r2.status, 502);
  assert.deepStrictEqual(await r2.json(), { error: 'kit check failed' });
  svc.next = () => ({ timedOut: true, log: SECRET });
  r2 = await get(s, '/api/kit');
  assert.strictEqual(r2.status, 504);
  assert.ok(!(await r2.text()).includes(SECRET));
  assert.strictEqual((await post(s, '/api/kit', {})).status, 405);
});

test('POST /api/kit/update: parses, audits old/new, validation, exit codes, 409 while running', async (t) => {
  const svc = h.fakeServices();
  const OK = `updated ${A} ${B}\nversion 0.9.2 0.9.3\nproject demo changed kit 0.9.3 changed\nproject bad failed ${SECRET.slice(0, 4)} \u0007oops\nproject z ok\n${SECRET}\n`;
  withOp(svc, () => ({ rc: 0, log: OK }));
  const events = [];
  const s = await h.authed(svc, { audit: (e, f) => events.push([e, f]) });
  t.after(s.stop);
  for (const body of [{ reset: 'x' }, { reset: 1 }]) assert.strictEqual((await post(s, '/api/kit/update', body)).status, 400);
  assert.strictEqual(svc.calls.runOp.length, 0);
  let r = await post(s, '/api/kit/update', { reset: true });
  const text = await r.text();
  assert.strictEqual(r.status, 200);
  assert.ok(!text.includes(SECRET) && !text.includes('"log"'));
  assert.deepStrictEqual(JSON.parse(text), { old: A, new: B, versions: { old: '0.9.2', new: '0.9.3' }, projects: [
    { name: 'demo', status: 'changed', message: 'kit 0.9.3 changed' }, { name: 'bad', status: 'failed', message: 'kit step failed' }, { name: 'z', status: 'ok', message: '' }] });
  assert.deepStrictEqual(svc.calls.runOp[0], ['ccd-kit', 'update', '--reset']);
  r = await req(s.base, '/api/kit/update', { method: 'POST', headers: POSTH, cookie: s.cookie }); // no body
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(svc.calls.runOp[1], ['ccd-kit', 'update']);
  assert.deepStrictEqual(events.filter(([e, f]) => e.startsWith('kit.') && f.outcome === 'ok').map(([e, f]) => [e, f.old, f.new, f.outcome]), [['kit.update', A, B, 'ok'], ['kit.update', A, B, 'ok']]);
  for (const [op, status] of [[{ rc: 2, log: SECRET }, 400], [{ rc: 1, log: `ccd-kit: cannot clone x\n${SECRET}` }, 502], [{ rc: 1, log: SECRET }, 502], [{ timedOut: true, log: SECRET }, 504]]) {
    svc.next = () => op;
    r = await post(s, '/api/kit/update', {});
    assert.strictEqual(r.status, status);
    const t2 = await r.text();
    assert.ok(!t2.includes(SECRET), t2);
    if (op.rc === 1 && op.log.startsWith('ccd-kit')) assert.strictEqual(JSON.parse(t2).error, 'cannot clone x');
  }
  assert.strictEqual(events.at(-1)[1].outcome, 'fail');
  let release;
  const gate = new Promise((x) => { release = x; });
  svc.next = async () => { await gate; return { rc: 0, log: OK }; };
  const first = post(s, '/api/kit/update', {});
  await new Promise((x) => setTimeout(x, 100));
  assert.strictEqual((await post(s, '/api/kit/update', {})).status, 409);
  release();
  assert.strictEqual((await first).status, 200);
});

test('kit update: tolerates a log whose head was cut off; status fallback sets truncated', async (t) => {
  const svc = setup();
  const SHA = 'd'.repeat(40);
  const big = `${'x'.repeat(5000)}\nproject demo changed kit 1\nproject bad failed some raw\u0007 text\nproject worse failed kit-error 4 net down\n`;
  withOp(svc, (o) => (o.argv[1] === 'update' ? { rc: 0, log: big } : { rc: 0, log: `active ${SHA} 1.2.3\nimage ${SHA}\n` }));
  const s = await h.authed(svc);
  t.after(s.stop);
  const r = await post(s, '/api/kit/update', {});
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(await r.json(), {
    old: null, new: SHA, versions: { old: null, new: '1.2.3' }, truncated: true,
    projects: [{ name: 'demo', status: 'changed', message: 'kit 1' }, { name: 'bad', status: 'failed', message: 'kit step failed' },
      { name: 'worse', status: 'failed', message: 'kit-error 4 net down' }],
  });
  assert.deepStrictEqual(svc.calls.runOp, [['ccd-kit', 'update'], ['ccd-kit', 'status']]);
  svc.next = (o) => (o.argv[1] === 'update' ? { rc: 0, log: 'junk\n' } : { rc: 1, log: '' });
  const r2 = await post(s, '/api/kit/update', {});
  assert.strictEqual(r2.status, 200);
  const j = await r2.json();
  assert.strictEqual(j.new, null);
  assert.strictEqual(j.truncated, true);
});

test('kit update in progress: kit change and add are 409; concurrent GET /api/kit shares one check', async (t) => {
  const svc = setup();
  let release;
  const gate = new Promise((r) => { release = r; });
  withOp(svc, async (o) => { if (o.argv[1] === 'update') await gate; return { rc: 0, log: `active ${'a'.repeat(40)} 1.0\nimage ${'a'.repeat(40)}\nnewest ${'a'.repeat(40)}\n` }; });
  const s = await h.authed(svc);
  t.after(s.stop);
  const upd = post(s, '/api/kit/update', {});
  while (!svc.calls.runOp.length) await new Promise((r) => setTimeout(r, 5));
  for (const [p, body] of [['/api/projects/demo/kit', { enabled: true }], ['/api/projects', { repo: 'o/r' }], ['/api/projects/demo/pull', {}]]) {
    const r = await post(s, p, body);
    assert.strictEqual(r.status, 409, p);
    assert.strictEqual((await r.json()).error, 'a kit update is in progress');
  }
  release();
  await upd;
  const before = svc.calls.runOp.length;
  let go;
  const hold = new Promise((r) => { go = r; });
  svc.next = async () => { await hold; return { rc: 0, log: `active ${'a'.repeat(40)} 1.0\nimage ${'a'.repeat(40)}\nnewest ${'a'.repeat(40)}\n` }; };
  const rp = Promise.all([get(s, '/api/kit'), get(s, '/api/kit')]);
  await new Promise((r) => setTimeout(r, 100));
  go();
  const rs = await rp;
  assert.deepStrictEqual(rs.map((r) => r.status), [200, 200]);
  assert.strictEqual(svc.calls.runOp.length - before, 1);
});

test('kit route: exit 8 carries code and a cleaned message, never a log', async (t) => {
  const svc = setup();
  withOp(svc, () => kitErr(4, 'bad\u0007 thing'));
  const s = await h.authed(svc);
  t.after(s.stop);
  const r = await post(s, '/api/projects/demo/kit', { enabled: true });
  assert.strictEqual(r.status, 409);
  assert.deepStrictEqual(await r.json(), { error: 'kit-failed', code: 4, message: 'bad  thing' });
});
