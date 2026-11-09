'use strict';
// Claude accounts, dashboard side. The name rule lives here once (it mirrors account_valid in
// rootfs/usr/local/lib/ccdash/accounts.sh); the account store itself belongs to user ccd, so the
// dashboard never reads it: it asks ccd-account (list, create) and ccd-session (unknown account).
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./http');

const DEFAULT_ACCOUNT = 'default';
const ACCOUNTS_DIR = '/home/ccd/.claude-accounts';
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const LIST_TIMEOUT_MS = 90 * 1000; // `claude auth status` runs once per account, each up to 30 s
const CREATE_TIMEOUT_MS = 60 * 1000;
// The login window: ccd-session start _login --account NAME runs claude (no project) in ccd's home.
const LOGIN_PROJECT = '_login';

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
  const base = ACCOUNTS_DIR;
  if (typeof p !== 'string' || path.normalize(p) !== p || !p.startsWith(`${base}/`)) return DEFAULT_ACCOUNT;
  const name = p.slice(base.length + 1).split('/')[0];
  return NAME_RE.test(name) ? name : DEFAULT_ACCOUNT;
}

// Transcript roots for tree.js: the default config dir plus each account's, when the accounts dir is readable.
function transcriptRoots() {
  const base = ACCOUNTS_DIR;
  const out = ['/home/ccd/.claude'];
  try {
    for (const n of fs.readdirSync(base)) if (NAME_RE.test(n)) out.push(path.join(base, n));
  } catch { /* not readable from here: only the default root */ }
  return out;
}

// [{ name, loggedIn }], default first. Output of `ccd-account list`: "name<TAB>logged in|not logged in".
let listCache = null; // { at, p }: shared in-flight/recent result, so polling does not spawn ccd-account list each time
const LIST_TTL_MS = 3000;

function listAccounts(runFile) {
  if (!listCache || Date.now() - listCache.at > LIST_TTL_MS) {
    const entry = { at: Date.now(), p: listAccountsNow(runFile) };
    entry.p.catch(() => { if (listCache === entry) listCache = null; });
    listCache = entry;
  }
  return listCache.p;
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
  } catch { throw new HttpError(500, 'could not create account'); } finally { listCache = null; }
  return { name, project: LOGIN_PROJECT, account: name };
}

module.exports = {
  DEFAULT_ACCOUNT, ACCOUNTS_DIR, NAME_RE, LOGIN_PROJECT, validAccount, parseAccount, accountOfPath, transcriptRoots,
  listAccounts, createAccount,
};
