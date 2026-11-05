'use strict';
// Authenticated JSON API (/api/*). The caller has already checked the session, Origin
// and X-CCDash, so this only routes and validates.
const { HttpError, send, readJson } = require('./http');
const { createTmux, readProcTable, runFile, runOp } = require('./tmux');
const projects = require('./projects');
const { buildTree } = require('./tree');
const { createReconciler } = require('./state');

const MAX_ADD_BODY = 64 * 1024; // prompt <= 4000 chars, up to 6 bytes each when \u-escaped

function defaultServices() {
  const tmux = createTmux();
  return {
    workspace: '/workspace',
    agentsDir: '/home/ccd/.ccdash/agents',
    transcriptRoot: '/home/ccd/.claude',
    tmux,
    procTable: readProcTable,
    runFile,
    runOp: (opts) => runOp({ tmux, ...opts }),
    reconciler: createReconciler({ tmux }),
    fetchImpl: fetch,
    now: () => Date.now(),
  };
}

function createApi(svc) {
  let tmuxDown = false; // logged once per outage
  const waking = new Set(); // sids with a wake running

  // Pane list, or 503: a denied or unreachable tmux must not look like "everything is gone".
  async function panes() {
    try {
      const list = await svc.tmux.listPanes();
      tmuxDown = false;
      return list;
    } catch (e) {
      if (!tmuxDown) console.error('tmux unavailable:', e.message);
      tmuxDown = true;
      throw new HttpError(503, 'tmux unavailable');
    }
  }
  const methodNotAllowed = () => { throw new HttpError(405, 'method not allowed'); };

  return async function handleApi(req, res, pathname, searchParams) {
    const get = req.method === 'GET';
    if (pathname === '/api/projects') {
      if (get) {
        const list = projects.listProjects({ ...svc, panes: await panes() });
        return send(res, 200, { projects: list.map((p) => ({ name: p.name, session: p.session, state: p.state })) });
      }
      if (req.method !== 'POST') return methodNotAllowed();
      const body = await readJson(req, MAX_ADD_BODY);
      return send(res, 200, await projects.addProject(body, svc));
    }
    const open = /^\/api\/projects\/([^/]+)\/open$/.exec(pathname);
    if (open) {
      if (req.method !== 'POST') return methodNotAllowed();
      let name;
      try { name = decodeURIComponent(open[1]); } catch { throw new HttpError(400, 'invalid project name'); }
      const session = await projects.openProject({ workspace: svc.workspace, runFile: svc.runFile, name });
      return send(res, 200, { session });
    }
    if (pathname === '/api/tree') {
      if (!get) return methodNotAllowed();
      const now = svc.now();
      const projectsTree = buildTree({
        agentsDir: svc.agentsDir, transcriptRoot: svc.transcriptRoot, panes: await panes(), table: svc.procTable(),
        now, all: searchParams.get('all') === '1', states: svc.reconciler?.snapshot() ?? null,
      });
      return send(res, 200, { now: Math.floor(now / 1000), projects: projectsTree }); // unix seconds
    }
    const wake = /^\/api\/conversations\/([^/]+)\/wake$/.exec(pathname);
    if (wake) {
      if (req.method !== 'POST') return methodNotAllowed();
      return send(res, 200, await wakeConversation(wake[1]));
    }
    throw new HttpError(404, 'not found');
  };

  // Wake = `ccd-session wake <sid>` as ccd. Only a sleeping or ended conversation that has not been
  // woken already; a live one would otherwise get a second Claude on the same history.
  async function wakeConversation(sid) {
    if (!/^[0-9a-f-]{36}$/.test(sid)) throw new HttpError(400, 'invalid conversation id');
    const rec = svc.reconciler ? (await svc.reconciler.tick(), svc.reconciler.get(sid)) : null;
    if (!rec) throw new HttpError(404, 'no such conversation');
    if (rec.hidden) throw new HttpError(409, 'this conversation was already woken');
    if (rec.status !== 'sleeping' && rec.status !== 'ended') throw new HttpError(409, `conversation is ${rec.status}, not sleeping`);
    if (waking.has(sid)) throw new HttpError(409, 'wake already in progress');
    waking.add(sid);
    try {
      const op = await svc.runOp({ argv: ['ccd-session', 'wake', sid], timeoutMs: 60 * 1000 });
      if (op.timedOut) throw new HttpError(504, 'wake timed out', { log: op.log });
      if (op.rc !== 0) throw new HttpError(502, 'wake failed', { log: op.log });
      await svc.reconciler.tick();
      return { ok: true, session: op.log.trim().split('\n').pop() };
    } finally { waking.delete(sid); }
  }
}

module.exports = { createApi, defaultServices };
