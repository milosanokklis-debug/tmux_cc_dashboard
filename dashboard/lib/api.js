'use strict';
// Authenticated JSON API (/api/*). The caller has already checked the session, Origin
// and X-CCDash, so this only routes and validates.
const { HttpError, send, readJson } = require('./http');
const { createTmux, readProcTable, runFile, runOp } = require('./tmux');
const projects = require('./projects');
const { buildTree } = require('./tree');

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
    fetchImpl: fetch,
    now: () => Date.now(),
  };
}

function createApi(svc) {
  let tmuxDown = false; // logged once per outage

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
        now, all: searchParams.get('all') === '1',
      });
      return send(res, 200, { now: Math.floor(now / 1000), projects: projectsTree }); // unix seconds
    }
    throw new HttpError(404, 'not found');
  };
}

module.exports = { createApi, defaultServices };
