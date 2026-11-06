'use strict';
// Usage panel: the two plan-limit gauges (5-hour, 7-day) and token totals grouped five ways.
// Data arrives over /events (usage, tokens); when the socket is down the panel makes one request per
// payload on open. Every server string goes through textContent. Dollar figures are always shown with
// the "API-price estimate, not billing" label.
(function () {
  const { api, h, fmtNum, fmtUsd, fmtDuration } = window.ccdash;
  const events = window.ccdash.events;
  const $ = (id) => document.getElementById(id);
  const PRICE_LABEL = 'API-price estimate, not billing';
  const SOURCE = { statusline: 'Claude Code statusline', 'usage-command': '/usage command (fallback)' };
  const WINDOWS = [
    ['five_hour', '5-hour limit'],
    ['seven_day', '7-day limit'],
  ];
  const TABS = [
    ['window', 'By 5-hour window', 'by_window'],
    ['project', 'By project', 'by_project'],
    ['conversation', 'By conversation', 'by_conversation'],
    ['model', 'By model', 'by_model'],
    ['agent', 'By agent', 'by_agent'],
  ];
  const COLS = [
    ['input', 'Input'], ['output', 'Output'], ['cache_creation', 'Cache creation'], ['cache_read', 'Cache read'],
  ];

  const dlg = $('usage-dialog');
  let usage = null;
  let tokens = null;
  let tab = 'window';
  let tickTimer = null;
  let opener = null;
  const failed = { usage: false, tokens: false }; // the last HTTP load failed and no push has replaced it
  const gauges = {}; // name -> element refs
  const LOAD = {
    usage: { what: 'plan usage', path: '/api/usage', box: 'usage-error', set: (d) => { usage = d; } },
    tokens: { what: 'token counts', path: '/api/tokens', box: 'token-error', set: (d) => { tokens = d; } },
  };

  const nowSec = () => Date.now() / 1000;

  // ---------------------------------------------------------------- gauges

  function buildGauges() {
    const box = $('usage-gauges');
    for (const [name, label] of WINDOWS) {
      const id = 'gauge-' + name;
      const value = h('span', { class: 'gauge-value', id: id + '-v', 'data-testid': 'gauge-value' });
      const fill = h('span', { class: 'gauge-fill' });
      const bar = h('div', { class: 'gauge-bar', id: id + '-bar' }, [fill]);
      const reset = h('p', { class: 'gauge-reset', 'data-testid': 'gauge-reset' });
      const note = h('p', { class: 'gauge-note', id: id + '-note', 'data-testid': 'gauge-stale', hidden: '' });
      const root = h('div', { class: 'gauge', 'data-testid': 'gauge-' + name, 'data-window': name, 'data-status': 'unknown' }, [
        h('div', { class: 'gauge-head' }, [h('h4', { class: 'gauge-label', id: id + '-l', text: label }), value]),
        bar, reset, note,
      ]);
      gauges[name] = { root, value, fill, bar, reset, note, label, data: null };
      box.append(root);
    }
  }

  function levelOf(p) { return p >= 90 ? 'high' : p >= 70 ? 'mid' : 'low'; }

  function paintGauge(name) {
    const g = gauges[name];
    const w = usage && usage[name];
    g.data = w || null;
    const ok = w && w.status === 'ok' && Number.isFinite(w.used_percentage);
    g.root.dataset.status = ok ? 'ok' : 'unknown';
    if (!ok) {
      g.value.textContent = usage || failed.usage ? 'unknown' : '…';
      g.fill.style.width = '0';
      g.root.removeAttribute('data-level');
      // A meter needs a value: with none the track is an image with a label, not a meter.
      g.bar.removeAttribute('aria-valuemin'); g.bar.removeAttribute('aria-valuemax');
      g.bar.removeAttribute('aria-valuenow'); g.bar.removeAttribute('aria-valuetext');
      g.bar.removeAttribute('aria-describedby');
      g.bar.setAttribute('role', 'img');
      g.bar.setAttribute('aria-label', g.label + ': unknown');
      g.reset.textContent = '';
      g.note.hidden = false;
      if (!usage) g.note.textContent = failed.usage ? 'Not available: the usage request failed. Use Retry above.' : 'Loading…';
      else g.note.textContent = 'No reading yet. It appears once a Claude session reports its limits.';
      return;
    }
    const pct = Math.max(0, Math.min(100, w.used_percentage));
    const text = Math.round(pct) + '%';
    g.value.textContent = text;
    g.fill.style.width = pct + '%';
    g.root.dataset.level = levelOf(pct);
    g.bar.setAttribute('role', 'meter');
    g.bar.setAttribute('aria-label', g.label + ' used');
    g.bar.setAttribute('aria-valuemin', '0');
    g.bar.setAttribute('aria-valuemax', '100');
    g.bar.setAttribute('aria-valuenow', String(Math.round(pct)));
    g.bar.setAttribute('aria-valuetext', text + ' used');
    g.note.hidden = !w.stale;
    g.note.textContent = w.stale ? 'Stale: this reading is from before the window reset, so the real figure is probably lower.' : '';
    if (w.stale) g.bar.setAttribute('aria-describedby', g.note.id); else g.bar.removeAttribute('aria-describedby');
    paintCountdown(name);
  }

  function paintCountdown(name) {
    const g = gauges[name];
    const w = g.data;
    if (!w || w.status !== 'ok') return;
    let t = '';
    if (Number.isFinite(w.resets_at)) {
      const left = w.resets_at - nowSec();
      t = left > 0 ? 'Resets in ' + fmtDuration(left) : 'Reset time has passed';
    } else if (w.resets_text) {
      t = 'Resets ' + w.resets_text;
    }
    if (g.reset.textContent !== t) g.reset.textContent = t;
  }

  function paintSource() {
    const el = $('usage-source');
    if (!usage || !usage.source) { el.textContent = usage ? 'Source: none yet.' : ''; return; }
    const age = Number.isFinite(usage.ts) ? ' Updated ' + fmtDuration(nowSec() - usage.ts) + ' ago.' : '';
    el.textContent = 'Source: ' + (SOURCE[usage.source] || usage.source) + '.' + age;
  }

  function tick() {
    for (const [name] of WINDOWS) paintCountdown(name);
    paintSource();
  }

  // ---------------------------------------------------------------- tokens

  const convNames = () => {
    const m = new Map();
    const last = events.last('tree');
    for (const p of (last && last.tree && last.tree.projects) || []) for (const c of p.conversations || []) if (c.win) m.set(c.sid, c.win);
    return m;
  };
  const short = (id) => String(id == null ? '' : id).slice(0, 8);
  const pad = (n) => String(n).padStart(2, '0');
  function fmtWindow(row) {
    const a = new Date(row.start * 1000);
    const b = new Date(row.end * 1000);
    const mon = a.toLocaleString(undefined, { month: 'short' });
    return mon + ' ' + a.getDate() + ', ' + pad(a.getHours()) + ':' + pad(a.getMinutes()) + '–' + pad(b.getHours()) + ':' + pad(b.getMinutes());
  }

  function rowLabel(kind, row, names) {
    if (kind === 'window') return { main: fmtWindow(row), sub: null };
    if (kind === 'project') return { main: row.project || '(none)', sub: null };
    if (kind === 'model') return { main: row.model || '(unknown)', sub: null };
    if (kind === 'conversation') return { main: names.get(row.conversation) || short(row.conversation), sub: row.project || null };
    return { main: row.agent_type || 'agent', sub: (names.get(row.conversation) || short(row.conversation)) + ' / ' + short(row.agent) };
  }

  function cell(text, cls) { return h('td', { class: 'num' + (cls ? ' ' + cls : ''), text }); }

  function costCell(row) {
    return h('td', { class: 'num cost', 'data-testid': 'cost', text: fmtUsd(row.cost_usd) });
  }

  function buildTable(kind, label, rows, total) {
    const names = convNames();
    const head = h('tr', {}, [
      h('th', { scope: 'col', class: 'label-col', text: label }),
      ...COLS.map(([, t]) => h('th', { scope: 'col', class: 'num', text: t })),
      h('th', { scope: 'col', class: 'num' }, [h('span', { text: 'Est. $' }), h('span', { class: 'price-sub', text: PRICE_LABEL })]),
    ]);
    const body = rows.map((row) => {
      const l = rowLabel(kind, row, names);
      const th = h('th', { scope: 'row', class: 'label-col', title: l.main + (l.sub ? ' (' + l.sub + ')' : '') }, [
        h('span', { class: 'row-main', text: l.main }),
        l.sub ? h('span', { class: 'row-sub', text: l.sub }) : null,
      ].filter(Boolean));
      return h('tr', { 'data-testid': 'token-row' }, [th, ...COLS.map(([k]) => cell(fmtNum(row[k]))), costCell(row)]);
    });
    const foot = total ? h('tfoot', {}, [h('tr', { 'data-testid': 'token-total' }, [
      h('th', { scope: 'row', class: 'label-col', text: 'Total' }),
      ...COLS.map(([k]) => cell(fmtNum(total[k]))),
      costCell(total),
    ])]) : null;
    const table = h('table', { class: 'tok-table', 'data-testid': 'token-table', 'aria-label': 'Tokens ' + label.toLowerCase() }, [
      h('thead', {}, [head]), h('tbody', {}, body),
    ]);
    if (foot) table.append(foot);
    return table;
  }

  function paintTokens() {
    const panel = $('token-panel');
    const note = $('token-note');
    paintLoadError('tokens');
    if (!tokens) {
      note.hidden = true;
      panel.replaceChildren(failed.tokens ? h('p', { class: 'muted', text: 'No token counts are shown.' }) : h('p', { class: 'muted', text: 'Loading…' }));
      return;
    }
    const unavailable = tokens.reader && tokens.reader.unavailable;
    if (unavailable) {
      note.hidden = true;
      panel.replaceChildren(h('p', { class: 'tok-unavailable', role: 'status', 'data-testid': 'tokens-unavailable' }, [
        h('strong', { text: 'Reader unavailable' }),
        h('span', { text: ' Token counts cannot be read right now, so no figures are shown.' }),
      ]));
      return;
    }
    note.hidden = false;
    const def = TABS.find((t) => t[0] === tab) || TABS[0];
    const rows = Array.isArray(tokens[def[2]]) ? tokens[def[2]] : [];
    const kids = [];
    const unpriced = Array.isArray(tokens.unpriced_models) ? tokens.unpriced_models.length : 0;
    if (tokens.total) {
      kids.push(h('p', { class: 'tok-summary', 'data-testid': 'token-summary' }, [
        h('span', { class: 'tok-sum-fig', text: fmtUsd(tokens.total.cost_usd) }),
        h('span', { class: 'price-label', 'data-testid': 'price-note', text: PRICE_LABEL }),
        unpriced ? h('span', { class: 'tok-unpriced', 'data-testid': 'unpriced-count', text: 'excludes ' + unpriced + ' unpriced model' + (unpriced === 1 ? '' : 's') }) : null,
        h('span', { class: 'muted', text: fmtNum(tokens.total.input) + ' in, ' + fmtNum(tokens.total.output) + ' out in total' }),
      ].filter(Boolean)));
    }
    if (!rows.length) kids.push(h('p', { class: 'muted', text: 'Nothing recorded yet.' }));
    else kids.push(h('div', { class: 'tok-scroll', tabindex: '0', role: 'region', 'aria-label': def[1] + ' (scrolls sideways on narrow screens)' }, [buildTable(def[0], def[1].replace(/^By /, ''), rows, tokens.total)]));
    if (Array.isArray(tokens.unpriced_models) && tokens.unpriced_models.length) {
      kids.push(h('p', { class: 'hint', text: 'No price known for: ' + tokens.unpriced_models.join(', ') + '. Their tokens are counted, their dollars are not.' }));
    }
    panel.replaceChildren(...kids);
  }

  function buildTabs() {
    const box = $('token-tabs');
    for (const [key, label] of TABS) {
      const b = h('button', {
        type: 'button', role: 'tab', class: 'btn seg-btn', id: 'token-tab-' + key, 'data-testid': 'token-tab-' + key,
        'aria-controls': 'token-panel', 'aria-selected': String(key === tab), tabindex: key === tab ? '0' : '-1', text: label,
      });
      b.addEventListener('click', () => select(key));
      box.append(b);
    }
    box.addEventListener('keydown', (e) => {
      const i = TABS.findIndex((t) => t[0] === tab);
      let n = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % TABS.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i + TABS.length - 1) % TABS.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = TABS.length - 1;
      if (n == null) return;
      e.preventDefault();
      select(TABS[n][0]);
      $('token-tab-' + TABS[n][0]).focus();
    });
  }

  function select(key) {
    tab = key;
    for (const [k] of TABS) {
      const b = $('token-tab-' + k);
      b.setAttribute('aria-selected', String(k === key));
      b.tabIndex = k === key ? 0 : -1;
    }
    $('token-panel').setAttribute('aria-labelledby', 'token-tab-' + key);
    paintTokens();
  }

  // ---------------------------------------------------------------- data + open/close

  function paintUsage() {
    paintLoadError('usage');
    for (const [name] of WINDOWS) paintGauge(name);
    paintSource();
  }

  events.on('usage', (m) => { usage = m.usage || null; failed.usage = false; if (dlg.open) paintUsage(); });
  events.on('tokens', (m) => { tokens = m.tokens || null; failed.tokens = false; if (dlg.open) paintTokens(); });

  // A failed or empty response leaves the panel on an error with a Retry button, not on "Loading…".
  // The Retry button stays in place while the request runs, so keyboard focus is not lost on the way.
  function paintLoadError(kind) {
    const box = $(LOAD[kind].box);
    const hadFocus = box.contains(document.activeElement);
    box.replaceChildren();
    box.hidden = !failed[kind];
    if (failed[kind]) {
      const retry = h('button', { type: 'button', class: 'btn', text: 'Retry', 'data-testid': kind + '-retry' });
      retry.addEventListener('click', () => fetchOnce(kind));
      box.append(h('span', { text: 'Could not load ' + LOAD[kind].what + '. ' }), retry);
      if (hadFocus) retry.focus({ preventScroll: true });
    } else if (hadFocus) {
      $('usage-close').focus({ preventScroll: true });
    }
  }

  async function fetchOnce(kind) {
    const src = LOAD[kind];
    let ok = false;
    try {
      const r = await api(src.path);
      if (r.ok && r.data) { src.set(r.data); ok = true; }
    } catch { /* api() sends a 401 to the login page; any other error counts as a failed load */ }
    failed[kind] = !ok;
    if (!dlg.open) return;
    if (kind === 'usage') paintUsage(); else paintTokens();
  }

  function open() {
    opener = $('usage-open');
    usage = (events.last('usage') || {}).usage || usage;
    tokens = (events.last('tokens') || {}).tokens || tokens;
    dlg.showModal();
    paintUsage();
    paintTokens();
    // The socket sends a snapshot on connect; ask over HTTP once only when it has nothing.
    if (!usage) fetchOnce('usage');
    if (!tokens) fetchOnce('tokens');
    clearInterval(tickTimer);
    tickTimer = setInterval(tick, 1000);
    $('usage-close').focus({ preventScroll: true });
  }

  buildGauges();
  buildTabs();
  $('token-panel').setAttribute('aria-labelledby', 'token-tab-' + tab);
  $('usage-open').addEventListener('click', open);
  $('usage-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => { clearInterval(tickTimer); tickTimer = null; if (opener) opener.focus(); });
  document.addEventListener('visibilitychange', () => { if (dlg.open && !document.hidden) tick(); });
})();
