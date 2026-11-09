'use strict';
// Claude accounts, dashboard side. The name rule lives here once (it mirrors account_valid in
// rootfs/usr/local/lib/ccdash/accounts.sh); the account store itself belongs to user ccd, so the
// dashboard never reads it: it asks ccd-account (list, create) and ccd-session (unknown account).
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./http');

const DEFAULT_ACCOUNT = 'default';
const accountsDir = () => process.env.CCDASH_ACCOUNTS_DIR || '/home/ccd/.claude-accounts';
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const LIST_TIMEOUT_MS = 90 * 1000; // `claude auth status` runs once per account, each up to 30 s
const CREATE_TIMEOUT_MS = 150 * 1000;

const validAccount = (n) => n === DEFAULT_ACCOUNT || (typeof n === 'string' && NAME_RE.test(n));

// undefined / null / '' -> 'default'; anything that is not a valid name -> 400.
function parseAccount(v) {
  if (v === undefined || v === null || v === '') return DEFAULT_ACCOUNT;
  if (!validAccount(v)) throw new HttpError(400, 'invalid account name');
  return v;
}

// Account of a transcript path, from where it lives: under <accounts>/<name>/ is that account, anything
// else (the default config dir) is `default`. Pure string work; the reader does the real path checks.
function accountOfPath(p) {
  const base = accountsDir();
  if (typeof p !== 'string' || path.normalize(p) !== p || !p.startsWith(`${base}/`)) return DEFAULT_ACCOUNT;
  const name = p.slice(base.length + 1).split('/')[0];
  return NAME_RE.test(name) ? name : DEFAULT_ACCOUNT;
}

// Transcript roots for tree.js: the default projects dir plus <accounts>/<name>/projects for each real
// (non-symlink) account dir, like the reader's allowed roots.
const isRealDir = (d) => { try { return fs.lstatSync(d).isDirectory(); } catch { return false; } };
function transcriptRoots() {
  const base = accountsDir();
  const out = ['/home/ccd/.claude/projects'];
  try {
    for (const n of fs.readdirSync(base)) {
      const d = path.join(base, n);
      if (NAME_RE.test(n) && isRealDir(d) && isRealDir(path.join(d, 'projects'))) out.push(path.join(d, 'projects'));
    }
  } catch { /* not readable from here: only the default root */ }
  return out;
}

// [{ name, loggedIn }], default first. Output of `ccd-account list`: "name<TAB>logged in|not logged in".
// Concurrent callers share one in-flight run; nothing is cached once it settles.
let inflight = null;

function listAccounts(runFile) {
  if (!inflight) {
    const p = listAccountsNow(runFile);
    const clear = () => { if (inflight === p) inflight = null; };
    p.then(clear, clear);
    inflight = p;
  }
  return inflight;
}

async function listAccountsNow(runFile) {
  let out;
  try {
    ({ stdout: out } = await runFile('ccd-account', ['list'], { timeout: LIST_TIMEOUT_MS }));
  } catch { throw new HttpError(502, 'could not list accounts'); }
  const list = [];
  for (const line of String(out).split('\n')) {
    const [name, state] = line.split('\t');
    if (validAccount(name) && /^(not )?logged in$/.test(state || '')) list.push({ name, loggedIn: state === 'logged in' });
  }
  return list;
}

// Creates the account (idempotent) and returns what the UI needs to log in: open the terminal on
// `project` with `account`; that window runs claude with the account's config dir, and the user runs /login.
async function createAccount(runFile, body) {
  const name = body && typeof body === 'object' ? body.name : undefined;
  if (typeof name !== 'string' || !validAccount(name)) throw new HttpError(400, 'invalid account name');
  if (name === DEFAULT_ACCOUNT) throw new HttpError(400, 'default is reserved');
  try {
    await runFile('ccd-account', ['create', name], { timeout: CREATE_TIMEOUT_MS });
  } catch { throw new HttpError(500, 'could not create account'); } finally { inflight = null; }
  return { name, project: '_login', account: name };
}

module.exports = {
  DEFAULT_ACCOUNT, NAME_RE, validAccount, parseAccount, accountOfPath, transcriptRoots,
  listAccounts, createAccount,
};
