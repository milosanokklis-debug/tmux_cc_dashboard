'use strict';
// Login brute-force protection (in memory).
//  - per client: from the 6th attempt within 15 min, an exponential delay is
//    applied before responding (1s, 2s, 4s ... capped at 10s).
//  - global: 50 failures within an hour from anywhere lock ALL logins for 15 min.
// Every attempt is counted as a failure when it begins and refunded on success,
// so parallel requests cannot all slip in under the threshold.
const CLIENT_WINDOW_MS = 15 * 60 * 1000;
const CLIENT_FREE = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 10000;
const GLOBAL_WINDOW_MS = 3600 * 1000;
const GLOBAL_MAX = 50;
const LOCK_MS = 15 * 60 * 1000;

class LoginLimiter {
  constructor({ clock = Date } = {}) {
    this.clock = clock;
    this.perClient = new Map(); // ip -> [timestamps]
    this.global = [];
    this.lockedUntil = 0;
  }

  prune(now) {
    this.global = this.global.filter((t) => now - t < GLOBAL_WINDOW_MS);
    for (const [ip, list] of this.perClient) {
      const l = list.filter((t) => now - t < CLIENT_WINDOW_MS);
      if (l.length) this.perClient.set(ip, l); else this.perClient.delete(ip);
    }
  }

  // Returns { locked, retryAfterMs } or { locked:false, delayMs, finish(success) }.
  begin(ip) {
    const now = this.clock.now();
    this.prune(now);
    if (this.lockedUntil > now) return { locked: true, retryAfterMs: this.lockedUntil - now };
    const list = this.perClient.get(ip) || [];
    const prior = list.length;
    const delayMs = prior >= CLIENT_FREE
      ? Math.min(BASE_DELAY_MS * 2 ** (prior - CLIENT_FREE), MAX_DELAY_MS) : 0;
    list.push(now);
    this.perClient.set(ip, list);
    this.global.push(now);
    if (this.global.length >= GLOBAL_MAX) this.lockedUntil = now + LOCK_MS;
    return {
      locked: false,
      delayMs,
      finish: (success) => {
        if (!success) return;
        const l = this.perClient.get(ip);
        if (l) {
          const i = l.indexOf(now);
          if (i >= 0) l.splice(i, 1);
          if (!l.length) this.perClient.delete(ip);
        }
        const gi = this.global.indexOf(now);
        if (gi >= 0) this.global.splice(gi, 1);
      },
    };
  }
}

module.exports = { LoginLimiter, LOCK_MS, MAX_DELAY_MS };
