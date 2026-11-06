'use strict';
// The git identity of user ccd (`git config --global user.name/user.email`), read and written
// through ccd-ops as ccd. The web process never writes ccd's home.
const { HttpError } = require('./http');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL_RE = /[\x00-\x1f\x7f]/; // eslint-disable-line no-control-regex

// tmux reads an argument ending in ';' as the end of the command; `\;` is a literal ';' (same
// rule as tmux_args in ccd-session).
const tmuxArg = (a) => (a.endsWith(';') ? `${a.slice(0, -1)}\\;` : a);

async function getIdentity({ runOp }) {
  const op = await runOp({ argv: ['git', 'config', '--global', '--get-regexp', '^user\\.(name|email)$'], timeoutMs: 30 * 1000 });
  if (op.timedOut) throw new HttpError(504, 'reading the git identity timed out', { log: op.log });
  const out = { name: null, email: null };
  if (op.rc === 1) return out; // nothing set
  if (op.rc !== 0) throw new HttpError(502, 'could not read the git identity', { log: op.log });
  for (const line of String(op.log).split('\n')) {
    const m = /^user\.(name|email) (.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function validate(body) {
  const { name, email } = body;
  if (typeof name !== 'string') throw new HttpError(400, 'name must be text');
  if (typeof email !== 'string') throw new HttpError(400, 'email must be text');
  const n = name.trim();
  if (n.length < 1 || n.length > 100) throw new HttpError(400, 'name must be 1 to 100 characters');
  if (CONTROL_RE.test(n)) throw new HttpError(400, 'name must not contain control characters');
  if (email.length > 254) throw new HttpError(400, 'email must be at most 254 characters');
  if (CONTROL_RE.test(email) || !EMAIL_RE.test(email)) throw new HttpError(400, 'email is not a valid address');
  return { name: n, email };
}

let chain = Promise.resolve(); // one identity write at a time, so two POSTs never interleave name and email

function setIdentity(body, deps) {
  const { name, email } = validate(body);
  const run = chain.then(() => write(name, email, deps));
  chain = run.catch(() => {});
  return run;
}

async function write(name, email, { runOp }) {
  let written = null;
  for (const [key, value] of [['user.name', name], ['user.email', email]]) {
    const op = await runOp({ argv: ['git', 'config', '--global', key, tmuxArg(value)], timeoutMs: 30 * 1000 });
    const after = written ? `; ${written} was already written` : '';
    if (op.timedOut) throw new HttpError(504, `setting ${key} timed out${after}`, { log: op.log });
    if (op.rc !== 0) throw new HttpError(502, `could not set ${key}${after}`, { log: op.log });
    written = key;
  }
  return { ok: true, name, email, message: `git identity set to ${name} ${email}` };
}

module.exports = { getIdentity, setIdentity, validate };
