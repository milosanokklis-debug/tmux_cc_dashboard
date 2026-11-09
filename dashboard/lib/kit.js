'use strict';
// GET /api/kit (ccd-kit check) and POST /api/kit/update (ccd-kit update [--reset]). The raw ccd-kit log is
// never returned: only parsed, validated and capped fields leave this module.
const { HttpError } = require('./http');
const { cleanText } = require('./projects');

const SHA_RE = /^[0-9a-f]{40}$/;
const VER_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,40}$/;
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/;
const val = (re) => (x) => (x === '-' ? null : re.test(x) ? x : undefined); // undefined: invalid
const sha = val(SHA_RE);
const ver = val(VER_RE);

let updating = false;
const isUpdating = () => updating;

let checking = null; // concurrent GET /api/kit calls share one ccd-kit check
const check = (svc) => (checking ||= doCheck(svc).finally(() => { checking = null; }));

async function doCheck(svc) {
  const op = await svc.runOp({ argv: ['ccd-kit', 'check'], timeoutMs: 60 * 1000 });
  if (op.timedOut) throw new HttpError(504, 'kit check timed out');
  const log = String(op.log || '');
  const active = /^active (\S+) (\S+)$/m.exec(log);
  const image = /^image (\S+)$/m.exec(log);
  const newest = /^newest ([0-9a-f]{40})$/m.exec(log);
  const nerr = /^newest-error (.*)$/m.exec(log);
  const a = active && sha(active[1]) !== undefined && ver(active[2]) !== undefined ? { sha: sha(active[1]), version: ver(active[2]) } : null;
  const i = image && sha(image[1]) !== undefined ? { sha: sha(image[1]) } : null;
  if ((op.rc !== 0 && !(op.rc === 1 && nerr)) || !a || !i || (op.rc === 0 && !newest)) throw new HttpError(502, 'kit check failed');
  const n = op.rc === 0 ? { sha: newest[1] } : null;
  return {
    active: a, image: i, newest: n, ...(nerr && !n ? { error: cleanText(nerr[1]) } : {}),
    updateAvailable: !!n && n.sha !== a.sha,
  };
}

// POST /api/kit/update { reset? }
async function update(body, svc) {
  if (body?.reset !== undefined && typeof body.reset !== 'boolean') throw new HttpError(400, 'reset must be true or false');
  if (updating) throw new HttpError(409, 'a kit update is already in progress');
  updating = true;
  try {
    const op = await svc.runOp({ argv: ['ccd-kit', 'update', ...(body?.reset === true ? ['--reset'] : [])], timeoutMs: 10 * 60 * 1000 });
    if (op.timedOut) throw new HttpError(504, 'kit update timed out');
    const log = String(op.log || '');
    if (op.rc === 2) throw new HttpError(400, 'invalid kit ref');
    if (op.rc !== 0) {
      const m = /^ccd-kit: (.*)$/m.exec(log);
      throw new HttpError(502, m ? cleanText(m[1]) : 'kit update failed');
    }
    const u = /^updated (\S+) (\S+)$/m.exec(log);
    const v = /^version (\S+) (\S+)$/m.exec(log);
    const projects = [];
    for (const m of log.matchAll(/^project (\S+) (ok|changed|failed)(?: (.*))?$/gm)) {
      if (!NAME_RE.test(m[1]) || projects.length >= 200) continue;
      const msg = m[3] || '';
      projects.push({ name: m[1], status: m[2], message: m[2] === 'failed' ? (/^kit(-error)? /.test(msg) ? cleanText(msg) : 'kit step failed') : cleanText(msg) });
    }
    if (u && v && sha(u[1]) !== undefined && sha(u[2]) && ver(v[1]) !== undefined && ver(v[2]) !== undefined) {
      return { old: sha(u[1]), new: sha(u[2]), versions: { old: ver(v[1]), new: ver(v[2]) }, projects };
    }
    // The head of a long log was cut off (runOp keeps the tail): the update itself succeeded, so ask for the active kit.
    const st = await svc.runOp({ argv: ['ccd-kit', 'status'], timeoutMs: 60 * 1000 });
    const a = st.rc === 0 ? /^active (\S+) (\S+)$/m.exec(String(st.log || '')) : null;
    const ns = a ? sha(a[1]) : undefined, nv = a ? ver(a[2]) : undefined;
    return { old: null, new: ns ?? null, versions: { old: null, new: ns === undefined || nv === undefined ? null : nv }, projects, truncated: true };
  } finally { updating = false; }
}

module.exports = { check, update, isUpdating };
