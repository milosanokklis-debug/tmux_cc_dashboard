'use strict';
// Open (future WebSocket) sockets keyed by session id, so logout, expiry and
// password change can close them.
class SocketRegistry {
  constructor() { this.byKey = new Map(); }

  add(key, socket) {
    let set = this.byKey.get(key);
    if (!set) this.byKey.set(key, (set = new Set()));
    set.add(socket);
    socket.on('error', () => {}); // a reset must not become an uncaught exception
    socket.once('close', () => this.remove(key, socket));
  }

  remove(key, socket) {
    const set = this.byKey.get(key);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.byKey.delete(key);
  }

  closeSession(key) {
    const set = this.byKey.get(key);
    if (!set) return;
    this.byKey.delete(key);
    for (const s of set) s.destroy();
  }

  closeAll() {
    for (const key of [...this.byKey.keys()]) this.closeSession(key);
  }

  // Close sockets whose session key is no longer in `keepKeys` predicate.
  closeWhere(isDead) {
    for (const key of [...this.byKey.keys()]) if (isDead(key)) this.closeSession(key);
  }
}

module.exports = { SocketRegistry };
