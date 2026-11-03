'use strict';
// Shared helpers. Everything the dashboard renders from the server goes through
// textContent (never innerHTML): agent task text is controlled by Claude.
(function () {
  const ns = (window.ccdash = {});

  ns.api = async function api(path, opts) {
    opts = opts || {};
    const headers = { 'X-CCDash': '1' };
    let body = opts.body;
    if (body !== undefined && typeof body !== 'string') {
      body = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers,
      body,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (res.status === 401) {
      window.location.assign('/login');
      throw new Error('unauthorized');
    }
    let data = null;
    try { data = JSON.parse(await res.text()); } catch { data = null; }
    return { ok: res.ok, status: res.status, data };
  };

  ns.h = function h(tag, props, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children || []) node.append(c);
    return node;
  };

  // Status chip: icon + text, never colour alone. `map` is { status: { label, icon } }; the status also picks the colour class.
  ns.chip = function chip(map, status) {
    const s = map[status];
    return ns.h('span', { class: 'chip chip-' + status }, [
      ns.h('span', { class: 'chip-icon', 'aria-hidden': 'true', text: s.icon }),
      ns.h('span', { text: s.label }),
    ]);
  };

  ns.fmtDuration = function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec));
    if (sec < 60) return sec + 's';
    const m = Math.floor(sec / 60);
    if (sec < 3600) return m + 'm ' + String(sec % 60).padStart(2, '0') + 's';
    const hh = Math.floor(m / 60);
    if (sec < 86400) return hh + 'h ' + (m % 60) + 'm';
    return Math.floor(hh / 24) + 'd ' + (hh % 24) + 'h';
  };

  // Non-overlapping poller: waits for fn to finish, then schedules the next run.
  // Pauses while the tab is hidden and runs immediately when it becomes visible.
  ns.poller = function poller(fn, ms) {
    let timer = null;
    let running = false;
    let gen = 0;
    async function tick(myGen) {
      if (document.hidden) return;
      try { await fn(); } catch { /* callers report their own errors */ }
      if (myGen === gen && running && !document.hidden) timer = setTimeout(() => tick(myGen), ms);
    }
    function onVis() {
      clearTimeout(timer);
      if (running && !document.hidden) tick(++gen);
    }
    document.addEventListener('visibilitychange', onVis);
    return {
      start() { if (running) return; running = true; tick(++gen); },
      stop() { running = false; gen++; clearTimeout(timer); },
      now() { clearTimeout(timer); if (running) tick(++gen); },
    };
  };

  // Dismissible message. kind: 'error' (announced assertively) or 'info'.
  ns.notice = function notice(message, kind) {
    const box = document.getElementById('notices');
    const item = ns.h('div', { class: 'notice notice-' + (kind === 'error' ? 'error' : 'info'), role: kind === 'error' ? 'alert' : 'status' });
    item.append(ns.h('span', { class: 'notice-icon', 'aria-hidden': 'true', text: kind === 'error' ? '!' : 'i' }));
    item.append(ns.h('span', { class: 'notice-text', text: message }));
    const close = ns.h('button', { type: 'button', class: 'btn btn-ghost notice-close', 'aria-label': 'Dismiss message', text: '×' });
    close.addEventListener('click', () => item.remove());
    item.append(close);
    box.append(item);
    return item;
  };
})();
