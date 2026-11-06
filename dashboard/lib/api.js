'use strict';
// Authenticated JSON API (/api/*). The caller has already checked the session, Origin
// and X-CCDash, so this only routes and validates.
const { HttpError, send, readJson } = require('./http');
const { createTmux, readProcTable, runFile, runOp } = require('./tmux');
const projects = require('./projects');
const identity = require('./identity');
const { buildTree, listConversations } = require('./tree');
const { createReader, ReaderError } = require('./reader');
const { createTokens, readTranscript, transcriptFiles } = require('./tokens');
const usage = require('./usage');
const { createUsageFallback } = require('./usage-fallback');
const { createReconciler } = require('./state');
const { createControls } = require('./controls');
const { MAX_MESSAGE } = require('./broker');
const { PushError, defaultPrefs } = require('./push');

const MAX_ADD_BODY = 64 * 1024; // prompt <= 4000 chars, up to 6 bytes each when \u-escaped

function defaultServices() {
  const tmux = createTmux();
  const reader = createReader();
  return {
    reader,
    tokens: createTokens({ reader }),
    usageDir: process.env.CCDASH_USAGE_DIR || usage.DEFAULT_DIR,
    usageFallback: createUsageFallback({ tmux }),
    workspace: '/workspace',
    agentsDir: '/home/ccd/.ccdash/agents',
    projectsDir: projects.DEFAULT_PROJECTS_DIR,
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
  const controls = createControls(svc, { closeWaitSec: svc.closeWaitSec });
  const waking = new Set(); // sids with a wake running

  // Transcripts to read: each conversation's own and its subagents', from the agent events
  // (subagents) and the state snapshot (the conversation's transcript path).
  const trackedFiles = () => transcriptFiles(listConversations(svc.agentsDir), svc.reconciler.snapshot());
  // Reader failures become plain HTTP errors; the reader's own messages never carry a path.
  const readerError = (e) => {
    if (!(e instanceof ReaderError)) throw e;
    if (e.code === 'not_found') throw new HttpError(404, 'transcript not found');
    throw new HttpError(503, 'transcript reader unavailable');
  };

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

  return async function handleApi(req, res, pathname, searchParams, ctx = {}) {
    const get = req.method === 'GET';
    if (pathname.startsWith('/api/push/')) return pushRoute(req, res, pathname, ctx.sessionKey);
    if (pathname === '/api/projects') {
      if (get) {
        const list = projects.listProjects({ ...svc, panes: await panes() });
        return send(res, 200, {
          projects: list.map((p) => ({ name: p.name, session: p.session, state: p.state, repo: p.repo, head: p.head })),
        });
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
    const pull = /^\/api\/projects\/([^/]+)\/pull$/.exec(pathname);
    if (pull) {
      if (req.method !== 'POST') return methodNotAllowed();
      let name;
      try { name = decodeURIComponent(pull[1]); } catch { throw new HttpError(400, 'invalid project name'); }
      return send(res, 200, await projects.pullProject({ name, deps: { ...svc, panes } }));
    }
    if (pathname === '/api/git-identity') {
      if (get) return send(res, 200, await identity.getIdentity(svc));
      if (req.method !== 'POST') return methodNotAllowed();
      return send(res, 200, await identity.setIdentity(await readJson(req, 4 * 1024), svc));
    }
    if (pathname === '/api/tree') {
      if (!get) return methodNotAllowed();
      const now = svc.now();
      const projectsTree = buildTree({
        agentsDir: svc.agentsDir, transcriptRoot: svc.transcriptRoot, panes: await panes(), table: svc.procTable(),
        now, all: searchParams.get('all') === '1', states: svc.reconciler.snapshot(), tokens: svc.tokens ?? null,
      });
      svc.tokens?.refresh(trackedFiles()).catch(() => {}); // totals in the next tree; never delays this answer
      for (const p of projectsTree) { // an approval card only while the conversation really is in needs_approval
        for (const c of p.conversations) {
          const a = c.status === 'needs_approval' ? svc.broker?.forSid(c.sid) : null;
          if (a) c.approval = { id: a.id, tool: a.tool_name, input: a.tool_input, truncated: a.truncated, since: a.since };
        }
      }
      return send(res, 200, { now: Math.floor(now / 1000), projects: projectsTree }); // unix seconds
    }
    if (pathname === '/api/usage') {
      if (!get) return methodNotAllowed();
      const fb = svc.usageFallback;
      const g = usage.gauges({ dir: svc.usageDir, now: Math.floor(svc.now() / 1000), fallback: fb ? fb.latest : null });
      if (g.five_hour.status === 'unknown' && g.seven_day.status === 'unknown') fb?.refresh(); // off unless switched on
      return send(res, 200, { ...g, fallback_enabled: !!fb?.enabled() });
    }
    if (pathname === '/api/tokens') {
      if (!get) return methodNotAllowed();
      const conversation = searchParams.get('conversation');
      if (conversation !== null && !/^[A-Za-z0-9_-]{1,100}$/.test(conversation)) throw new HttpError(400, 'invalid conversation id');
      await svc.tokens.refresh(trackedFiles());
      return send(res, 200, svc.tokens.views({ conversation }));
    }
    if (pathname === '/api/transcript') {
      if (!get) return methodNotAllowed();
      const conv = searchParams.get('conv');
      const agent = searchParams.get('agent') || 'main';
      const off = searchParams.get('offset');
      if (!conv || !/^[A-Za-z0-9_-]{1,100}$/.test(conv)) throw new HttpError(400, 'invalid conversation id');
      if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(agent)) throw new HttpError(400, 'invalid agent id');
      if (off !== null && !/^[0-9]{1,15}$/.test(off)) throw new HttpError(400, 'invalid offset');
      // the file comes from our own records, never from the request
      const file = trackedFiles().find((f) => f.conv === conv && f.agent === agent);
      if (!file) throw new HttpError(404, 'no such transcript');
      try {
        const view = await readTranscript(svc.reader, file.path, { offset: off === null ? null : Number(off) });
        return send(res, 200, { conv, agent, agent_type: file.agent_type, ...view });
      } catch (e) { return readerError(e); }
    }
    const decision = /^\/api\/approvals\/([^/]+)\/decision$/.exec(pathname);
    if (decision) {
      if (req.method !== 'POST') return methodNotAllowed();
      if (!/^[0-9a-f]{16}$/.test(decision[1])) throw new HttpError(400, 'invalid approval id');
      const { behavior, message } = await readJson(req);
      if (behavior !== 'allow' && behavior !== 'deny') throw new HttpError(400, 'behavior must be allow or deny');
      if (message !== undefined && (typeof message !== 'string' || message.length > MAX_MESSAGE)) {
        throw new HttpError(400, `message must be text of at most ${MAX_MESSAGE} characters`);
      }
      if (!svc.broker?.decide(decision[1], { behavior, message })) throw new HttpError(404, 'no such pending request');
      return send(res, 200, { ok: true });
    }
    const wake = /^\/api\/conversations\/([^/]+)\/wake$/.exec(pathname);
    if (wake) {
      if (req.method !== 'POST') return methodNotAllowed();
      return send(res, 200, await wakeConversation(wake[1]));
    }
    const ctl = /^\/api\/conversations\/([^/]+)\/(prompt|interrupt|close|preview)$/.exec(pathname);
    if (ctl) {
      if (req.method !== (ctl[2] === 'preview' ? 'GET' : 'POST')) return methodNotAllowed();
      return send(res, 200, await controls[ctl[2]](ctl[1], req));
    }
    throw new HttpError(404, 'not found');
  };

  // Push routes: a subscription belongs to the session (cookie) that created it.
  async function pushRoute(req, res, pathname, sk) {
    const push = svc.push;
    const route = pathname.slice('/api/push/'.length);
    if (!push || !sk || !['config', 'subscribe', 'prefs', 'unsubscribe'].includes(route)) throw new HttpError(404, 'not found');
    if (req.method !== (route === 'config' ? 'GET' : 'POST')) return methodNotAllowed();
    try {
      if (route === 'config') {
        const mine = push.get(sk);
        return send(res, 200, { publicKey: push.publicKey(), subscribed: !!mine, prefs: mine ? mine.prefs : defaultPrefs() });
      }
      if (route === 'unsubscribe') { push.removeSession(sk); return send(res, 200, { ok: true }); }
      const body = await readJson(req, 8 * 1024);
      if (route === 'subscribe') return send(res, 200, { ok: true, prefs: push.subscribe(sk, body.subscription, body.prefs) });
      const prefs = push.setPrefs(sk, body);
      if (!prefs) throw new HttpError(409, 'not subscribed');
      return send(res, 200, { ok: true, prefs });
    } catch (e) {
      if (e instanceof PushError) throw new HttpError(400, e.message);
      throw e;
    }
  }

  // Wake = `ccd-session wake <sid>` as ccd. Only a sleeping or ended conversation that has not been
  // woken already; a live one would otherwise get a second Claude on the same history.
  async function wakeConversation(sid) {
    if (!/^[0-9a-f-]{36}$/.test(sid)) throw new HttpError(400, 'invalid conversation id');
    await svc.reconciler.tick();
    const rec = svc.reconciler.get(sid);
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
