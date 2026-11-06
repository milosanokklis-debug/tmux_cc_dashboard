'use strict';
// Phase C controls end to end: real tmux, ccd-session, hooks/state.sh, tests/fake-claude and the
// real reconciler, driven through the real HTTP stack (login, Origin, X-CCDash).
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const { haveTmux, sleep, stack } = require('./stack');
const { start, req, loginCookie, POST_HEADERS, fakeServices, authed } = require('./helpers');
const { createTmux } = require('../lib/tmux');

const skip = !haveTmux && 'needs tmux and jq';

test('tmux.runInput writes stdin, and refuses a denied tmux', async () => {
  const fake = (code, out = '', err = '') => () => {
    const c = new EventEmitter();
    c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.stdin = new PassThrough();
    c.written = '';
    c.stdin.on('data', (d) => { c.written += d; });
    setImmediate(() => { c.stdout.end(out); c.stderr.end(err); setImmediate(() => c.emit('close', code)); });
    fake.last = c;
    return c;
  };
  const ok = createTmux({ sock: '/x', spawnFn: fake(0, 'fine') });
  assert.strictEqual(await ok.runInput(['load-buffer', '-'], 'secret text'), 'fine');
  assert.strictEqual(fake.last.written, 'secret text');
  await assert.rejects(createTmux({ sock: '/x', spawnFn: fake(0, '', 'access not allowed') }).runInput(['x'], 'a'), /access not allowed/);
  await assert.rejects(createTmux({ sock: '/x', spawnFn: fake(1, '', 'no buffer') }).runInput(['x'], 'a'), /no buffer/);
});

test('the control routes need a session, Origin and X-CCDash', async (t) => {
  const s = await authed(fakeServices());
  t.after(() => s.stop());
  const sid = '00000000-0000-4000-8000-000000000001';
  const routes = [['POST', 'prompt'], ['POST', 'interrupt'], ['POST', 'close'], ['GET', 'preview']];
  for (const [method, name] of routes) {
    const p = `/api/conversations/${sid}/${name}`;
    const anon = await req(s.base, p, { method, headers: POST_HEADERS, json: method === 'POST' ? { text: 'x' } : undefined });
    assert.strictEqual(anon.status, 401, `${name} without a session`);
    if (method === 'POST') {
      const noHeader = await req(s.base, p, { method, headers: { origin: POST_HEADERS.origin }, cookie: s.cookie, json: { text: 'x' } });
      assert.strictEqual(noHeader.status, 403, `${name} without X-CCDash`);
      const badOrigin = await req(s.base, p, { method, headers: { origin: 'https://evil.example', 'x-ccdash': '1' }, cookie: s.cookie, json: { text: 'x' } });
      assert.strictEqual(badOrigin.status, 403, `${name} with a foreign Origin`);
    }
  }
  const bad = await req(s.base, '/api/conversations/not-a-uuid/interrupt', { method: 'POST', headers: POST_HEADERS, cookie: s.cookie });
  assert.strictEqual(bad.status, 400);
  const unknown = await req(s.base, `/api/conversations/${sid}/interrupt`, { method: 'POST', headers: POST_HEADERS, cookie: s.cookie });
  assert.strictEqual(unknown.status, 404);
});

test('Phase C: prompt, interrupt, close and preview against the fake claude', { skip }, async (t) => {
  const s = stack();
  t.after(() => s.cleanup());
  const calls = [];
  const tmux = { ...s.tmux, run: async (a) => { calls.push(a); return s.tmux.run(a); } };
  const server = await start({
    services: {
      workspace: s.ws, agentsDir: path.join(s.tmp, 'agents'), transcriptRoot: path.join(s.tmp, 'tr'), tmux, reconciler: s.rec,
      procTable: () => new Map(), runFile: async () => ({ stdout: '', stderr: '' }), runOp: async () => ({ rc: 0, log: '' }),
      now: () => Date.now(), closeWaitSec: 2,
    },
  });
  t.after(() => server.stop());
  const cookie = await loginCookie(server.base);
  const call = async (sid, name, json) => {
    const res = await req(server.base, `/api/conversations/${sid}/${name}`, {
      method: name === 'preview' ? 'GET' : 'POST', headers: POST_HEADERS, cookie, json,
    });
    const raw = await res.text();
    return { status: res.status, raw, body: JSON.parse(raw) };
  };
  const promptsDir = path.join(s.env.FAKE_CLAUDE_HOME, 'prompts');
  const delivered = (sid, n) => path.join(promptsDir, `${sid}.${n}`);
  const readPrompt = async (sid, n) => {
    await s.until(() => fs.existsSync(delivered(sid, n)), `prompt ${n}`);
    await sleep(100);
    return fs.readFileSync(delivered(sid, n), 'utf8');
  };
  // the n-th turn of a conversation is over: its "done" line is on the screen and the status is waiting
  const turnDone = async (name, n) => {
    const pane = s.cur(name).pane;
    await s.until(() => (s.t('capture-pane', '-p', '-S', '-', '-t', pane).match(/^done$/gm) ?? []).length >= n, `turn ${n} of ${name}`);
    return waiting(name);
  };
  const events = () => { try { return fs.readFileSync(path.join(s.env.FAKE_CLAUDE_HOME, 'events.log'), 'utf8'); } catch { return ''; } };
  async function begin(name) {
    s.project(name);
    s.ccd('start', name);
    return (await s.status(name, 'waiting')).sid;
  }
  const waiting = (name) => s.status(name, 'waiting');
  const marker = path.join(s.tmp, 'executed');

  await t.test('a hostile prompt arrives byte for byte and nothing is executed', async () => {
    const sid = await begin('c1');
    const text = `it's "q" $(touch ${marker}) \`touch ${marker}\`; echo a && b \\ \\n é 日本 😀\n\n  indented line\nthe word Enter here\n`;
    const r = await call(sid, 'prompt', { text });
    assert.strictEqual(r.status, 200, r.raw);
    assert.strictEqual(await readPrompt(sid, 1), text);
    await turnDone('c1', 1);
    assert.ok(!fs.existsSync(marker));
    // CRLF is normalised to LF
    assert.strictEqual((await call(sid, 'prompt', { text: 'one\r\ntwo' })).status, 200);
    assert.strictEqual(await readPrompt(sid, 2), 'one\ntwo');
    await turnDone('c1', 2);
    // slash commands take the same path
    assert.strictEqual((await call(sid, 'prompt', { text: '/status' })).status, 200);
    assert.strictEqual(await readPrompt(sid, 3), '/status');
    await turnDone('c1', 3);
    assert.match(s.t('capture-pane', '-p', '-t', s.cur('c1').pane), /Opus 5\.5 · ctx 8%/); // the fake ran its /status cue: managed settings run statusline.sh
  });

  await t.test('size and character limits', async () => {
    const sid = (await waiting('c1')).sid;
    const big = 'é'.repeat(4001); // 8002 bytes
    const tooLong = await call(sid, 'prompt', { text: big });
    assert.strictEqual(tooLong.status, 413);
    assert.match(tooLong.body.error, /^Prompt is too long: 8002 bytes, the limit is 8000\. Shorten or split it\.$/);
    assert.ok(!tooLong.raw.includes('éé'));
    assert.strictEqual((await call(sid, 'prompt', { text: 'a'.repeat(8001) })).status, 413);
    const n0 = fs.readdirSync(promptsDir).filter((f) => f.startsWith(sid)).length;
    const exact = 'b'.repeat(8000);
    assert.strictEqual((await call(sid, 'prompt', { text: exact })).status, 200);
    assert.strictEqual(await readPrompt(sid, n0 + 1), exact);
    await turnDone('c1', n0 + 1);
    for (const text of ['a\u001bb', 'a\u0000b', 'a\u0085b', 'a\rb', '   ', '', 5]) {
      const r = await call(sid, 'prompt', { text });
      assert.strictEqual(r.status, 400, JSON.stringify(text));
    }
    assert.strictEqual((await call(sid, 'prompt', {})).status, 400);
    assert.strictEqual(fs.readdirSync(promptsDir).filter((f) => f.startsWith(sid)).length, n0 + 1);
  });

  await t.test('interrupt stops a /long turn; prompts are refused while working, sleeping or ended', async () => {
    const sid = await begin('c2');
    assert.strictEqual((await call(sid, 'interrupt')).status, 409); // waiting
    s.send('c2', '/long');
    await s.status('c2', 'working');
    const secret = 'do-not-echo-this-text';
    const refused = await call(sid, 'prompt', { text: secret });
    assert.strictEqual(refused.status, 409);
    assert.match(refused.body.error, /working, not waiting/);
    assert.ok(!refused.raw.includes(secret));
    assert.strictEqual((await call(sid, 'interrupt')).status, 200);
    await waiting('c2');
    assert.match(events(), /^interrupted$/m);
    assert.strictEqual((await call(sid, 'prompt', { text: 'after the interrupt' })).status, 200);
    assert.strictEqual(await readPrompt(sid, 2), 'after the interrupt');
    await turnDone('c2', 2);

    const sleepy = await begin('c3');
    process.kill(s.claudePid('c3'), 'SIGKILL');
    await s.status('c3', 'sleeping', 10000);
    for (const name of ['prompt', 'interrupt', 'close']) assert.strictEqual((await call(sleepy, name, { text: 'x' })).status, 409, name);
    assert.strictEqual((await call(sleepy, 'preview')).status, 409);
  });

  await t.test('close ends a conversation, kills a stuck one after CCDASH_CLOSE_WAIT, and previews work', async () => {
    const sid = await begin('c4');
    s.send('c4', 'hello preview-marker');
    await s.until(() => fs.existsSync(delivered(sid, 1)), 'the prompt');
    await turnDone('c4', 1);
    const p1 = await call(sid, 'preview');
    assert.strictEqual(p1.status, 200);
    assert.match(p1.body.text, /preview-marker/);
    assert.match(p1.body.text, /done/);
    assert.ok(p1.body.text.split('\n').length <= 20 && Buffer.byteLength(p1.body.text) <= 8192);
    assert.ok(calls.some((a) => a[0] === 'capture-pane' && a.includes('-p') && a.includes('-e')));
    const n = calls.filter((a) => a[0] === 'capture-pane').length;
    await call(sid, 'preview');
    assert.strictEqual(calls.filter((a) => a[0] === 'capture-pane').length, n, 'cached for about a second');
    const closed = await call(sid, 'close');
    assert.deepStrictEqual(closed.body, { ok: true, result: 'ended' });
    assert.strictEqual(s.rec.get(sid).status, 'ended');
    assert.strictEqual((await call(sid, 'preview')).status, 409);
    assert.strictEqual((await call(sid, 'prompt', { text: 'x' })).status, 409);
    assert.strictEqual((await call(sid, 'close')).status, 409);

    // Needs approval: Escape cancels the dialog first, so the pasted /exit can never answer it with Yes.
    const asking = await begin('c6');
    s.send('c6', '/perm');
    await s.status('c6', 'needs_approval');
    const exited = await call(asking, 'close');
    assert.ok(['ended', 'killed'].includes(exited.body.result), JSON.stringify(exited.body));
    assert.ok(!/permission: allow/.test(events()), 'the dialog was never approved');
    assert.match(events(), /permission deny \(user\)/);

    const stuck = await begin('c5');
    const pane = s.cur('c5').pane;
    s.send('c5', '/long');
    await s.status('c5', 'working');
    const killed = await call(stuck, 'close'); // the pasted /exit is ignored by the /long turn
    assert.deepStrictEqual(killed.body, { ok: true, result: 'killed' });
    assert.ok(!s.t('list-panes', '-a', '-F', '#{pane_id}').split('\n').includes(pane));
  });
});
