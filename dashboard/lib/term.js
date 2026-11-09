'use strict';
// WebSocket terminal: each connection gets its own pty running a tmux client attached to a
// grouped web-<hex> session of claude-<project>. destroy-unattached removes the web-*
// session when the client goes away; claude-<project> itself keeps running.
const crypto = require('node:crypto');
const { STATUS_CODES } = require('node:http');
const { rejectUpgrade } = require('./security');
const { validProject, startSession } = require('./projects');
const { validAccount, DEFAULT_ACCOUNT } = require('./accounts');

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_DIM = 500;
const MAX_TERMS = 16;
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
const PING_MS = 30000;
const CLEANUP_MS = 1000;

// A usable dimension is a number or a non-empty numeric string; anything else is "missing".
const isNum = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v));

function clampDim(v, fallback) {
  if (!isNum(v)) return fallback;
  return Math.min(MAX_DIM, Math.max(1, Math.floor(Number(v))));
}

// {"resize":[cols,rows]} (and nothing else) is a control message; anything else is input.
function parseControl(text) {
  if (text[0] !== '{') return null;
  let o;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== 'object' || Object.keys(o).length !== 1 || !Array.isArray(o.resize)) return null;
  const [c, r] = o.resize;
  if (o.resize.length !== 2 || !isNum(c) || !isNum(r)) return null;
  return { cols: clampDim(c, DEFAULT_COLS), rows: clampDim(r, DEFAULT_ROWS) };
}

function tmuxArgs(sock, sessionName, webName) {
  return ['-S', sock, 'new-session', '-t', `=${sessionName}`, '-s', webName, ';', 'set-option', 'destroy-unattached', 'on'];
}

function realPty() {
  return require('node-pty'); // native; built in the image, optional on dev machines
}

// deps: { wss, registry, tmuxSock, runFile, spawnPty?, pingMs?, cleanupMs? }
function createTerm(deps) {
  const { wss, registry, tmuxSock, runFile, pingMs = PING_MS, cleanupMs = CLEANUP_MS } = deps;
  let active = 0; // live terminals plus upgrades still waiting for startSession

  // Best effort: a pty killed before destroy-unattached applied could leave web-* behind.
  function removeWebSession(webName) {
    setTimeout(() => {
      runFile('tmux', ['-S', tmuxSock, 'kill-session', '-t', `=${webName}`]).catch(() => {});
    }, cleanupMs).unref();
  }

  // The caller has counted this terminal in `active`; every path below releases it once.
  function attach(ws, key, sessionName, cols, rows, freeSlot) {
    const webName = `web-${crypto.randomBytes(4).toString('hex')}`;
    let p;
    try {
      p = (deps.spawnPty || ((f, a, o) => realPty().spawn(f, a, o)))('tmux', tmuxArgs(tmuxSock, sessionName, webName), {
        name: 'xterm-256color', cols, rows, cwd: '/',
        env: { PATH: process.env.PATH, LANG: process.env.LANG || 'C.UTF-8', TERM: 'xterm-256color', CCDASH_TMUX: tmuxSock },
      });
    } catch (e) {
      console.error('pty spawn failed:', e.message);
      freeSlot();
      ws.close(1011, 'terminal unavailable');
      return;
    }
    let dead = false;
    let pending = 0;
    let paused = false;
    let alive = true;
    const release = () => {
      if (dead) return false;
      dead = true;
      freeSlot();
      clearInterval(pinger);
      removeWebSession(webName);
      return true;
    };
    // a client that stops answering pings (half-open connection) is dropped
    const pinger = setInterval(() => {
      if (!alive) { ws.terminate(); return; }
      alive = false;
      try { ws.ping(); } catch { /* closing */ }
    }, pingMs);
    pinger.unref();
    ws.on('pong', () => { alive = true; });
    const kill = () => {
      if (!release()) return;
      try { p.kill(); } catch { /* already gone */ }
    };
    try {
      p.onData((data) => {
        if (ws.readyState !== 1) return;
        const n = Buffer.byteLength(data);
        pending += n;
        ws.send(data, () => {
          pending -= n;
          if (paused && pending < LOW_WATER) { paused = false; try { p.resume?.(); } catch { /* gone */ } }
        });
        if (!paused && pending > HIGH_WATER) { paused = true; try { p.pause?.(); } catch { /* gone */ } }
      });
      p.onExit(() => {
        release();
        if (ws.readyState === 1) ws.close(1000, 'terminal exited');
      });
      ws.on('message', (data, isBinary) => {
        if (dead) return;
        try {
          if (isBinary) { p.write(Buffer.isBuffer(data) ? data : Buffer.concat(data)); return; }
          const text = data.toString();
          const ctl = parseControl(text);
          if (ctl) p.resize(ctl.cols, ctl.rows); else p.write(text);
        } catch { /* pty already gone: onExit closes the socket */ }
      });
      ws.on('close', kill);
      ws.on('error', kill);
    } catch (e) { kill(); throw e; } // never leave a pty or a slot behind
  }

  // Called after guardUpgrade accepted the request. Validates, makes sure the claude
  // session exists, then completes the WebSocket handshake.
  async function handleUpgrade(req, socket, head, { key, proj, query }) {
    const reject = (status) => rejectUpgrade(socket, status, STATUS_CODES[status]);
    if (!validProject(proj)) return reject(400);
    const account = query.get('account') ?? DEFAULT_ACCOUNT;
    if (!validAccount(account)) return reject(400);
    if (proj === '_login' && account === DEFAULT_ACCOUNT) return reject(400); // the login window is for a named account
    if (active >= MAX_TERMS) return reject(503);
    const cols = clampDim(query.get('cols'), DEFAULT_COLS);
    const rows = clampDim(query.get('rows'), DEFAULT_ROWS);
    active++;
    // Registered before the await: logout, expiry or a password change during startSession
    // destroys the socket, and the check below then never hands it a terminal.
    registry.add(key, socket);
    let attached = false;
    let freed = false;
    const freeSlot = () => { if (!freed) { freed = true; active--; } }; // exactly once, whoever gets there first
    try {
      const sessionName = await startSession({ runFile, name: proj, account });
      if (socket.destroyed) return undefined;
      wss.handleUpgrade(req, socket, head, (ws) => {
        attached = true; // the socket is a WebSocket now: from here on errors close it, never write an HTTP reject
        try { attach(ws, key, sessionName, cols, rows, freeSlot); } catch (e) {
          console.error('terminal attach failed:', e.message);
          freeSlot();
          try { ws.terminate(); } catch { /* gone */ }
        }
      });
      return undefined;
    } catch (e) {
      if (attached) { freeSlot(); return undefined; }
      return reject(STATUS_CODES[e.status] && e.status >= 400 ? e.status : 500);
    } finally {
      if (!attached) freeSlot();
    }
  }

  return { handleUpgrade, get active() { return active; } };
}

module.exports = { createTerm, parseControl, clampDim, tmuxArgs };
