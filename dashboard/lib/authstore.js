'use strict';
// Single-user credential store: <webDir>/auth.json { username, hash, generation }.
// `generation` is a fresh random nonce on every password change; sessions carry
// the generation they were created under, so a change invalidates all of them
// (a nonce, not a counter, so delete + recreate can never reuse a value).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const argon2 = require('argon2');

const MIN_PASSWORD_LENGTH = 14;
const MAX_PASSWORD_LENGTH = 1024;
const MAX_USERNAME_LENGTH = 128;

function webDir() {
  return '/var/lib/ccdash-web';
}

function checkPasswordRule(password) {
  if (typeof password !== 'string' || [...password].length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) return 'password is too long';
  return null;
}

function checkUsernameRule(username) {
  if (typeof username !== 'string' || username.trim() === '') return 'username must not be empty';
  if (username.length > MAX_USERNAME_LENGTH) return 'username is too long';
  return null;
}

// Writes via a temp file, fsyncs it, renames, then fsyncs the directory so the
// rename survives a crash.
function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* may not exist */ }
    throw e;
  }
  const dfd = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
}

// Constant-time string equality (compares fixed-length digests).
function safeEqual(a, b) {
  const da = crypto.createHash('sha256').update(String(a)).digest();
  const db = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(da, db);
}

// Reads auth.json; returns null when it does not exist (setup state). Throws an
// Error (without file contents) when the file is unreadable, empty or malformed;
// callers decide how to fail closed.
function readAuth(dir = webDir()) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`auth.json unreadable (${e.code || 'error'})`);
  }
  let a;
  try { a = JSON.parse(raw); } catch { throw new Error('auth.json is not valid JSON'); }
  if (!a || typeof a.username !== 'string' || typeof a.hash !== 'string'
    || typeof a.generation !== 'string' || !a.generation) {
    throw new Error('auth.json is malformed');
  }
  return a;
}

// Writes credentials with a new random generation and removes the session store.
// `hashOptions` lets tests use cheap argon2 parameters.
async function setCredentials({ dir = webDir(), username, password, hashOptions = {} }) {
  const err = checkUsernameRule(username) || checkPasswordRule(password);
  if (err) throw new Error(err);
  const hash = await argon2.hash(password, { type: argon2.argon2id, ...hashOptions });
  const generation = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(path.join(dir, 'auth.json'), JSON.stringify({ username, hash, generation }));
  fs.rmSync(path.join(dir, 'sessions.json'), { force: true });
  return generation;
}

// Verifies both username and password. The hash is always verified (even for a
// wrong username) so unknown-user and wrong-password take the same time, and the
// username comparison is constant-time.
async function verifyLogin(auth, username, password) {
  const userOk = safeEqual(auth.username, username);
  let passOk = false;
  try {
    passOk = await argon2.verify(auth.hash, password);
  } catch {
    passOk = false;
  }
  return userOk && passOk;
}

module.exports = {
  MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, MAX_USERNAME_LENGTH,
  webDir, checkPasswordRule, checkUsernameRule, readAuth, setCredentials, verifyLogin,
  writeFileAtomic,
};
