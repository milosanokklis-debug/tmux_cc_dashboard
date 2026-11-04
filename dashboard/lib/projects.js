'use strict';
// Project folders in /workspace, their claude-<name> tmux sessions, and the
// add/open flows. Name rules mirror ccd-project and ccd-session.
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./http');
const { hasClaude } = require('./tmux');
const github = require('./github');

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

// `panes` comes from tmux.listPanes (the caller turns a tmux failure into a 503).
function listProjects({ workspace, panes, procTable }) {
  const table = procTable();
  return projectDirs(workspace).map((name) => {
    const session = sessionNameFor(name);
    const mine = panes.filter((p) => p.session === session
      && (p.projectDir === '' || p.projectDir === path.join(workspace, name)));
    if (!mine.length) return { name, session: null, state: 'none' };
    const claude = mine.some((p) => p.active && hasClaude(table, p.panePid));
    return { name, session, state: claude ? 'claude' : 'shell' };
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
  const token = body.token === undefined || body.token === null || body.token === '' ? null : body.token;
  if (token !== null) github.validateToken(token);

  const key = `${owner}/${repo}`.toLowerCase();
  const settings = { prompt: prompt || '', token: token || '' };
  const running = inFlight.get(key);
  if (running) {
    if (running.prompt !== settings.prompt || running.token !== settings.token) {
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
    const op = await deps.runOp({ argv: ['ccd-project', 'clone', `${owner}/${repo}`] });
    if (op.timedOut) throw new HttpError(504, 'clone timed out', { log: op.log });
    if (op.rc !== 0) throw new HttpError(502, 'clone failed', { log: op.log });
    const session = await startSession({ runFile: deps.runFile, name: repo, prompt });
    return { project: repo, session, ...(warning ? { warning } : {}) };
  })();
  inFlight.set(key, { job, ...settings });
  try { return await job; } finally { if (inFlight.get(key)?.job === job) inFlight.delete(key); }
}

module.exports = {
  validProject, sessionNameFor, normalizeRepo, listProjects, startSession, openProject, addProject,
};
