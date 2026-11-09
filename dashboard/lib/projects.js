'use strict';
// Project folders in /workspace, their claude-<name> tmux sessions, and the
// add/open flows. Name rules mirror ccd-project and ccd-session.
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./http');
const { parseAccount } = require('./accounts');
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
  if (!OWNER_RE.test(owner) || owner.length > 39 || !validProject(repo) || repo === '_login') throw bad(); // _login is the terminal name of the account login window
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
  if (!Array.isArray(k.packs) || !k.packs.every((p) => KIT_PACKS.includes(p))) return null;
  const memory = k.memory === 'connected' || k.memory === 'missing' ? k.memory : 'unknown';
  return { version: k.version, packs: KIT_PACKS.filter((p) => k.packs.includes(p)), memory };
}

const CTRL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const cleanText = (x, max = 200) => String(x).replace(CTRL_RE, ' ').trim().slice(0, max);
// {status, message, account, ts} from the last kit re-check, or null.
function readKitCheck(c) {
  if (c === null || typeof c !== 'object' || Array.isArray(c)) return null;
  if (!['ok', 'changed', 'failed'].includes(c.status)) return null;
  const str = (x) => (typeof x === 'string' ? cleanText(x) : '');
  return { status: c.status, message: str(c.message), account: str(c.account), ts: str(c.ts) };
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
const START_TIMEOUT_MS = 45 * 1000; // the gate runs `claude mcp list` (CCDASH_MCP_TIMEOUT, default 20 s) before anything starts
function memoryOffline(text) {
  const output = String(text || '').replace(/^memory offline\n?/, '').trim();
  return new HttpError(409, 'memory offline', { error: 'memory-offline', message: 'memory offline', output });
}

// ccd-session start <name> [prompt]: no-op when the session exists, never restarts claude.
async function startSession({ runFile, name, prompt, account }) {
  let out;
  try {
    ({ stdout: out } = await runFile('ccd-session', ['start', name, '--account', account, ...(prompt ? [prompt] : [])], { timeout: START_TIMEOUT_MS }));
  } catch (e) {
    if (e.code === MEMORY_OFFLINE_RC) throw memoryOffline(e.stderr || e.stdout);
    const msg = (e.stderr || e.message).trim().split('\n')[0] || 'could not start session';
    const status = /no such project|unknown account/.test(msg) ? 404 : /already used/.test(msg) ? 409 : 500;
    throw new HttpError(status, msg);
  }
  const session = out.trim();
  if (!/^claude-[A-Za-z0-9_-]+$/.test(session)) throw new HttpError(500, 'unexpected session name');
  return session;
}

async function openProject({ workspace, runFile, name, account }) {
  if (!validProject(name)) throw new HttpError(400, 'invalid project name');
  if (!isProjectDir(workspace, name)) throw new HttpError(404, 'no such project');
  return startSession({ runFile, name, account: parseAccount(account) });
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
  const account = parseAccount(body.account);
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

  const key = `${owner}/${repo}`.toLowerCase();
  const settings = { account, prompt: prompt || '', token: token || '', trust, kit };
  const running = inFlight.get(key);
  if (running) {
    if (running.account !== settings.account || running.prompt !== settings.prompt || running.token !== settings.token || running.trust !== settings.trust
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
    const session = await startSession({ runFile: deps.runFile, name: repo, prompt, account });
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

module.exports = {
  cleanText, setKit, pullProject, readProjectRecord, memoryOffline, MEMORY_OFFLINE_RC, DEFAULT_PROJECTS_DIR, validProject, sessionNameFor, normalizeRepo, listProjects, startSession, openProject, addProject,
};
