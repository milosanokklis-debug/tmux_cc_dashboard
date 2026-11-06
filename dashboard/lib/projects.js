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
const RECORD_MAX = 4096;
const SHA_RE = /^[0-9a-f]{7,64}$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/;

// {repo, head} from <projectsDir>/<name>.json (written by ccd-onboard, in a directory ccd can write):
// regular file only, size capped, every field checked; anything odd gives null and never throws.
function readProjectRecord(projectsDir, name) {
  try {
    const f = readRegular(path.join(projectsDir || DEFAULT_PROJECTS_DIR, `${name}.json`), RECORD_MAX);
    if (!f || f.size > RECORD_MAX) return null;
    const v = JSON.parse(f.buf.toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    const repo = typeof v.repo === 'string' && REPO_RE.test(v.repo) && !v.repo.includes('..') ? v.repo : null;
    const head = typeof v.head === 'string' && SHA_RE.test(v.head) ? v.head : null;
    return repo || head ? { repo, head } : null;
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
      repo: rec?.repo ?? null, head: rec?.head ? rec.head.slice(0, 7) : null,
    };
  });
}

// ccd-session start <name> [prompt]: no-op when the session exists, never restarts claude.
async function startSession({ runFile, name, prompt }) {
  let out;
  try {
    ({ stdout: out } = await runFile('ccd-session', ['start', name, ...(prompt ? [prompt] : [])]));
  } catch (e) {
    const msg = (e.stderr || e.message).trim().split('\n')[0] || 'could not start session';
    const status = /no such project/.test(msg) ? 404 : /already used/.test(msg) ? 409 : 500;
    throw new HttpError(status, msg);
  }
  const session = out.trim();
  if (!/^claude-[A-Za-z0-9_-]+$/.test(session)) throw new HttpError(500, 'unexpected session name');
  return session;
}

async function openProject({ workspace, runFile, name }) {
  if (!validProject(name)) throw new HttpError(400, 'invalid project name');
  if (!isProjectDir(workspace, name)) throw new HttpError(404, 'no such project');
  return startSession({ runFile, name });
}

const inFlight = new Map(); // "owner/repo" -> { job, prompt, token }: the same repo twice at once, with the same settings, shares one clone

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
  const token = body.token === undefined || body.token === null || body.token === '' ? null : body.token;
  if (token !== null) github.validateToken(token);

  const key = `${owner}/${repo}`.toLowerCase();
  const settings = { prompt: prompt || '', token: token || '', trust };
  const running = inFlight.get(key);
  if (running) {
    if (running.prompt !== settings.prompt || running.token !== settings.token || running.trust !== settings.trust) {
      throw new HttpError(409, 'a request for this repo is already in progress with different settings');
    }
    return running.job; // identical request: shares the first call's result
  }
  const job = (async () => {
    let warning;
    if (token !== null) {
      const { canPush } = await github.checkRepoAccess({ owner, repo, token, fetchImpl: deps.fetchImpl });
      if (!canPush) warning = 'token cannot push';
      (deps.saveToken || github.saveToken)({ owner, token });
    }
    const op = await deps.runOp({ argv: ['ccd-onboard', ...(trust ? ['--trust-hooks'] : []), `${owner}/${repo}`] });
    if (op.timedOut) throw new HttpError(504, 'clone timed out', { log: op.log });
    refuseHooks(op);
    if (op.rc === 3) throw new HttpError(409, lastLine(op.log) || 'clone refused', { log: op.log });
    if (op.rc !== 0) throw new HttpError(502, 'clone failed', { log: op.log });
    const session = await startSession({ runFile: deps.runFile, name: repo, prompt });
    return { project: repo, session, ...(warning ? { warning } : {}) };
  })();
  inFlight.set(key, { job, ...settings });
  try { return await job; } finally { if (inFlight.get(key)?.job === job) inFlight.delete(key); }
}

// ccd-onboard / ccd-project exit 5: the repo defines hooks and was not trusted. Only event names leave
// the container (`hooks: A,B`), never the commands.
function refuseHooks(op) {
  if (op.rc !== 5) return;
  const m = /^hooks: ([A-Za-z0-9_?,]+)$/m.exec(op.log || '');
  throw new HttpError(409, 'repo-has-hooks', { hooks: m ? m[1].split(',').filter(Boolean) : [] });
}

const lastLine = (log) => String(log || '').trim().split('\n').pop().trim();
const pulling = new Map(); // project name -> job: a second pull at the same time shares the first one's result

// POST /api/projects/:proj/pull: `ccd-onboard <repo>` for a project that has an onboarding record.
// Never starts, restarts or prompts a session. deps: { workspace, projectsDir?, runOp, panes, procTable }
async function pullProject({ name, deps }) {
  if (!validProject(name)) throw new HttpError(400, 'invalid project name');
  if (!isProjectDir(deps.workspace, name)) throw new HttpError(404, 'no such project');
  const running = pulling.get(name);
  if (running) return running;
  const job = (async () => {
    const rec = readProjectRecord(deps.projectsDir, name);
    if (!rec?.repo) throw new HttpError(409, 'no onboarding record; add the project again');
    if (rec.repo.split('/')[1].toLowerCase() !== name.toLowerCase()) {
      throw new HttpError(409, 'onboarding record does not match this project');
    }
    const claude = stateOf(name, { workspace: deps.workspace, panes: await deps.panes(), table: deps.procTable() }).state === 'claude';
    const op = await deps.runOp({ argv: ['ccd-onboard', rec.repo], timeoutMs: 5 * 60 * 1000 });
    if (op.timedOut) throw new HttpError(504, 'pull timed out', { log: op.log });
    refuseHooks(op);
    if (op.rc === 3) throw new HttpError(409, lastLine(op.log) || 'pull refused', { log: op.log });
    const full = /^head ([0-9a-f]{40,64})$/m.exec(op.log || '');
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
  try { return await job; } finally { if (pulling.get(name) === job) pulling.delete(name); }
}

module.exports = {
  pullProject, readProjectRecord, DEFAULT_PROJECTS_DIR, validProject, sessionNameFor, normalizeRepo, listProjects, startSession, openProject, addProject,
};
