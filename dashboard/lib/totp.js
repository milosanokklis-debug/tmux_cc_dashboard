'use strict';
// TOTP (RFC 6238, HMAC-SHA1, 6 digits, 30 s) on node:crypto only.
const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));

// code for a given step counter; `secret` is base32 text or a Buffer.
function hotp(secret, counter, digits = DIGITS) {
  const key = Buffer.isBuffer(secret) ? secret : base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = h.readUInt32BE(o) & 0x7fffffff;
  return String(n % 10 ** digits).padStart(digits, '0');
}

const stepAt = (ms) => Math.floor(ms / 1000 / STEP_SECONDS);

// Returns the matched step counter (current +-window) or null.
function verify(secret, code, nowMs = Date.now(), window = 1) {
  const c = String(code).replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const cur = stepAt(nowMs);
  let hit = null;
  for (let s = cur - window; s <= cur + window; s++) {
    const a = Buffer.from(hotp(secret, s));
    if (crypto.timingSafeEqual(a, Buffer.from(c)) && hit === null) hit = s; // no early exit: constant work
  }
  return hit;
}

function otpauthUri({ secret, account, issuer = 'ccdash' }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

module.exports = { base32Encode, base32Decode, generateSecret, hotp, verify, stepAt, otpauthUri };
