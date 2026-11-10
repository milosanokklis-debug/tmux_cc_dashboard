'use strict';
// Project folders in /workspace, their claude-<name> tmux sessions, and the
// add/open flows. Name rules mirror ccd-project and ccd-session.
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./http');
const { hasClaude } = require('./tmux');
const github = require('./github');
const { readRegular } = require('./safefile');

const PROJECT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const MAX_PROMPT = 4000;

const validProject = (n) => typeof n === 'string' && n.length <= 200 && PROJECT_RE.test(n) && !n.includes('..');

// Same mapping as name_for in ccd-session.
const sessionNameFor = (name) => `claude-${name.replace(/[^A-Za-z0-9_-]/g, '_')}`;

// "owner/repo" or https://github.com/owner/repo[.git][/] -> { owner, repo }.
function normalizeRepo(input) {
  if (typeof input !== 'string') throw new HttpError(400, 'repo must be a string');
  let s = input.trim();
  const url = /^https:\/\/github\.com\/(.*)$/.exec(s);
  if (url) s = url[1].replace(/\/$/, '');
  if (s.endsWith('.git')) s = s.slice(0, -4);
  const parts = s.split('/');
  const bad = () => new HttpError(400, 'repo must be owner/repo or a https://github.com/owner/repo URL');
  if (parts.length !== 2) throw bad();
  const [owner, repo] = parts;
  if (!OWNER_RE.test(owner) || owner.length > 39 || !validProject(repo)) throw bad();
  return { owner, repo };
}

function projectDirs(workspace) {
  let entries;
  try { entries = fs.readdirSync(workspace, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && validProject(e.name))
    .map((e) => e.name)
    .sort();
}

const isProjectDir = (workspace, name) => {
  try { return fs.lstatSync(path.join(workspace, name)).isDirectory(); } catch { return false; }
};

const DEFAULT_PROJECTS_DIR = '/home/ccd/.ccdash/projects';
const RECORD_MAX = 8192;
const SHA_RE = /^[0-9a-f]{7,64}$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/;

const KIT_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,40}$/;
const KIT_PACKS = ['kit-core', 'kit-design', 'kit-code'];
// {version, packs, memory} written by ccd-onboard, or null when absent or odd.
function readKit(k) {
  if (k === null || typeof k !== 'object' || Array.isArray(k)) return null;
  if (typeof k.version !== 'string' || !KIT_VERSION_RE.test(k.version)) return null;
  const packs = Array.isArray(k.packs) ? k.packs : []; // unknown values are dropped, not fatal
  const memory = k.memory === 'connected' || k.memory === 'missing' ? k.memory : 'unknown';
  return { version: k.version, packs: KIT_PACKS.filter((p) => packs.includes(p)), memory };
}

const CTRL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const cleanText = (x, max = 200) => String(x).replace(CTRL_RE, ' ').trim().slice(0, max);
// {status, message, ts} from the last kit re-check, or null.
function readKitCheck(c) {
  if (c === null || typeof c !== 'object' || Array.isArray(c)) return null;
  if (!['ok', 'changed', 'failed'].includes(c.status)) return null;
  const str = (x) => (typeof x === 'string' ? cleanText(x) : '');
  return { status: c.status, message: str(c.message), ts: str(c.ts) };
}
// {code, message} only (never log text), or null.
function readKitError(e) {
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return null;
  if (typeof e.code !== 'number' || !Number.isFinite(e.code) || typeof e.message !== 'string') return null;
  return { code: e.code, message: cleanText(e.message) };
}

// {repo, head, kit, kitEnabled, kitCheck, kitError} from <projectsDir>/<name>.json (written by ccd-onboard, in a directory ccd can write):
// regular file only, size capped, every field checked; anything odd gives null and never throws.
function readProjectRecord(projectsDir, name) {
  try {
    const f = readRegular(path.join(projectsDir || DEFAULT_PROJECTS_DIR, `${name}.json`), RECORD_MAX);
    if (!f || f.size > RECORD_MAX) return null;
    const v = JSON.parse(f.buf.toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    const repo = typeof v.repo === 'string' && REPO_RE.test(v.repo) && !v.repo.includes('..') ? v.repo : null;
    const head = typeof v.head === 'string' && SHA_RE.test(v.head) ? v.head : null;
    const kit = readKit(v.kit);
    const kitEnabled = typeof v.kitEnabled === 'boolean' ? v.kitEnabled : kit !== null;
    return repo || head ? { repo, head, kit, kitEnabled, kitCheck: readKitCheck(v.kitCheck), kitError: readKitError(v.kitError) } : null;
  } catch { return null; }
}

function stateOf(name, { workspace, panes, table }) {
  const session = sessionNameFor(name);
  const mine = panes.filter((p) => p.session === session
    && (p.projectDir === '' || p.projectDir === path.join(workspace, name)));
  if (!mine.length) return { session: null, state: 'none' };
  const claude = mine.some((p) => p.active && hasClaude(table, p.panePid));
  return { session, state: claude ? 'claude' : 'shell' };
}

// `panes` comes from tmux.listPanes (the caller turns a tmux failure into a 503).
function listProjects({ workspace, panes, procTable, projectsDir }) {
  const table = procTable();
  return projectDirs(workspace).map((name) => {
    const rec = readProjectRecord(projectsDir, name);
    return {
      name, ...stateOf(name, { workspace, panes, table }),
      repo: rec?.repo ?? null, head: rec?.head ? rec.head.slice(0, 7) : null, kit: rec?.kit ?? null,
      kitEnabled: rec?.kitEnabled ?? false, kitCheck: rec?.kitCheck ?? null, kitError: rec?.kitError ?? null,
    };
  });
}

// ccd-session exits 7 when the Basic Memory MCP server is not connected (the start gate). The body is
// { error: 'memory-offline', message: 'memory offline', output } with status 409.
const MEMORY_OFFLINE_RC = 7;
// ccd-session exits 9 when the project is logged out: 409 { error: 'login-required' }.
const LOGIN_REQUIRED_RC = 9;
const loginRequired = () => new HttpError(409, 'login-required', { error: 'login-required' });
const START_TIMEOUT_MS = 45 * 1000; // the gate runs `claude mcp list` (CCDASH_MCP_TIMEOUT, default 20 s) before anything starts
function memoryOffline(text) {
  const output = String(text || '').replace(/^memory offline\n?/, '').trim();
  return new HttpError(409, 'memory offline', { error: 'memory-offline', message: 'memory offline', output });
}

// ccd-session start <name> [prompt]: no-op when the session exists, never restarts claude.
async function startSession({ runFile, name, prompt }) {
  let out;
  try {
    ({ stdout: out } = await runFile('ccd-session', ['start', name, ...(prompt ? [prompt] : [])], { timeout: START_TIMEOUT_MS }));
  } catch (e) {
    if (e.code === MEMORY_OFFLINE_RC) throw memoryOffline(e.stderr || e.stdout);
    if (e.code === LOGIN_REQUIRED_RC) throw loginRequired();
    const msg = (e.stderr || e.message).trim().split('\n')[0] || 'could not start session';
    const status = /no such project/.test(msg) ? 404 : /already used/.test(msg) ? 409 : 500;
    throw new HttpError(status, msg);
  }
  const session = out.trim();
  if (!/^claude-[A-Za-z0-9_-]+$/.test(session)) throw new HttpError(500, 'unexpected session name');
  return session;
}

async function openProject({ workspace, runFile, name }) {
  checkProject({ workspace, name });
  return startSession({ runFile, name });
}

const inFlight = new Map(); // "owner/repo" -> { job, prompt, token }: the same repo twice at once, with the same settings, shares one clone
// ONE lock per project (keyed by the lowercased project name, i.e. the repo part) shared by add, pull and kit.
const busy = new Set();
const pulling = new Map(); // project name -> job: a second pull at the same time shares the first one's result
const KIT_UPDATING_MSG = 'a kit update is in progress';
const BUSY_MSG = 'another change to this project is in progress';

// deps: { runFile, runOp, fetchImpl?, saveToken? }
async function addProject(body, deps) {
  const { owner, repo } = normalizeRepo(body.repo);
  const prompt = body.prompt;
  if (prompt !== undefined && prompt !== null) {
    if (typeof prompt !== 'string') throw new HttpError(400, 'prompt must be a string');
    if (prompt.length > MAX_PROMPT) throw new HttpError(400, `prompt is longer than ${MAX_PROMPT} characters`);
    if (prompt.includes('\0')) throw new HttpError(400, 'prompt contains a NUL byte');
  }
  if (body.trustHooks !== undefined && typeof body.trustHooks !== 'boolean') throw new HttpError(400, 'trustHooks must be true or false');
  const trust = body.trustHooks === true;
  if (require('./kit').isUpdating()) throw new HttpError(409, KIT_UPDATING_MSG);
  if (body.kit !== undefined && typeof body.kit !== 'boolean') throw new HttpError(400, 'kit must be true or false');
  const kit = body.kit === true;
  const token = body.token === undefined || body.token === null || body.token === '' ? null : body.token;
  if (token !== null) github.validateToken(token);

  const clash = projectDirs(deps.workspace).find((d) => d !== repo && sessionNameFor(d) === sessionNameFor(repo));
  if (clash) throw new HttpError(409, `project ${clash} already uses the tmux session ${sessionNameFor(repo)}; rename one of them`);
  const key = `${owner}/${repo}`.toLowerCase();
  const settings = { prompt: prompt || '', token: token || '', trust, kit };
  const running = inFlight.get(key);
  if (running) {
    if (running.prompt !== settings.prompt || running.token !== settings.token || running.trust !== settings.trust
      || running.kit !== settings.kit) {
      throw new HttpError(409, 'a request for this repo is already in progress with different settings');
    }
    return running.job; // identical request: shares the first call's result
  }
  const lock = repo.toLowerCase();
  if (busy.has(lock)) throw new HttpError(409, BUSY_MSG);
  busy.add(lock);
  const job = (async () => {
    let warning;
    if (token !== null) {
      const { canPush } = await github.checkRepoAccess({ owner, repo, token, fetchImpl: deps.fetchImpl });
      if (!canPush) warning = 'token cannot push';
      (deps.saveToken || github.saveToken)({ owner, token });
    }
    const op = await deps.runOp({ argv: ['ccd-onboard', ...(trust ? ['--trust-hooks'] : []), ...(kit ? ['--kit'] : []), `${owner}/${repo}`] });
    checkOnboard(op, { timeout: 'clone timed out', refused: 'clone refused' });
    if (op.rc !== 0) throw new HttpError(502, 'clone failed', { log: op.log });
    const session = await startSession({ runFile: deps.runFile, name: repo, prompt });
    return { project: repo, session, ...(warning ? { warning } : {}) };
  })();
  inFlight.set(key, { job, ...settings });
  try { return await job; } finally { busy.delete(lock); if (inFlight.get(key)?.job === job) inFlight.delete(key); }
}

// ccd-onboard / ccd-project exit 5: the repo defines hooks and was not trusted. Only event names leave
// the container (`hooks: A,B`; also key names, `.mcp.json`, `(symlink)`), never the commands.
function refuseHooks(op) {
  if (op.rc !== 5) return;
  const m = /^hooks: ([A-Za-z0-9_?,.() ]+)$/m.exec(op.log || '');
  throw new HttpError(409, 'repo-has-hooks', { hooks: m ? m[1].split(',').filter(Boolean) : [] });
}

// ccd-onboard exit 8: the agent-kit step failed and the checkout was left as it was after the clone/pull.
// 409 { error: 'kit-failed', code, message, log } where log is the tail of the kit log.
function kitFailed(op, noLog = false) {
  if (op.rc !== 8) return;
  const text = String(op.log || '');
  const m = /^kit-error (\d+) (.*)$/m.exec(text);
  const log = m ? text.slice(m.index + m[0].length).trim() : text.trim();
  const code = m ? Number(m[1]) : 0;
  if (noLog) throw new HttpError(409, 'kit-failed', { error: 'kit-failed', code, message: cleanText(m ? m[2] : 'Kit failed') });
  throw new HttpError(409, 'kit-failed', { error: 'kit-failed', code, message: m ? m[2] : 'Kit failed', log });
}

const lastLine = (log) => String(log || '').trim().split('\n').pop().trim();
const lastHead = (log) => [...String(log || '').matchAll(/^head ([0-9a-f]{40,64})$/gm)].pop();

// The checks every ccd-onboard result gets: timeout (504), hooks (409), kit failure (409), exit 3 (409).
// Other non-zero codes and the success cases are left to the caller.
function checkOnboard(op, { timeout, refused, noLog = false }) {
  const extra = noLog ? undefined : { log: op.log };
  if (op.timedOut) throw new HttpError(504, timeout, extra);
  refuseHooks(op);
  kitFailed(op, noLog);
  if (op.rc === 3) throw new HttpError(409, lastLine(op.log) || refused, extra);
}

// POST /api/projects/:proj/pull: `ccd-onboard <repo>` for a project that has an onboarding record.
// Never starts, restarts or prompts a session. deps: { workspace, projectsDir?, runOp, panes, procTable }
async function pullProject({ name, deps }) {
  if (!validProject(name)) throw new HttpError(400, 'invalid project name');
  if (!isProjectDir(deps.workspace, name)) throw new HttpError(404, 'no such project');
  const lock = name.toLowerCase();
  if (require('./kit').isUpdating()) throw new HttpError(409, KIT_UPDATING_MSG);
  const sharing = pulling.get(name);
  if (sharing) return sharing; // a second identical pull shares the first one's result
  if (busy.has(lock)) throw new HttpError(409, BUSY_MSG);
  busy.add(lock);
  const job = (async () => {
    const rec = readProjectRecord(deps.projectsDir, name);
    if (!rec?.repo) throw new HttpError(409, 'no onboarding record; add the project again');
    if (rec.repo.split('/')[1].toLowerCase() !== name.toLowerCase()) {
      throw new HttpError(409, 'onboarding record does not match this project');
    }
    const claude = stateOf(name, { workspace: deps.workspace, panes: await deps.panes(), table: deps.procTable() }).state === 'claude';
    const op = await deps.runOp({ argv: ['ccd-onboard', rec.repo], timeoutMs: 5 * 60 * 1000 });
    checkOnboard(op, { timeout: 'pull timed out', refused: 'pull refused' });
    const full = lastHead(op.log);
    const unborn = op.rc === 0 && !full && /^nothing to pull yet/m.test(op.log || '');
    if (op.rc !== 0 || (!full && !unborn)) throw new HttpError(502, 'pull failed', { log: op.log });
    const head = full ? full[1].slice(0, 7) : null;
    const old = /^old ([0-9a-f]{7,64})$/m.exec(op.log)?.[1];
    const changed = /^pulled$/m.test(op.log);
    const ahead = /^ahead of origin/m.test(op.log);
    const message = !head ? `${rec.repo} has no commits yet`
      : changed ? `pulled ${rec.repo} to ${head}${claude ? '; Claude was not restarted' : ''}`
        : ahead ? `ahead of origin at ${head}; nothing to pull` : `already up to date at ${head}`;
    return { project: name, repo: rec.repo, head, before: old ? old.slice(0, 7) : null, changed, claude, message, log: op.log };
  })();
  pulling.set(name, job);
  try { return await job; } finally { busy.delete(lock); if (pulling.get(name) === job) pulling.delete(name); }
}

// POST /api/projects/:proj/kit { enabled: bool }: reruns ccd-onboard --kit / --no-kit. Does not start, restart or
// prompt a session. Returns the project summary like GET /api/projects plus `message`. The log is never returned.
async function setKit({ name, body, deps }) {
  if (!validProject(name)) throw new HttpError(400, 'invalid project name');
  if (typeof body?.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
  if (require('./kit').isUpdating()) throw new HttpError(409, KIT_UPDATING_MSG);
  if (!isProjectDir(deps.workspace, name)) throw new HttpError(404, 'no such project');
  const rec = readProjectRecord(deps.projectsDir, name);
  if (!rec?.repo) throw new HttpError(409, 'no onboarding record; add the project again');
  if (rec.repo.split('/')[1].toLowerCase() !== name.toLowerCase()) {
    throw new HttpError(409, 'onboarding record does not match this project');
  }
  const lock = name.toLowerCase();
  if (busy.has(lock)) throw new HttpError(409, BUSY_MSG);
  busy.add(lock);
  try {
    const argv = ['ccd-onboard', body.enabled ? '--kit' : '--no-kit', rec.repo];
    const op = await deps.runOp({ argv, timeoutMs: 10 * 60 * 1000 });
    checkOnboard(op, { timeout: 'kit timed out', refused: 'refused', noLog: true });
    if (op.rc !== 0) throw new HttpError(502, 'kit change failed');
    const full = lastHead(op.log);
    const after = readProjectRecord(deps.projectsDir, name);
    const st = stateOf(name, { workspace: deps.workspace, panes: await deps.panes(), table: deps.procTable() });
    const message = body.enabled ? (/^kit \S+ changed$/m.test(op.log || '') ? 'kit enabled and updated' : 'kit enabled') : 'kit disabled';
    return {
      name, ...st, repo: after?.repo ?? rec.repo, head: full ? full[1].slice(0, 7) : (after?.head ? after.head.slice(0, 7) : null),
      kit: after?.kit ?? null, kitEnabled: after?.kitEnabled ?? body.enabled, kitCheck: after?.kitCheck ?? null, kitError: after?.kitError ?? null, message,
    };
  } finally { busy.delete(lock); }
}

const WINDOW_RE = /^@\d+$/;
const WINDOW_KINDS = ['claude', 'shell'];
const validWindowId = (id) => typeof id === 'string' && id.length <= 12 && WINDOW_RE.test(id);

// Runs ccd-session <cmd> <project> [arg]; exit 9 -> 409 login-required, 2 -> 400, 1 -> 404 for close only.
async function sessionCmd(runFile, args, timeout = 30 * 1000) {
  try {
    return (await runFile('ccd-session', args, { timeout })).stdout;
  } catch (e) {
    if (e.code === LOGIN_REQUIRED_RC) throw loginRequired();
    if (e.code === 1 && args[0] === 'close') throw new HttpError(404, 'no such window');
    if (e.code === 2) throw new HttpError(400, 'bad request');
    throw new HttpError(500, 'session command failed');
  }
}

function checkProject({ workspace, name }) {
  if (!validProject(name)) throw new HttpError(400, 'invalid project name');
  if (!isProjectDir(workspace, name)) throw new HttpError(404, 'no such project');
}

async function loggedIn({ runFile, name }) {
  const out = await sessionCmd(runFile, ['auth', name]);
  const v = out.trim();
  return v === 'logged-in' ? true : v === 'unknown' ? null : false;
}

const SIGN_IN_HOSTS = ['claude.com', 'claude.ai', 'anthropic.com'];
// The sign-in URL in the login pane: https on a known host (or subdomain); the oauth one wins over other links.
function signInUrl(pane) {
  const urls = [];
  for (const m of String(pane).matchAll(/https:\/\/[^\s"'<>]+/g)) {
    try {
      const u = new URL(m[0]);
      if (SIGN_IN_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) urls.push(m[0]);
    } catch { /* not a URL */ }
  }
  return urls.find((u) => /oauth/.test(new URL(u).pathname)) ?? urls[0] ?? null;
}

// GET login: { loggedIn, url }. The URL is read live from the login pane and never stored or logged.
async function loginState({ workspace, runFile, tmux, name }) {
  checkProject({ workspace, name });
  const ok = await loggedIn({ runFile, name });
  let url = null;
  if (ok !== true) {
    try {
      const pane = await tmux.run(['capture-pane', '-p', '-J', '-t', `=${sessionNameFor(name)}:=login`]);
      url = signInUrl(pane);
    } catch { /* no login window yet */ }
  }
  return { loggedIn: ok, url };
}

async function startLogin({ workspace, runFile, name }) {
  checkProject({ workspace, name });
  await sessionCmd(runFile, ['login', name], START_TIMEOUT_MS);
  return { ok: true };
}

async function listWindows({ workspace, runFile, name }) {
  checkProject({ workspace, name });
  const out = await sessionCmd(runFile, ['windows', name]);
  const windows = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    let w;
    try { w = JSON.parse(line); } catch { continue; }
    if (!w || typeof w !== 'object' || !validWindowId(w.id)) continue;
    windows.push({ id: w.id, index: Number(w.index) || 0, name: typeof w.name === 'string' ? cleanText(w.name) : '', active: w.active === true || w.active === 1, kind: ['claude', 'shell', 'login'].includes(w.kind) ? w.kind : 'shell', pid: Number(w.pid) || null });
  }
  return windows;
}

async function newWindow({ workspace, runFile, name, kind }) {
  if (!WINDOW_KINDS.includes(kind)) throw new HttpError(400, 'kind must be claude or shell');
  checkProject({ workspace, name });
  const id = (await sessionCmd(runFile, ['new', name, kind], START_TIMEOUT_MS)).trim();
  if (!validWindowId(id)) throw new HttpError(500, 'unexpected window id');
  return { id };
}

async function closeWindow({ workspace, runFile, name, id }) {
  if (!validWindowId(id)) throw new HttpError(400, 'invalid window id');
  checkProject({ workspace, name });
  await sessionCmd(runFile, ['close', name, id], 60 * 1000);
  return { ok: true };
}

// select-window in the viewer's grouped web-* session(s), or in the project's own session when nobody views it.
// The window must belong to the project: its owning session (display-message -t <id>) is the project's session
// or one grouped with it, else 404 (window ids are global across projects).
async function selectWindow({ workspace, tmux, name, id }) {
  if (!validWindowId(id)) throw new HttpError(400, 'invalid window id');
  checkProject({ workspace, name });
  const session = sessionNameFor(name);
  let rows = [];
  try { rows = String(await tmux.run(['list-sessions', '-F', '#{session_name}\t#{session_group}\t#{session_attached}'])).split('\n').map((l) => l.split('\t')); } catch { /* session list unavailable */ }
  const group = rows.find((r) => r[0] === session)?.[1] || '';
  let owner;
  try { owner = String(await tmux.run(['display-message', '-p', '-t', id, '#{session_name}\t#{session_group}'])).trim().split('\t'); } catch { throw new HttpError(404, 'no such window'); }
  if (!owner[0] || owner[0] !== session) throw new HttpError(404, 'no such window');
  const viewers = group ? rows.filter((r) => r[0].startsWith('web-') && r[1] === group && Number(r[2]) > 0).map((r) => r[0]) : [];
  try {
    for (const t of viewers.length ? viewers : [session]) await tmux.run(['select-window', '-t', `${t}:${id}`]);
  } catch { throw new HttpError(404, 'no such window'); }
  return { ok: true };
}

module.exports = {
  validWindowId, loginState, startLogin, listWindows, newWindow, closeWindow, selectWindow,
  cleanText, setKit, pullProject, readProjectRecord, memoryOffline, MEMORY_OFFLINE_RC, DEFAULT_PROJECTS_DIR, validProject, sessionNameFor, normalizeRepo, listProjects, startSession, openProject, addProject,
};
