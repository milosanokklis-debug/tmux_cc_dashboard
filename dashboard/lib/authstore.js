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
  // a password change keeps the second factor and the "TOTP required" flag
  let prev = null;
  try { prev = readAuth(dir); } catch { /* unusable old file: start clean */ }
  writeFileAtomic(path.join(dir, 'auth.json'), JSON.stringify({ ...prev, username, hash, generation }));
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

const RECOVERY_COUNT = 10;
const normRecovery = (c) => String(c).toLowerCase().replace(/[^a-z0-9]/g, '');

function newRecoveryCodes() {
  return Array.from({ length: RECOVERY_COUNT }, () => {
    const h = crypto.randomBytes(5).toString('hex');
    return `${h.slice(0, 5)}-${h.slice(5)}`;
  });
}

function mutate(dir, fn) {
  const a = readAuth(dir);
  if (!a) throw new Error('no credentials: run ccd passwd first');
  fn(a);
  writeFileAtomic(path.join(dir, 'auth.json'), JSON.stringify(a));
  return a;
}

// Stores the TOTP secret and 10 fresh recovery codes (returned once, stored as argon2id hashes).
// `rotate` also changes the generation, which ends every session (CLI use).
async function enableTotp({ dir = webDir(), secret, step, rotate = false, hashOptions = {} }) {
  const codes = newRecoveryCodes();
  const recovery = await Promise.all(codes.map((c) => argon2.hash(normRecovery(c), { type: argon2.argon2id, ...hashOptions })));
  mutate(dir, (a) => {
    if (a.totp && !rotate) throw Object.assign(new Error('two-factor already enrolled'), { status: 409 });
    a.totp = { secret, lastStep: step ?? 0 };
    a.recovery = recovery;
    if (rotate) { a.generation = crypto.randomBytes(16).toString('hex'); }
  });
  if (rotate) fs.rmSync(path.join(dir, 'sessions.json'), { force: true });
  return codes;
}

function disableTotp({ dir = webDir() } = {}) {
  mutate(dir, (a) => {
    delete a.totp;
    delete a.recovery;
    a.generation = crypto.randomBytes(16).toString('hex');
  });
  fs.rmSync(path.join(dir, 'sessions.json'), { force: true });
}

// A matched step is accepted only if it is newer than lastStep; lastStep is persisted before returning.
function acceptStep(dir, step) {
  let ok = false;
  mutate(dir, (a) => {
    if (a.totp && Number.isInteger(step) && step > a.totp.lastStep) { a.totp.lastStep = step; ok = true; }
  });
  return ok;
}

// Single-use: the matching hash is removed and the file rewritten before resolving true.
async function useRecovery(dir, code) {
  const a = readAuth(dir);
  const norm = normRecovery(code);
  if (!a?.recovery?.length || norm.length !== 10) return false;
  let idx = -1;
  for (let i = 0; i < a.recovery.length; i++) {
    let m = false;
    try { m = await argon2.verify(a.recovery[i], norm); } catch { m = false; }
    if (m && idx < 0) idx = i;
  }
  if (idx < 0) return false;
  const hash = a.recovery[idx];
  let ok = false;
  mutate(dir, (b) => { // re-read: a concurrent use must not succeed twice
    const j = (b.recovery || []).indexOf(hash);
    if (j >= 0) { b.recovery.splice(j, 1); ok = true; }
  });
  return ok;
}

// "TOTP required but not enrolled": file flag or CCDASH_TOTP_REQUIRED=1.
const totpRequired = (a) => !!(a && (a.totpRequired === true || process.env.CCDASH_TOTP_REQUIRED === '1'));

function setTotpRequired({ dir = webDir(), required }) {
  mutate(dir, (a) => { if (required) a.totpRequired = true; else delete a.totpRequired; });
}

module.exports = {
  enableTotp, disableTotp, acceptStep, useRecovery, totpRequired, setTotpRequired,

  MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, MAX_USERNAME_LENGTH,
  webDir, checkPasswordRule, checkUsernameRule, readAuth, setCredentials, verifyLogin,
  writeFileAtomic,
};
