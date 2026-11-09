'use strict';
// Session (5-hour) and weekly gauges from the rate_limits that hooks/statusline.sh records in
// ~/.ccdash/usage/<sid>.json. The freshest reading (by its ts) that has rate_limits wins. When no
// reading has them the gauge is {status:'unknown'}: nothing is ever estimated.
const fs = require('node:fs');
const path = require('node:path');
const { readRegular } = require('./safefile');
const { NAME_RE, DEFAULT_ACCOUNT } = require('./accounts');

const DEFAULT_DIR = '/home/ccd/.ccdash/usage';
const MAX_FILES = 1000;
const MAX_BYTES = 64 * 1024;
const WINDOWS = [['five_hour', 5 * 3600], ['seven_day', 7 * 24 * 3600]];

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function parseReading(text) {
  let o;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== 'object' || !finite(o.ts) || o.ts < 0) return null;
  const rl = o.rate_limits && typeof o.rate_limits === 'object' ? o.rate_limits : null;
  const limits = {};
  for (const [name] of WINDOWS) {
    const w = rl?.[name];
    if (w && typeof w === 'object' && finite(w.used_percentage) && w.used_percentage >= 0 && w.used_percentage <= 1000
      && finite(w.resets_at) && w.resets_at > 0) {
      limits[name] = { used_percentage: w.used_percentage, resets_at: w.resets_at };
    }
  }
  // readings from before accounts existed have no account: they are the default account's
  const account = typeof o.account === 'string' && NAME_RE.test(o.account) ? o.account : DEFAULT_ACCOUNT;
  return { ts: o.ts, limits, account };
}

function readings(dir = DEFAULT_DIR) {
  const out = [];
  try { if (!fs.lstatSync(dir).isDirectory()) return out; } catch { return out; }
  let names;
  try { names = fs.readdirSync(dir); } catch { return out; }
  // stat every name, then keep the newest MAX_FILES, so the cap drops the oldest and never the freshest
  const dated = [];
  for (const n of names) {
    if (!/^[A-Za-z0-9_-]{1,100}\.json$/.test(n)) continue;
    try { dated.push([n, fs.lstatSync(path.join(dir, n)).mtimeMs]); } catch { /* gone */ }
  }
  dated.sort((a, b) => b[1] - a[1]);
  for (const [n] of dated.slice(0, MAX_FILES)) {
    const f = readRegular(path.join(dir, n), MAX_BYTES);
    if (!f || f.size > MAX_BYTES) continue;
    const r = parseReading(f.buf.toString('utf8'));
    if (r) out.push(r);
  }
  return out;
}

// The gauge object for one account from its readings. fallback: optional () => { ts, limits }.
function gaugesOf(all, now, fallback) {
  let best = null;
  for (const r of all) {
    if (Object.keys(r.limits).length && (!best || r.ts > best.ts)) best = r;
  }
  let source = 'statusline';
  if (!best && fallback) {
    const fb = fallback();
    if (fb && finite(fb.ts)) { best = { ts: fb.ts, limits: fb.limits || {} }; source = 'usage-command'; }
  }
  const out = { source: best ? source : null, ts: best ? best.ts : null };
  for (const [name] of WINDOWS) {
    const w = best?.limits[name];
    out[name] = w ? {
      status: 'ok', used_percentage: w.used_percentage, resets_at: w.resets_at ?? null,
      // /usage prints only a local-time text for the reset, so its readings have no epoch
      countdown: w.resets_at ? Math.max(0, w.resets_at - now) : null, ts: best.ts,
      ...(w.resets_text ? { resets_text: w.resets_text } : {}),
      // the window has rolled over since this reading: the percentage is from the old window
      stale: w.resets_at ? w.resets_at <= now : false,
    } : { status: 'unknown' };
  }
  return out;
}

// now: unix seconds. fallback: optional () => { ts, five_hour, seven_day } from usage-fallback.js.
// Readings are never mixed between accounts. The result is the default account's gauges (the shape
// callers had before accounts, usage-command fallback included) plus `accounts: { name: gauges }` for
// `default` and every other account that has a reading. The fallback only ever describes `default`.
function gauges({ dir = DEFAULT_DIR, now = Math.floor(Date.now() / 1000), fallback = null } = {}) {
  const by = new Map([[DEFAULT_ACCOUNT, []]]);
  for (const r of readings(dir)) {
    if (!by.has(r.account)) by.set(r.account, []);
    by.get(r.account).push(r);
  }
  const accounts = {};
  for (const [name, list] of by) accounts[name] = gaugesOf(list, now, name === DEFAULT_ACCOUNT ? fallback : null);
  return { ...accounts[DEFAULT_ACCOUNT], accounts };
}

module.exports = { gauges, readings, DEFAULT_DIR };
