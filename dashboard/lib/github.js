'use strict';
// GitHub token check and token storage. Tokens are never logged, returned or read back.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HttpError } = require('./http');

const TOKEN_RE = /^[A-Za-z0-9_.-]{1,255}$/;

function validateToken(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new HttpError(400, 'invalid token format');
}

// GET /repos/{owner}/{repo} with the token; anything but 200 refuses before any clone.
// Returns { canPush } (false only when GitHub says permissions.push === false).
async function checkRepoAccess({ owner, repo, token, fetchImpl = fetch, timeoutMs = 10000 }) {
  let res;
  try {
    res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ccdash',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new HttpError(502, 'could not reach GitHub to check the token');
  }
  if (res.status !== 200) {
    throw new HttpError(400, `GitHub rejected the token for ${owner}/${repo} (HTTP ${res.status})`);
  }
  let body = null;
  try { body = await res.json(); } catch { /* permissions stay unknown */ }
  return { canPush: body?.permissions?.push !== false };
}

function ccdGroupId(groupFile = '/etc/group') {
  try {
    for (const line of fs.readFileSync(groupFile, 'utf8').split('\n')) {
      const f = line.split(':');
      if (f[0] === 'ccd' && /^[0-9]+$/.test(f[2])) return Number(f[2]);
    }
  } catch { /* no group file */ }
  return null;
}

// Temp file -> chmod 0640 -> chgrp ccd -> rename, so the credential helper (user ccd, via
// group ccd) never sees a half-written or world-readable file. `gid: null` skips the group
// (tests); by default the ccd group must exist and own the file, else nothing is stored.
function saveToken({ dir = '/var/lib/ccdash-git', owner, token, gid }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner)) throw new HttpError(400, 'invalid owner');
  const tmp = path.join(dir, `.${owner}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, token, { mode: 0o640, flag: 'wx' });
    fs.chmodSync(tmp, 0o640);
    const group = gid === undefined ? ccdGroupId() : gid;
    if (gid === undefined && group === null) throw new Error('ccd group not found');
    if (group !== null) {
      try { fs.chownSync(tmp, -1, group); } catch (e) { console.error(`warning: chgrp of the token file for ${owner} failed: ${e.code || 'error'}`); }
      const st = fs.statSync(tmp);
      if (st.gid !== group || (st.mode & 0o640) !== 0o640) throw new Error('token file is not group-readable by ccd');
    }
    fs.renameSync(tmp, path.join(dir, owner));
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to remove */ }
    console.error(`could not save token for ${owner}: ${e.code || e.message}`);
    throw new HttpError(500, 'could not store the token');
  }
}

module.exports = { validateToken, checkRepoAccess, saveToken };
