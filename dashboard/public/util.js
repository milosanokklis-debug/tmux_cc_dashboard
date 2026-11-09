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

  // Claude accounts. `list` is the last /api/accounts answer (default first); it starts as just "default",
  // so until a second account is known nothing account-related is shown. Refreshed on start, when a dialog
  // that needs it opens, and after an account is added; a failed refresh keeps the last known list.
  ns.accounts = (function () {
    const RULE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
    const KEY = 'ccdash.account.';
    let list = [{ name: 'default', loggedIn: true }];
    let fetched = false;
    let viewing = null; // account of the terminal in view, null elsewhere
    const subs = new Set();
    const names = () => list.map((a) => a.name);
    const multi = () => list.length > 1;
    function notify() { for (const fn of subs) { try { fn(); } catch (e) { console.error('accounts handler failed', e); } } }
    async function load() {
      try {
        const r = await ns.api('/api/accounts');
        if (r.ok && r.data && Array.isArray(r.data.accounts) && r.data.accounts.length) {
          const next = r.data.accounts.map((a) => ({ name: String(a.name), loggedIn: !!a.loggedIn }));
          const changed = JSON.stringify(next) !== JSON.stringify(list);
          list = next;
          fetched = true;
          if (changed) notify();
        }
      } catch { /* keep the last known list; api() redirects a 401 itself */ }
      return list;
    }
    function last(project) {
      let v = null;
      try { v = localStorage.getItem(KEY + project); } catch { /* storage off */ }
      return v && RULE.test(v) && (!fetched || names().includes(v)) ? v : 'default';
    }
    function setLast(project, name) {
      try { if (name && name !== 'default') localStorage.setItem(KEY + project, name); else localStorage.removeItem(KEY + project); } catch { /* storage off */ }
    }
    // Fill a <select> with the known accounts, keeping `value` (or the current choice) selected.
    function fill(select, value) {
      const want = value || select.value || 'default';
      select.replaceChildren(...names().map((n) => ns.h('option', { value: n, text: n })));
      select.value = names().includes(want) ? want : 'default';
    }
    return {
      RULE, load, names, multi, last, setLast, fill,
      list: () => list,
      loaded: () => fetched,
      onChange(fn) { subs.add(fn); },
      view: () => viewing,
      setView(name) { viewing = name; },
    };
  })();

  ns.fmtDuration = function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec));
    if (sec < 60) return sec + 's';
    const m = Math.floor(sec / 60);
    if (sec < 3600) return m + 'm ' + String(sec % 60).padStart(2, '0') + 's';
    const hh = Math.floor(m / 60);
    if (sec < 86400) return hh + 'h ' + (m % 60) + 'm';
    return Math.floor(hh / 24) + 'd ' + (hh % 24) + 'h';
  };

  // Compact counts: 950, 1.2k, 34k, 3.4M, 1.2B.
  ns.fmtNum = function fmtNum(n) {
    n = Number(n);
    if (!Number.isFinite(n)) return '0';
    const abs = Math.abs(n);
    const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
    for (const [size, suffix] of units) {
      if (abs >= size) {
        const v = n / size;
        return (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)).replace(/\.0$/, '') + suffix;
      }
    }
    return String(Math.round(n));
  };

  ns.fmtUsd = function fmtUsd(n) {
    if (n == null || !Number.isFinite(Number(n))) return '–';
    n = Number(n);
    if (n > 0 && n < 0.01) return '<$0.01';
    return '$' + n.toFixed(2);
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
