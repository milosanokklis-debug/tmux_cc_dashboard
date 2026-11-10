'use strict';
// The one live connection: a WebSocket to /events. The server pushes state, usage, tokens and
// pane previews; it reconnects with backoff while down. (The Windows panel polls its own list.)
(function () {
  const MAX_WATCH = 50; // the server's per-connection limit
  const handlers = new Map(); // type -> Set<fn>
  const lastMsg = new Map(); // type -> last payload message (not for previews)
  const watched = new Set(); // ids this page wants previews for
  let sock = null;
  let running = false;
  let delay = 1000;
  let retry = null;

  const connected = () => !!sock && sock.readyState === 1;

  function emit(msg) {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type !== 'preview') lastMsg.set(msg.type, msg);
    for (const fn of handlers.get(msg.type) || []) {
      try { fn(msg); } catch (e) { console.error('events handler failed', e); }
    }
  }

  function send(obj) {
    if (connected()) sock.send(JSON.stringify(obj));
  }

  function scheduleRetry() {
    clearTimeout(retry);
    if (!running) return;
    const wait = delay * (0.8 + Math.random() * 0.4);
    delay = Math.min(delay * 2, 30000);
    retry = setTimeout(connect, wait);
  }

  function connect() {
    if (!running || sock) return;
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/events';
    let ws;
    try { ws = new WebSocket(url); } catch { scheduleRetry(); return; }
    sock = ws;
    ws.addEventListener('open', () => {
      delay = 1000;
      emit({ type: 'connection', connected: true });
      const ids = [...watched];
      for (let i = 0; i < ids.length; i += MAX_WATCH) send({ type: 'watch', ids: ids.slice(i, i + MAX_WATCH) });
    });
    ws.addEventListener('message', (e) => {
      let msg = null;
      try { msg = JSON.parse(e.data); } catch { return; }
      emit(msg);
    });
    const gone = () => {
      if (sock !== ws) return;
      sock = null;
      emit({ type: 'connection', connected: false });
      scheduleRetry();
    };
    ws.addEventListener('close', gone);
    ws.addEventListener('error', () => { /* close follows */ });
  }

  window.ccdash.events = {
    start() { if (running) return; running = true; delay = 1000; connect(); },
    // on('state', fn) -> off(). Also 'connection' with {connected}.
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type).delete(fn);
    },
    last(type) { return lastMsg.get(type) || null; },
    connected,
    // Set the whole watch list in one go; sends only the difference.
    setWatched(ids) {
      const want = new Set([...ids].slice(0, MAX_WATCH));
      const add = [...want].filter((id) => !watched.has(id));
      const del = [...watched].filter((id) => !want.has(id));
      watched.clear();
      for (const id of want) watched.add(id);
      if (del.length) send({ type: 'unwatch', ids: del });
      if (add.length) send({ type: 'watch', ids: add });
    },
  };
})();
