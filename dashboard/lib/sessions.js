'use strict';
// Server-side sessions. The cookie carries a random 256-bit id; only its SHA-256
// is stored (in memory and in <webDir>/sessions.json, mode 0600).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeFileAtomic } = require('./authstore');

const IDLE_MS = 12 * 3600 * 1000;
const ABSOLUTE_MS = 7 * 24 * 3600 * 1000;
const PERSIST_TOUCH_MS = 60 * 1000;

const hashId = (id) => crypto.createHash('sha256').update(id).digest('hex');

class SessionStore {
  constructor({ dir, clock = Date, generation = '' } = {}) {
    this.dir = dir;
    this.clock = clock;
    this.generation = generation;
    this.map = new Map(); // key (sha256 of id) -> { created, last, gen }
    this.lastPersist = 0;
    this.load();
  }

  get file() { return path.join(this.dir, 'sessions.json'); }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [k, v] of Object.entries(data.sessions || {})) this.map.set(k, v);
    } catch { /* missing or corrupt: start empty */ }
    this.sweep();
  }

  persist() {
    this.lastPersist = this.clock.now();
    try {
      writeFileAtomic(this.file, JSON.stringify({ sessions: Object.fromEntries(this.map) }));
    } catch (e) {
      console.error('could not persist sessions:', e.code || e.message);
    }
  }

  alive(s, now) {
    return s.gen === this.generation && now - s.last < IDLE_MS && now - s.created < ABSOLUTE_MS;
  }

  create() {
    const id = crypto.randomBytes(32).toString('base64url');
    const now = this.clock.now();
    this.map.set(hashId(id), { created: now, last: now, gen: this.generation });
    this.persist();
    return id;
  }

  // Returns true and refreshes idle timer when valid; removes the session otherwise.
  validate(id) {
    if (typeof id !== 'string' || id.length < 20 || id.length > 100) return false;
    const key = hashId(id);
    const s = this.map.get(key);
    if (!s) return false;
    const now = this.clock.now();
    if (!this.alive(s, now)) {
      this.map.delete(key);
      this.persist();
      return false;
    }
    s.last = now;
    if (now - this.lastPersist > PERSIST_TOUCH_MS) this.persist();
    return true;
  }

  destroy(id) {
    if (this.map.delete(hashId(id))) this.persist();
  }

  // Drops expired / stale-generation sessions; returns the removed session keys.
  sweep() {
    const now = this.clock.now();
    const removed = [];
    for (const [k, s] of this.map) {
      if (!this.alive(s, now)) { this.map.delete(k); removed.push(k); }
    }
    if (removed.length) this.persist();
    return removed;
  }

  setGeneration(gen) {
    if (gen === this.generation) return false;
    this.generation = gen;
    this.map.clear();
    this.persist();
    return true;
  }

  keyOf(id) { return hashId(id); }
}

module.exports = { SessionStore, IDLE_MS, ABSOLUTE_MS };
