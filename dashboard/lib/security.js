'use strict';
const net = require('node:net');

const COOKIE_NAME = '__Host-ccdash';
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), display-capture=(), accelerometer=(), gyroscope=(), magnetometer=(), midi=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// CCDASH_ORIGIN (the Cloudflare hostname) plus the SSH-tunnel origin.
function allowedOrigins() {
  const set = new Set(['http://localhost:7690']);
  const o = (process.env.CCDASH_ORIGIN || '').trim().replace(/\/+$/, '');
  if (o) set.add(o);
  return set;
}

// The container is only reachable through cloudflared (which sets CF-Connecting-IP)
// or the local SSH tunnel, so the header is trusted when it is a valid IP; otherwise
// the socket address is used.
// Known limit: processes inside the container (ccd, which shares the network
// namespace) can connect directly and send any CF-Connecting-IP. That lets them
// evade the per-client delay, but the global lockout (50 failures/h) still caps
// brute force, and they can also use it to lock the owner out.
function clientIp(req) {
  const h = req.headers['cf-connecting-ip'];
  const ip = typeof h === 'string' ? h.trim() : '';
  if (net.isIP(ip)) return ip;
  return req.socket.remoteAddress || 'unknown';
}

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

function sessionIdFromRequest(req) {
  return parseCookies(req.headers.cookie)[COOKIE_NAME] || null;
}

function sessionCookie(id) {
  return `${COOKIE_NAME}=${id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}`;
}
function clearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

function originAllowed(req, origins) {
  const o = req.headers.origin;
  return typeof o === 'string' && origins.has(o);
}

// Returns null when fine, else { status, error }.
function checkStateChanging(req, origins) {
  if (!STATE_CHANGING.has(req.method)) return null;
  if (!originAllowed(req, origins)) return { status: 403, error: 'forbidden origin' };
  if (req.headers['x-ccdash'] !== '1') return { status: 403, error: 'missing X-CCDash header' };
  return null;
}

function rejectUpgrade(socket, status, text) {
  if (socket.writable) {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  socket.destroy();
}

// Reusable guard for a future WebSocket 'upgrade' handler: needs a valid session
// and an allowed Origin. Returns { key } (the session key, for the registry) on
// success; otherwise writes 401/403, destroys the socket and returns null.
function guardUpgrade(req, socket, { sessions, origins }) {
  if (!originAllowed(req, origins)) { rejectUpgrade(socket, 403, 'Forbidden'); return null; }
  const id = sessionIdFromRequest(req);
  if (!id || !sessions.validate(id)) { rejectUpgrade(socket, 401, 'Unauthorized'); return null; }
  return { key: sessions.keyOf(id), id };
}

module.exports = {
  COOKIE_NAME, SECURITY_HEADERS, allowedOrigins, clientIp, sessionIdFromRequest,
  sessionCookie, clearCookie, checkStateChanging, guardUpgrade, rejectUpgrade,
};
