'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');

const get = (s, p) => h.req(s.base, p, { cookie: s.cookie });

test('GET /api/selftest: no file means no warnings; mismatches become warnings; junk is ignored', async (t) => {
  const svc = h.fakeServices();
  svc.selftestFile = path.join(svc.workspace, 'selftest.json');
  const s = await h.authed(svc);
  t.after(s.stop);
  assert.deepStrictEqual((await (await get(s, '/api/selftest')).json()).warnings, []);
  fs.writeFileSync(svc.selftestFile, JSON.stringify({ ts: 'x', mismatches: [{ check: 'hook_payloads', status: 'warn', detail: 'extra:foo', secret: 1 }, 7] }));
  const w = (await (await get(s, '/api/selftest')).json()).warnings;
  assert.deepStrictEqual(w[0], { check: 'hook_payloads', detail: 'extra:foo' });
  fs.writeFileSync(svc.selftestFile, '{not json');
  assert.deepStrictEqual((await (await get(s, '/api/selftest')).json()).warnings, []);
  assert.strictEqual((await h.req(s.base, '/api/selftest', { method: 'POST', headers: { origin: h.ORIGIN, 'x-ccdash': '1' }, json: {}, cookie: s.cookie })).status, 405);
});
