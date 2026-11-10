'use strict';
// Authenticated JSON API (/api/*). The caller has already checked the session, Origin
// and X-CCDash, so this only routes and validates.
const { HttpError, send, readJson } = require('./http');
const { createTmux, readProcTable, runFile, runOp } = require('./tmux');
const projects = require('./projects');
const kit = require('./kit');
const identity = require('./identity');
const { createReader, ReaderError } = require('./reader');
const { createTokens, readTranscript, transcriptFiles } = require('./tokens');
const usage = require('./usage');
const { createUsageFallback } = require('./usage-fallback');
const { createReconciler } = require('./state');
const { createControls } = require('./controls');
const { MAX_MESSAGE } = require('./broker');
const github = require('./github');
const { PushError, defaultPrefs } = require('./push');
const { readRegular } = require('./safefile');

const MAX_ADD_BODY = 64 * 1024; // prompt <= 4000 chars, up to 6 bytes each when \u-escaped

function defaultServices() {
  const tmux = createTmux();
  const reader = createReader();
  return {
    reader,
    tokens: createTokens({ reader }),
    usageDir: usage.DEFAULT_DIR,
    usageFallback: createUsageFallback({ tmux }),
    selftestFile: '/home/ccd/.ccdash/selftest.json',
    workspace: '/workspace',
    projectsDir: projects.DEFAULT_PROJECTS_DIR,
    tmux,
    procTable: readProcTable,
    runFile,
    runOp: (opts) => runOp({ tmux, ...opts }),
    reconciler: createReconciler({ tmux }),
    fetchImpl: fetch,
    now: () => Date.now(),
  };
}

const shortSid = (sid) => (/^[0-9a-f-]{36}$/.test(sid) ? sid.slice(0, 8) : undefined);

function createApi(svc) {
  let tmuxDown = false; // logged once per outage
  const controls = createControls(svc, { closeWaitSec: svc.closeWaitSec });
  const waking = new Set(); // sids with a wake running

  // Transcripts to read: each conversation's main transcript, from the state snapshot.
  const trackedFiles = () => transcriptFiles(svc.reconciler.snapshot());
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

  // The same payloads /api/usage and /api/tokens answer with; the /events hub reuses them.
  function usagePayload() {
    const fb = svc.usageFallback;
    const g = usage.gauges({ dir: svc.usageDir, now: Math.floor(svc.now() / 1000), fallback: fb ? fb.latest : null });
    if (g.five_hour.status === 'unknown' && g.seven_day.status === 'unknown') fb?.refresh(); // off unless switched on
    return { ...g, fallback_enabled: !!fb?.enabled() };
  }
  // `ccd doctor --live` result (written by the host's ccd into ccd's home); only the warnings are sent.
  function selftestPayload() {
    const r = svc.selftestFile ? readRegular(svc.selftestFile, 256 * 1024) : null;
    let j = null;
    try { j = r && JSON.parse(r.buf.toString('utf8')); } catch { j = null; }
    const warn = Array.isArray(j?.mismatches) ? j.mismatches : [];
    const str = (v) => (typeof v === 'string' ? v.slice(0, 300) : '');
    return { warnings: warn.slice(0, 50).map((m) => ({ check: str(m?.check), detail: str(m?.detail) })) };
  }
  async function tokensPayload(conversation = null) {
    await svc.tokens.refresh(trackedFiles());
    return svc.tokens.views({ conversation });
  }

  // Runs fn and audits it (ids and outcomes only: never prompt text, tool input or tokens).
  const audit = (event, ctx, fields, outcome, reason) => {
    try { svc.audit?.(event, { ip: ctx.ip, ...fields, outcome, ...(reason ? { reason } : {}) }); } catch { /* auditing never breaks a request */ }
  };
  async function audited(event, ctx, fields, fn) {
    try {
      const r = await fn();
      audit(event, ctx, fields, 'ok');
      return r;
    } catch (e) {
      audit(event, ctx, fields, 'fail', e.status ? String(e.status) : 'error');
      throw e;
    }
  }

  async function handleApi(req, res, pathname, searchParams, ctx = {}) {
    const get = req.method === 'GET';
    if (pathname.startsWith('/api/push/')) return pushRoute(req, res, pathname, ctx.sessionKey);
    if (pathname === '/api/projects') {
      if (get) {
        const list = projects.listProjects({ ...svc, panes: await panes() });
        return send(res, 200, {
          projects: list.map((p) => ({ name: p.name, session: p.session, state: p.state, repo: p.repo, head: p.head, kit: p.kit, kitEnabled: p.kitEnabled, kitCheck: p.kitCheck, kitError: p.kitError })),
        });
      }
      if (req.method !== 'POST') return methodNotAllowed();
      const body = await readJson(req, MAX_ADD_BODY);
      let project;
      try { project = projects.normalizeRepo(body.repo).repo; } catch { /* addProject reports it */ }
      const deps = { ...svc, saveToken: (a) => { (svc.saveToken || github.saveToken)(a); audit('token.saved', ctx, { project: a.owner }, 'ok'); } };
      return send(res, 200, await audited('onboard', ctx, { project }, () => projects.addProject(body, deps)));
    }
    const open = /^\/api\/projects\/([^/]+)\/open$/.exec(pathname);
    if (open) {
      if (req.method !== 'POST') return methodNotAllowed();
      let name;
      try { name = decodeURIComponent(open[1]); } catch { throw new HttpError(400, 'invalid project name'); }
      const session = await audited('open', ctx, { project: name }, () => projects.openProject({ workspace: svc.workspace, runFile: svc.runFile, name }));
      return send(res, 200, { session });
    }
    const proj = /^\/api\/projects\/([^/]+)\/(login|windows|close|select)(?:\/([^/]+)\/(close|select))?$/.exec(pathname);
    if (proj) return projectRoute(req, res, proj, ctx);
    const pull = /^\/api\/projects\/([^/]+)\/pull$/.exec(pathname);
    if (pull) {
      if (req.method !== 'POST') return methodNotAllowed();
      let name;
      try { name = decodeURIComponent(pull[1]); } catch { throw new HttpError(400, 'invalid project name'); }
      return send(res, 200, await audited('pull', ctx, { project: name }, () => projects.pullProject({ name, deps: { ...svc, panes } })));
    }
    const kitRoute = /^\/api\/projects\/([^/]+)\/kit$/.exec(pathname);
    if (kitRoute) {
      if (req.method !== 'POST') return methodNotAllowed();
      let name;
      try { name = decodeURIComponent(kitRoute[1]); } catch { throw new HttpError(400, 'invalid project name'); }
      const body = await readJson(req, MAX_ADD_BODY);
      return send(res, 200, await audited(body?.enabled === true ? 'kit.enable' : body?.enabled === false ? 'kit.disable' : 'kit.change', ctx, { project: name }, () => projects.setKit({ name, body, deps: { ...svc, panes } })));
    }
    if (pathname === '/api/kit') {
      if (!get) return methodNotAllowed();
      return send(res, 200, await kit.check(svc));
    }
    if (pathname === '/api/kit/update') {
      if (req.method !== 'POST') return methodNotAllowed();
      const body = await readJson(req, 1024, true);
      const fields = {};
      const r = await audited('kit.update', ctx, fields, async () => {
        const out = await kit.update(body, svc);
        fields.old = out.old; fields.new = out.new;
        return out;
      });
      return send(res, 200, r);
    }
    if (pathname === '/api/git-identity') {
      if (get) return send(res, 200, await identity.getIdentity(svc));
      if (req.method !== 'POST') return methodNotAllowed();
      return send(res, 200, await audited('identity.change', ctx, {}, async () => identity.setIdentity(await readJson(req, 4 * 1024), svc)));
    }
    if (pathname === '/api/usage') {
      if (!get) return methodNotAllowed();
      return send(res, 200, usagePayload());
    }
    if (pathname === '/api/selftest') {
      if (!get) return methodNotAllowed();
      return send(res, 200, selftestPayload());
    }
    if (pathname === '/api/tokens') {
      if (!get) return methodNotAllowed();
      const conversation = searchParams.get('conversation');
      if (conversation !== null && !/^[A-Za-z0-9_-]{1,100}$/.test(conversation)) throw new HttpError(400, 'invalid conversation id');
      return send(res, 200, await tokensPayload(conversation));
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
      const ev = behavior === 'allow' ? 'approve' : 'deny';
      if (!svc.broker?.decide(decision[1], { behavior, message })) {
        audit(ev, ctx, { request: decision[1] }, 'fail', '404');
        throw new HttpError(404, 'no such pending request');
      }
      audit(ev, ctx, { request: decision[1] }, 'ok');
      return send(res, 200, { ok: true });
    }
    const wake = /^\/api\/conversations\/([^/]+)\/wake$/.exec(pathname);
    if (wake) {
      if (req.method !== 'POST') return methodNotAllowed();
      return send(res, 200, await audited('wake', ctx, { sid: shortSid(wake[1]) }, () => wakeConversation(wake[1])));
    }
    const ctl = /^\/api\/conversations\/([^/]+)\/(prompt|interrupt|close|preview)$/.exec(pathname);
    if (ctl) {
      if (req.method !== (ctl[2] === 'preview' ? 'GET' : 'POST')) return methodNotAllowed();
      if (ctl[2] !== 'preview') { // prompt text is never audited, only the id
        return send(res, 200, await audited(ctl[2], ctx, { sid: shortSid(ctl[1]) }, () => controls[ctl[2]](ctl[1], req)));
      }
      return send(res, 200, await controls[ctl[2]](ctl[1], req));
    }
    throw new HttpError(404, 'not found');
  }
  handleApi.usagePayload = usagePayload;
  handleApi.tokensPayload = tokensPayload;
  handleApi.preview = (sid) => controls.preview(sid, { fresh: false });
  return handleApi;

  // /api/projects/:p/login (GET state, POST open the login window) and /windows (GET list, POST new,
  // POST :id/close, POST :id/select). Audited by project name (and window id) only, never the sign-in URL.
  async function projectRoute(req, res, m, ctx) {
    const dec = (v) => { try { return decodeURIComponent(v); } catch { throw new HttpError(400, 'invalid request'); } };
    const name = dec(m[1]);
    const base = { workspace: svc.workspace, runFile: svc.runFile, tmux: svc.tmux, name };
    const get = req.method === 'GET';
    if (m[2] === 'login') {
      if (get) return send(res, 200, await projects.loginState(base));
      if (req.method !== 'POST') return methodNotAllowed();
      return send(res, 200, await audited('login.open', ctx, { project: name }, () => projects.startLogin(base)));
    }
    if (m[2] === 'close' || m[2] === 'select') throw new HttpError(400, 'invalid window id'); // a window id was normalized away (.. or empty)
    if (m[3] === undefined) {
      if (get) return send(res, 200, { windows: await projects.listWindows(base) });
      if (req.method !== 'POST') return methodNotAllowed();
      const body = await readJson(req, 1024, true);
      const kind = body?.kind;
      return send(res, 200, await audited('window.new', ctx, { project: name }, () => projects.newWindow({ ...base, kind })));
    }
    if (req.method !== 'POST') return methodNotAllowed();
    const id = dec(m[3]);
    const fn = m[4] === 'close' ? projects.closeWindow : projects.selectWindow;
    return send(res, 200, await audited(`window.${m[4]}`, ctx, { project: name, window: projects.validWindowId(id) ? id : undefined }, () => fn({ ...base, id })));
  }

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
      if (op.rc === projects.MEMORY_OFFLINE_RC) throw projects.memoryOffline(op.log);
      if (op.rc !== 0) throw new HttpError(502, 'wake failed', { log: op.log });
      await svc.reconciler.tick();
      return { ok: true, session: op.log.trim().split('\n').pop() };
    } finally { waking.delete(sid); }
  }
}

module.exports = { createApi, defaultServices };
