'use strict';
// Windows panel of a project's terminal view: tmux windows (claude, shell, login), pending approvals and
// stopped conversations. Windows come from GET /api/projects/:p/windows (polled while the page is visible);
// conversation status and approvals come from the /events `state` message. Everything from the server is
// rendered with textContent, never innerHTML.
(function () {
  const { api, h, notice, chip } = window.ccdash;
  const controls = window.ccdash.controls;
  const events = window.ccdash.events;
  const $ = (id) => document.getElementById(id);

  const POLL_MS = 5000;
  const CONV = {
    running: { label: 'running', icon: '●' },
    working: { label: 'working', icon: '●' },
    needs_approval: { label: 'needs approval', icon: '!' },
    waiting: { label: 'waiting', icon: '◐' },
    error: { label: 'error', icon: '✕' },
    sleeping: { label: 'sleeping', icon: '◌' },
    ended: { label: 'ended', icon: '○' },
    gone: { label: 'gone', icon: '✕' },
  };
  const STOPPED = new Set(['sleeping', 'ended']);
  const DEAD = new Set(['sleeping', 'ended', 'gone']);
  const KIND = { claude: 'Claude', shell: 'shell', login: 'sign-in' };

  let current = null; // project of the open terminal
  let windows = [];
  let states = {}; // sid -> state, as last pushed
  let lastWin = null;
  let lastConv = null;
  let lastAppr = null;
  let poll = null;
  let loading = false;
  let loaded = false; // the first answer for this project has arrived
  let gen = 0; // bumps on start/stop so a late answer for another project is dropped
  const waking = new Set();
  const busy = new Set(); // 'new:claude' | 'new:shell' | 'close:@1' | 'select:@1'

  const base = () => '/api/projects/' + encodeURIComponent(current) + '/windows';
  const winPath = (id, act) => base() + '/' + (/^@\d+$/.test(id) ? id : encodeURIComponent(id)) + '/' + act;
  const domId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');
  const errText = (r) => (r.data && r.data.error) || 'HTTP ' + r.status;
  function say(text) { $('win-status').textContent = text; }
  const sameProject = (s) => s.project === current; // fail closed: no project, or another one, is hidden
  const decided = new Set(); // approval ids answered here; hidden until the server stops reporting them
  const mine = () => Object.entries(states).filter(([, s]) => sameProject(s)).map(([sid, s]) => ({ sid, ...s }))
    .map((s) => (s.approval && decided.has(s.approval.id) ? { ...s, approval: undefined } : s));

  // ---------------------------------------------------------------- rows

  async function act(key, label, fn) {
    if (busy.has(key)) return;
    busy.add(key);
    const my = gen;
    say(label + '…');
    paintBusy();
    try {
      const r = await fn();
      if (my !== gen) return;
      if (r.ok) say('');
      else { const m = 'Could not ' + label.toLowerCase() + ': ' + errText(r); notice(m, 'error'); say(m); }
    } catch (e) {
      if (e.message !== 'unauthorized' && my === gen) { const m = 'Could not ' + label.toLowerCase() + ': network error.'; notice(m, 'error'); say(m); }
    }
    busy.delete(key);
    if (my === gen) { paintBusy(); lastWin = null; await load(); }
  }

  // New Claude / New shell show a busy state (aria-disabled keeps them focusable) instead of silently ignoring clicks.
  function paintBusy() {
    for (const [kind, id, idle] of [['claude', 'win-new-claude', 'New Claude window'], ['shell', 'win-new-shell', 'New shell']]) {
      const b = $(id);
      const on = busy.has('new:' + kind);
      if (on) { b.setAttribute('aria-busy', 'true'); b.setAttribute('aria-disabled', 'true'); b.textContent = 'Starting…'; }
      else { b.removeAttribute('aria-busy'); b.removeAttribute('aria-disabled'); b.textContent = idle; }
    }
  }

  const newWindow = (kind) => act('new:' + kind, kind === 'claude' ? 'Starting a Claude window' : 'Starting a shell',
    () => api(base(), { method: 'POST', body: { kind } }));
  const selectWindow = (w) => act('select:' + w.id, 'Switching to ' + w.name, () => api(winPath(w.id, 'select'), { method: 'POST', body: {} }));
  function closeWindow(w) {
    // A Claude window ends its conversation, so ask first. Same native confirm as closing a conversation (controls.js).
    if (w.kind === 'claude' && !window.confirm('Close ' + (w.name || 'the Claude window') + '? Claude exits and the conversation stops.')) return;
    act('close:' + w.id, 'Closing ' + w.name, () => api(winPath(w.id, 'close'), { method: 'POST', body: {} }));
  }

  function liveChip() {
    const live = mine().filter((s) => !DEAD.has(s.status));
    return live.length === 1 && CONV[live[0].status] ? chip(CONV, live[0].status) : null;
  }

  function winRow(w, claudeCount) {
    const label = w.name || w.kind;
    const pick = h('button', { type: 'button', class: 'btn btn-ghost win-pick', 'data-fk': w.id + ':pick', 'aria-current': w.active ? 'true' : null }, [
      h('span', { class: 'win-name', text: label }),
      h('span', { class: 'win-kind', text: KIND[w.kind] || w.kind }),
    ]);
    const parts = [pick];
    if (w.kind === 'claude' && claudeCount === 1) { const c = liveChip(); if (c) parts.push(c); }
    const close = h('button', { type: 'button', class: 'btn win-close', 'data-fk': w.id + ':close', 'aria-label': 'Close ' + label, text: 'Close' });
    close.addEventListener('click', (ev) => { ev.stopPropagation(); closeWindow(w); });
    parts.push(close);
    const li = h('li', { class: 'win' + (w.active ? ' is-active' : ''), 'data-kind': w.kind, 'data-testid': 'window-row' }, parts);
    li.addEventListener('click', (ev) => { if (!ev.target.closest('.win-close')) selectWindow(w); });
    return li;
  }

  function renderWindows() {
    const ul = $('win-list');
    const act = document.activeElement;
    const inUl = ul.contains(act) && act.dataset;
    const focused = inUl ? act.dataset.fk : null;
    const idx = inUl ? [...ul.children].indexOf(act.closest('li')) : -1;
    const claudes = windows.filter((w) => w.kind === 'claude').length;
    ul.replaceChildren(...windows.map((w) => winRow(w, claudes)));
    $('win-empty').hidden = windows.length > 0;
    if (!focused) return;
    const again = ul.querySelector('[data-fk="' + CSS.escape(focused) + '"]');
    if (again) { again.focus(); return; }
    // The focused row went away: move to the next one, or to New Claude window when none is left.
    const next = ul.children[Math.min(Math.max(idx, 0), ul.children.length - 1)];
    const to = next && (next.querySelector('.win-close') || next.querySelector('button'));
    (to || $('win-new-claude')).focus();
  }

  // ---------------------------------------------------------------- conversations (stopped ones can be woken)

  async function wake(c, btn) {
    const name = c.sid.slice(0, 8);
    waking.add(c.sid);
    btn.setAttribute('aria-disabled', 'true'); btn.textContent = 'Waking…'; btn.setAttribute('aria-busy', 'true');
    say('Waking ' + name + '…');
    try {
      const r = await api('/api/conversations/' + encodeURIComponent(c.sid) + '/wake', { method: 'POST', body: {} });
      if (r.ok) { notice('Woke ' + name + '.', 'info'); say('Woke ' + name + '.'); }
      else { const m = 'Could not wake the conversation: ' + errText(r); notice(m, 'error'); say(m); }
    } catch (e) {
      if (e.message !== 'unauthorized') { notice('Could not wake the conversation.', 'error'); say('Could not wake the conversation.'); }
    }
    waking.delete(c.sid);
    renderConversations();
  }

  // One item per conversation: status, approval card, Wake (stopped), then prompt box / Interrupt / Close.
    function convRow(c) {
    const name = 'Conversation ' + c.sid.slice(0, 8);
    const cc = { ...c, win: name };
    const li = h('li', { class: 'node conv', 'data-testid': 'conversation', 'data-sid': c.sid, 'data-status': c.status, 'data-project': c.project || null }, [
      h('div', { class: 'row' }, [h('span', { class: 'conv-name', text: name }), CONV[c.status] ? chip(CONV, c.status) : h('span', { text: c.status })]),
    ]);
    if (c.approval) li.append(controls.approvalCard(cc, current));
    if (STOPPED.has(c.status)) {
      const note = h('p', { class: 'wake-note', id: 'wake-' + domId(c.sid), text: 'Resumes the full history. A step that was interrupted does not continue, and processes Claude started do not come back.' });
      const busyNow = waking.has(c.sid);
      const btn = h('button', { type: 'button', class: 'btn', 'data-testid': 'wake', 'data-fk': c.sid + ':wake', 'aria-describedby': note.id, 'aria-busy': busyNow ? 'true' : null, 'aria-disabled': busyNow ? 'true' : null, text: busyNow ? 'Waking…' : 'Wake' });
      btn.addEventListener('click', () => { if (!waking.has(c.sid)) wake(c, btn); });
      li.append(h('div', { class: 'wake' }, [btn, note]));
    }
    const box = controls.convControls(cc);
    if (box.length) li.append(h('div', { class: 'conv-controls' }, box));
    return li;
  }

  function renderConversations(focusKey, focusIdx) {
    const list = mine().filter((s) => CONV[s.status] && s.status !== 'gone');
    const box = $('conv-box');
    const ul = $('conv-list');
    const act = document.activeElement;
    const inUl = ul.contains(act) && act.dataset;
    const focused = focusKey || (inUl ? act.dataset.fk : null);
    const caret = inUl && !focusKey && act.selectionStart != null ? [act.selectionStart, act.selectionEnd] : null;
    controls.releasePreviews();
    box.hidden = list.length === 0;
    ul.replaceChildren(...list.map(convRow));
    if (focused) {
      const again = ul.querySelector('[data-fk="' + CSS.escape(focused) + '"]:not(:disabled)');
      if (again) { again.focus(); if (caret && again.setSelectionRange) try { again.setSelectionRange(caret[0], caret[1]); } catch { /* not a text control */ } return; }
    }
    if (focusIdx != null && focusIdx >= 0) {
      // The control that had focus was removed (approval answered, conversation closed): next item, else New Claude window.
      const li = ul.children[Math.min(focusIdx, ul.children.length - 1)];
      const to = li && li.querySelector('button:not(:disabled), input:not(:disabled)');
      (to || $('win-new-claude')).focus();
    }
  }

  // ---------------------------------------------------------------- approvals

  // Approval cards render inside their conversation item. Here: how many wait, shown on the (phone) panel toggle,
  // and a new one is announced politely; the panel is never forced open.
  function renderApprovals() {
    const items = mine().filter((s) => s.approval);
    const n = items.length;
    const toggle = $('tree-toggle');
    const text = n ? 'Windows, ' + n + (n === 1 ? ' needs approval' : ' need approval') : 'Windows';
    if (toggle.textContent !== text) toggle.textContent = text;
    const fresh = items.filter((s) => !seen.has(s.approval.id));
    seen.clear();
    for (const s of items) seen.add(s.approval.id);
    if (fresh.length) say(fresh.length === 1 ? 'Approval needed for ' + showTool(fresh[0]) + '.' : fresh.length + ' approvals need a decision.');
  }
  const seen = new Set();
  const showTool = (s) => 'Conversation ' + s.sid.slice(0, 8) + ' (' + String(s.approval.tool) + ')';

  function renderStates(focusKey, focusIdx) {
    const appr = JSON.stringify(mine().map((s) => [s.sid, s.approval && s.approval.id, s.approval && s.approval.truncated]));
    const conv = JSON.stringify(mine().map((s) => [s.sid, s.status, s.approval && s.approval.id, s.approval && s.approval.truncated]));
    if (appr !== lastAppr) { lastAppr = appr; renderApprovals(); }
    if (conv !== lastConv || focusKey || focusIdx != null) { lastConv = conv; renderConversations(focusKey, focusIdx); }
    // the single-conversation chip on a Claude row depends on state too
    if (windows.some((w) => w.kind === 'claude') && lastWin) renderWindows();
  }

  function setStates(next) {
    states = next;
    const ids = new Set(Object.values(next).map((s) => s.approval && s.approval.id));
    for (const id of decided) if (!ids.has(id)) decided.delete(id);
  }

  events.on('state', (msg) => {
    if (current == null || !msg.states || typeof msg.states !== 'object') return;
    setStates(msg.states);
    renderStates();
  });

  // ---------------------------------------------------------------- loading

  async function load() {
    if (current == null || loading) return;
    loading = true;
    const my = gen;
    const first = !loaded;
    if (first) { $('win-loading').hidden = false; $('win-error').hidden = true; $('win-empty').hidden = true; }
    try {
      const r = await api(base());
      if (my !== gen) return;
      if (!r.ok || !r.data || !Array.isArray(r.data.windows)) throw new Error('HTTP ' + r.status);
      $('win-error').hidden = true;
      $('win-loading').hidden = true;
      loading = false; loaded = true;
      const json = JSON.stringify(r.data.windows);
      if (json !== lastWin) { lastWin = json; windows = r.data.windows; renderWindows(); }
    } catch (e) {
      if (e.message !== 'unauthorized' && my === gen) { $('win-loading').hidden = true; $('win-error').hidden = false; }
    } finally { loading = false; }
  }

  document.addEventListener('visibilitychange', () => { if (current != null && !document.hidden) load(); });
  $('win-retry').addEventListener('click', () => { lastWin = null; load(); });
  $('win-new-claude').addEventListener('click', () => newWindow('claude'));
  $('win-new-shell').addEventListener('click', () => newWindow('shell'));
  controls.setOnChange((opts) => {
    if (opts && opts.decided) decided.add(opts.decided);
    lastAppr = null; lastConv = null;
    renderStates(opts && opts.focus, opts && opts.focusIdx);
  });

  window.ccdash.windows = {
    start(project) {
      current = project;
      gen += 1;
      windows = []; lastWin = null; lastConv = null; lastAppr = null; loading = false; loaded = false;
      states = {};
      busy.clear(); seen.clear(); decided.clear();
      $('tree-toggle').textContent = 'Windows';
      $('win-list').replaceChildren();
      $('conv-list').replaceChildren();
      $('conv-box').hidden = true;
      $('win-empty').hidden = true;
      $('win-error').hidden = true;
      $('win-loading').hidden = true;
      paintBusy();
      say('');
      const pushed = events.last('state');
      if (pushed && pushed.states) setStates(pushed.states);
      renderStates();
      load();
      clearInterval(poll);
      poll = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    },
    refresh() { lastWin = null; load(); },
    stop() {
      clearInterval(poll);
      poll = null;
      current = null;
      gen += 1;
    },
  };
})();
