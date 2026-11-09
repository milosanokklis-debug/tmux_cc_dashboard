'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../lib/app');
const authstore = require('../lib/authstore');

const FAST = { memoryCost: 1024, timeCost: 2, parallelism: 1 };
const ORIGIN = 'https://ccdash.example.com';
const USER = 'alice';
const PASS = 'correct horse battery';

function fakeClock(start = 1_700_000_000_000) {
  return { t: start, now() { return this.t; }, advance(ms) { this.t += ms; } };
}

async function start({ withAuth = true, clock = fakeClock(), delays = [], authJson, services, broker = { sock: null }, audit } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-test-'));
  if (authJson !== undefined) fs.writeFileSync(path.join(dir, 'auth.json'), authJson);
  else if (withAuth) await authstore.setCredentials({ dir, username: USER, password: PASS, hashOptions: FAST });
  const app = createApp({
    webDir: dir,
    origins: new Set([ORIGIN, 'http://localhost:7690']),
    clock,
    delay: async (ms) => { delays.push(ms); },
    log: () => {},
    services,
    broker,
    hashOptions: FAST,
    audit: audit || (() => {}),
  });
  const server = app.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stop = () => new Promise((r) => { server.closeAllConnections(); server.close(r); fs.rmSync(dir, { recursive: true, force: true }); });
  return { app, server, base, dir, clock, delays, stop };
}

function req(base, p, { method = 'GET', headers = {}, body, json, cookie } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  let b = body;
  if (json !== undefined) { b = JSON.stringify(json); h['content-type'] = 'application/json'; }
  return fetch(base + p, { method, headers: h, body: b, redirect: 'manual' });
}

const POST_HEADERS = { origin: ORIGIN, 'x-ccdash': '1' };

async function login(base, extra = {}, creds = { username: USER, password: PASS }) {
  return req(base, '/login', { method: 'POST', headers: { ...POST_HEADERS, ...extra }, json: creds });
}

async function loginCookie(base) {
  const res = await login(base);
  return res.headers.get('set-cookie').split(';')[0];
}

// Fake services for the API tests: no tmux, no /proc, no processes are touched.
function fakeServices(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdash-svc-'));
  const workspace = path.join(dir, 'workspace');
  const agentsDir = path.join(dir, 'agents');
  fs.mkdirSync(workspace); fs.mkdirSync(agentsDir);
  const calls = { runFile: [], runOp: [] };
  const svc = {
    workspace, agentsDir, projectsDir: path.join(dir, 'projects'), transcriptRoot: dir, calls, dir,
    tmux: { sock: '/tmp/fake.sock', listPanes: async () => [], run: async () => '', ensureOps: async () => {} },
    procTable: () => new Map(),
    reconciler: { tick: async () => null, snapshot: () => null, get: () => null },
    runFile: async (file, args) => {
      calls.runFile.push([file, ...args]);
      return { stdout: `claude-${args[1].replace(/[^A-Za-z0-9_-]/g, '_')}\n`, stderr: '' };
    },
    runOp: async (o) => { calls.runOp.push(o.argv); return { rc: 0, log: '' }; },
    fetchImpl: async () => { throw new Error('unexpected fetch'); },
    saveToken: () => { throw new Error('unexpected saveToken'); },
    now: () => Date.parse('2026-01-10T12:00:00Z'),
    ...over,
  };
  return svc;
}

async function authed(services, opts = {}) {
  const s = await start({ services, ...opts });
  const cookie = await loginCookie(s.base);
  return { ...s, cookie };
}

module.exports = {
  FAST, ORIGIN, USER, PASS, fakeClock, start, req, login, loginCookie, POST_HEADERS, fakeServices, authed,
};
