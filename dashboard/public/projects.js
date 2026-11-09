'use strict';
// Project list screen and the "Add project" dialog.
(function () {
  const { api, h, notice, chip, accounts } = window.ccdash;
  const $ = (id) => document.getElementById(id);

  const STATES = {
    claude: { label: 'Claude running', icon: '●' },
    shell: { label: 'Shell only', icon: '◐' },
    none: { label: 'No session', icon: '○' },
  };

  const cards = new Map(); // name -> { li, chip, state, button }
  let known = []; // [{ name, state }] as last sent by the server
  let loaded = false;

  function makeCard(p) {
    const button = h('button', { type: 'button', class: 'btn card-open' });
    const head = h('span', { class: 'card-head' });
    const pull = h('button', { type: 'button', class: 'btn card-pull', text: 'Pull', 'aria-label': 'Pull ' + p.name });
    const meta = h('div', { class: 'card-meta' }, [head, pull]);
    // Two persistent live regions, both always in the DOM: a polite status for results, an alert for failures.
    // Polling never rebuilds them, so a message survives re-renders.
    const status = h('div', { class: 'card-result', role: 'status', 'aria-live': 'polite' });
    const failure = h('div', { class: 'card-result is-error', role: 'alert' });
    const results = h('div', { class: 'card-results' }, [status, failure]);
    // Kit line: on/off switch, version, memory chip, warning badge.
    const id = 'kit-' + p.name.replace(/[^A-Za-z0-9_-]/g, '_');
    const toggle = h('button', { type: 'button', role: 'switch', 'aria-checked': 'false', class: 'btn kit-toggle', id: id + '-toggle', 'data-testid': 'kit-toggle', 'aria-labelledby': id + '-toggle-text' });
    const toggleText = h('span', { class: 'kit-toggle-text', id: id + '-toggle-text', text: 'Agent kit for ' + p.name + ': off' });
    toggle.append(h('span', { class: 'kit-switch', 'aria-hidden': 'true' }), toggleText);
    const kitInfo = h('span', { class: 'card-kit-info' });
    const warning = h('span', { class: 'chip chip-kit-warn', 'data-testid': 'kit-warning', hidden: true });
    const kit = h('div', { class: 'card-kit' }, [toggle, kitInfo, warning]);
    // Account choice for Open: shown only when more than one account exists.
    const acctSelect = h('select', { id: id + '-account', 'data-testid': 'account-select-open' });
    const acct = h('label', { class: 'card-account', hidden: true }, [document.createTextNode('Account'), acctSelect]);
    acctSelect.addEventListener('change', () => accounts.setLast(p.name, acctSelect.value));
    const li = h('li', { class: 'card' }, [h('h3', { class: 'card-name', text: p.name }), meta, kit, results, acct, button]);
    const c = { li, acct, acctSelect, name: p.name, chip: null, state: null, button, meta, head, pull, status, alert: failure, repo: null, kit, toggle, toggleText, kitInfo, warning, memOffline: false, lastKit: undefined, kitBusy: false };
    button.addEventListener('click', () => openProject(p.name, button));
    syncAccount(c);
    pull.addEventListener('click', () => pullProject(p.name, c));
    toggle.addEventListener('click', () => toggleKit(p.name, c));
    return c;
  }

  function syncAccount(c) {
    c.acct.hidden = !accounts.multi();
    if (!accounts.multi()) return;
    const sel = c.acctSelect;
    // refill only when the list changed, and never under a select the user has open
    const same = sel.options.length === accounts.names().length && accounts.names().every((n, i) => sel.options[i].value === n);
    if (same || document.activeElement === sel) return;
    accounts.fill(sel, sel.options.length ? sel.value : accounts.last(c.name));
  }
  accounts.onChange(() => { for (const c of cards.values()) syncAccount(c); syncAddAccount(); });

  function updateCard(c, p) {
    syncAccount(c);
    if (c.state !== p.state) {
      const next = chip(STATES, p.state);
      if (c.chip) c.chip.replaceWith(next); else c.meta.before(next);
      c.chip = next;
      c.state = p.state;
    }
    const fresh = p.state === 'none';
    if (c.button.getAttribute('aria-busy') !== 'true') c.button.textContent = fresh ? 'Start session' : 'Open';
    c.button.setAttribute('aria-label', fresh
      ? 'Start session for ' + p.name
      : 'Open ' + p.name + ' (' + STATES[p.state].label + ')');
    c.repo = p.repo || null;
    const pulling = c.pull.getAttribute('aria-busy') === 'true';
    const headText = p.head ? 'head ' + p.head : '';
    // While a pull runs, or right after one, the pull response is fresher than a poll that began before it.
    if (!pulling && c.head.textContent !== headText && !(c.freshHead && Date.now() < c.freshHead.until && c.head.textContent === c.freshHead.text)) {
      c.head.textContent = headText;
    }
    c.head.hidden = !headText && !c.head.textContent;
    c.pull.setAttribute('aria-label', 'Pull latest for ' + p.name);
    c.meta.hidden = !(c.repo || c.head.textContent);
    c.pull.hidden = !c.repo;
    renderKit(c, p);
  }

  const MEMORY = {
    connected: { label: 'Memory connected', icon: '✓', cls: 'ok' },
    missing: { label: 'Memory missing', icon: '!', cls: 'warn' },
    unknown: { label: 'Memory unknown', icon: '?', cls: 'warn' },
    offline: { label: 'Memory offline', icon: '!', cls: 'warn' },
  };

  function renderKit(c, p) {
    c.lastKit = p;
    if (c.kitBusy) return; // the toggle response is fresher than a poll that began before it
    const on = !!p.kitEnabled;
    const kit = p.kit || null;
    const err = p.kitError || null;
    const sig = JSON.stringify([on, kit, err, c.memOffline]);
    if (c.kitSig === sig) return;
    c.kitSig = sig;
    c.toggle.setAttribute('aria-checked', on ? 'true' : 'false');
    c.toggleText.textContent = 'Agent kit for ' + c.name + (on ? ': on' : ': off');
    const kids = [];
    if (on) {
      kids.push(h('span', { class: 'kit-version', text: kit && kit.version ? 'kit ' + kit.version : 'kit pending' }));
      if (kit) {
        const m = c.memOffline ? MEMORY.offline : (MEMORY[kit.memory] || MEMORY.unknown);
        kids.push(h('span', { class: 'chip chip-mem-' + m.cls }, [
          h('span', { class: 'chip-icon', 'aria-hidden': 'true', text: m.icon }),
          h('span', { text: m.label }),
        ]));
      }
    }
    c.kitInfo.replaceChildren(...kids);
    c.warning.hidden = !err;
    if (err) {
      const msg = String(err.message || err.code || 'Kit problem');
      c.warning.replaceChildren(
        h('span', { class: 'chip-icon', 'aria-hidden': 'true', text: '!' }),
        h('span', { text: 'Kit warning: ' + msg }));
      c.warning.title = msg;
    } else c.warning.replaceChildren();
  }

  // Memory offline shows on the card's warning border and on its memory chip. Clearing re-renders the chip.
  function setMemoryOffline(c, on) {
    if (c.memOffline === on) return;
    c.memOffline = on;
    c.li.classList.toggle('is-memory-offline', on);
    if (c.lastKit !== undefined) { c.kitSig = null; renderKit(c, c.lastKit); }
  }

  // Shows a message (and optional log, in a collapsible pre) in the card's live regions.
  // Failures go to the alert region, results to the polite status region; the other is cleared.
  function showResult(c, msg, opts) {
    opts = opts || {};
    const kids = [];
    if (opts.title) kids.push(h('p', { class: 'card-result-title', text: opts.title }));
    kids.push(h('p', { class: 'card-result-msg', text: msg }));
    if (opts.log) {
      kids.push(h('details', { open: opts.open }, [
        h('summary', { text: opts.logLabel || 'Show log' }),
        h('div', { role: 'group', 'aria-label': opts.logName || 'Log' }, [h('pre', { tabindex: '0', text: String(opts.log) })]),
      ]));
    }
    const region = opts.error ? c.alert : c.status;
    (opts.error ? c.status : c.alert).replaceChildren();
    region.replaceChildren(...kids);
    setMemoryOffline(c, !!opts.offline);
  }

  // Clears the card's results. If focus was on a result (a Retry button), move it to `to` first so it does not fall to body.
  function clearResults(c, to) {
    const focused = document.activeElement;
    if (focused && (c.status.contains(focused) || c.alert.contains(focused)) && to) to.focus();
    c.status.replaceChildren();
    c.alert.replaceChildren();
    setMemoryOffline(c, false);
  }

  async function toggleKit(name, c) {
    if (c.kitBusy) return;
    const want = c.toggle.getAttribute('aria-checked') !== 'true';
    const was = !want;
    c.kitBusy = true;
    c.toggle.setAttribute('aria-disabled', 'true'); // aria-disabled keeps focus on the switch
    c.toggle.setAttribute('aria-busy', 'true');
    c.toggle.setAttribute('aria-checked', want ? 'true' : 'false');
    c.toggleText.textContent = (want ? 'Installing kit for ' : 'Removing kit for ') + c.name + '…';
    clearResults(c, c.toggle);
    let next = null;
    try {
      const r = await api('/api/projects/' + encodeURIComponent(name) + '/kit', { method: 'POST', body: { enabled: want } });
      const d = r.data || {};
      if (r.ok) {
        next = { kitEnabled: typeof d.kitEnabled === 'boolean' ? d.kitEnabled : want, kit: d.kit || null, kitError: d.kitError || null };
        if (d.message) showResult(c, d.message, {});
      } else if (d.error === 'kit-failed') {
        showResult(c, d.message || 'The kit failed (code ' + d.code + ').', { error: true, log: d.log, open: true, logName: 'Kit log for ' + name });
      } else if (d.error === 'memory-offline') {
        showMemoryOffline(c, d);
      } else {
        showResult(c, d.message || d.error || 'Could not change the agent kit (HTTP ' + r.status + ').', { error: true });
      }
    } catch (e) {
      if (e.message !== 'unauthorized') showResult(c, 'Network error: ' + e.message, { error: true });
    } finally {
      c.kitBusy = false;
      c.toggle.removeAttribute('aria-disabled');
      c.toggle.removeAttribute('aria-busy');
      c.kitSig = null;
      const base = c.lastKit || {};
      // On failure revert to what the server last said (the switch goes back to `was`).
      renderKit(c, next ? { ...base, ...next } : { ...base, kitEnabled: base.kitEnabled === undefined ? was : base.kitEnabled });
      if (active) load();
    }
  }

  function showMemoryOffline(c, d) {
    showResult(c, d.message || 'memory offline', {
      error: true, offline: true, title: 'Memory offline', log: d.output, open: true,
      logLabel: 'Show output', logName: 'Memory check output',
    });
  }

  function render(list) {
    known = list;
    const names = new Set(list.map((p) => p.name));
    for (const [name, c] of cards) {
      if (!names.has(name)) { c.li.remove(); cards.delete(name); }
    }
    const ul = $('project-list');
    list.forEach((p, i) => {
      let c = cards.get(p.name);
      if (!c) { c = makeCard(p); cards.set(p.name, c); }
      updateCard(c, p);
      // Only move nodes that are out of place so a focused button is not blurred.
      if (ul.children[i] !== c.li) ul.insertBefore(c.li, ul.children[i] || null);
    });
    $('projects-empty').hidden = list.length > 0;
    $('projects-loading').hidden = true;
    ul.hidden = list.length === 0;
  }

  async function load() {
    lastLoad = Date.now();
    clearTimeout(pending); pending = null; stale = false;
    try {
      const r = await api('/api/projects');
      if (!r.ok) throw new Error((r.data && r.data.error) || 'HTTP ' + r.status);
      render(r.data.projects);
      loaded = true;
      $('projects-error').hidden = true;
    } catch (e) {
      if (!loaded) $('projects-loading').hidden = true;
      $('projects-error').textContent = 'Could not load projects: ' + e.message + (loaded ? ' Showing the last known list.' : '');
      $('projects-error').hidden = false;
    }
  }

  // No timer. The list loads when the screen opens, after an action here, when the tab becomes visible
  // again, and when /events says conversations changed (a Claude start or exit changes a project's state).
  // Pushes are throttled to one request per 2 s. A hidden tab marks the list stale and reloads on return.
  const events = window.ccdash.events;
  let active = false;
  let stale = false;
  const sigs = {};
  let lastLoad = 0;
  let pending = null;
  let offs = [];

  function onPush(kind, next) {
    if (!active || sigs[kind] === next) return;
    const first = sigs[kind] === undefined; // the snapshot sent on connect: the list was just loaded
    sigs[kind] = next;
    if (first) return;
    if (document.hidden) { stale = true; return; }
    if (pending) return;
    pending = setTimeout(() => { pending = null; load(); }, Math.max(300, 2000 - (Date.now() - lastLoad)));
  }
  const treeSig = (msg) => JSON.stringify(((msg.tree && msg.tree.projects) || []).map((p) => [p.project, (p.conversations || []).map((c) => [c.sid, c.status])]));
  document.addEventListener('visibilitychange', () => { if (active && !document.hidden && stale) load(); });

  async function openProject(name, button) {
    const starting = known.some((k) => k.name === name && k.state === 'none');
    if (button.getAttribute('aria-busy') === 'true') return;
    // aria-disabled keeps focus on the button (a disabled control would drop it to body).
    button.setAttribute('aria-disabled', 'true');
    button.setAttribute('aria-busy', 'true');
    button.textContent = starting ? 'Starting…' : 'Opening…';
    const own = cards.get(name);
    if (own) clearResults(own, null);
    try {
      const sel = own && !own.acct.hidden ? own.acctSelect.value : null;
      const r = await api('/api/projects/' + encodeURIComponent(name) + '/open', { method: 'POST', body: sel ? { account: sel } : undefined });
      if (sel && r.ok) accounts.setLast(name, sel);
      const d = r.data || {};
      if (!r.ok && cards.has(name) && (d.error === 'memory-offline' || d.error === 'kit-failed')) {
        const c = cards.get(name);
        if (d.error === 'memory-offline') showMemoryOffline(c, d);
        else showResult(c, d.message || 'The kit failed.', { error: true, log: d.log, open: true, logName: 'Kit log for ' + name });
        c.alert.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
      window.ccdash.go(name);
    } catch (e) {
      if (e.message !== 'unauthorized') notice('Could not open ' + name + ': ' + e.message, 'error');
    } finally {
      button.removeAttribute('aria-disabled');
      button.removeAttribute('aria-busy');
      const p = known.find((k) => k.name === name);
      if (p && cards.has(name)) updateCard(cards.get(name), p);
    }
  }

  async function pullProject(name, c) {
    const btn = c.pull;
    if (btn.getAttribute('aria-busy') === 'true') return;
    // aria-disabled keeps focus on the button (a disabled control would drop it to body).
    btn.setAttribute('aria-disabled', 'true');
    btn.setAttribute('aria-busy', 'true');
    btn.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), document.createTextNode('Pulling…'));
    clearResults(c, null);
    const show = (msg, log, isError) => showResult(c, msg, { error: isError, log, logLabel: 'Show log', logName: 'Pull log for ' + name });
    try {
      const r = await api('/api/projects/' + encodeURIComponent(name) + '/pull', { method: 'POST', body: {} });
      const d = r.data || {};
      if (!r.ok && r.status === 409 && d.error === 'repo-has-hooks') {
        show('The new commits define hooks (' + (d.hooks || []).join(', ') + '); nothing was pulled. Use Add project with "I trust this repo’s hooks" if you trust it.', null, true);
      } else if (!r.ok) {
        show(d.error || 'Pull failed (HTTP ' + r.status + ').', d.log, true);
      } else {
        show(d.message || 'Pulled ' + name + '.', null, false);
        if (d.head) {
          c.head.textContent = 'head ' + d.head;
          c.head.hidden = false;
          c.meta.hidden = false;
          c.freshHead = { text: c.head.textContent, until: Date.now() + 10000 };
        }
        if (active) load();
      }
    } catch (e) {
      if (e.message !== 'unauthorized') show('Network error: ' + e.message, null, true);
    } finally {
      btn.removeAttribute('aria-disabled');
      btn.removeAttribute('aria-busy');
      btn.textContent = 'Pull';
    }
  }

  // ---- Add project dialog ----
  const dlg = $('add-dialog');
  const form = $('add-form');
  const fields = $('add-fields');
  let busy = false;
  let lastOpener = null;

  // Cancel and Escape keep what was typed (also across reloads, in this tab only).
  // The token is never stored: it is cleared whenever the dialog closes.
  const DRAFT = 'ccdash.add-draft';
  function saveDraft() {
    const repo = $('add-repo').value;
    const prompt = $('add-prompt').value;
    try {
      if (repo || prompt) sessionStorage.setItem(DRAFT, JSON.stringify({ repo, prompt }));
      else sessionStorage.removeItem(DRAFT);
    } catch { /* storage off */ }
  }
  function loadDraft() {
    try {
      const d = JSON.parse(sessionStorage.getItem(DRAFT) || 'null');
      if (d && typeof d.repo === 'string' && typeof d.prompt === 'string') {
        $('add-repo').value = d.repo.slice(0, 300);
        $('add-prompt').value = d.prompt.slice(0, 4000);
      }
    } catch { /* ignore a corrupt draft */ }
  }
  function clearDraft() { try { sessionStorage.removeItem(DRAFT); } catch { /* storage off */ } }

  function markRepoInvalid(on) {
    const repo = $('add-repo');
    if (on) {
      repo.setAttribute('aria-invalid', 'true');
      repo.setAttribute('aria-describedby', 'add-repo-hint add-error-msg');
    } else {
      repo.removeAttribute('aria-invalid');
      repo.setAttribute('aria-describedby', 'add-repo-hint');
    }
  }

  function resetFeedback() {
    markRepoInvalid(false);
    $('add-error').hidden = true;
    $('add-error-msg').textContent = '';
    $('add-error-log').textContent = '';
    $('add-error-log').hidden = true;
    $('add-progress').hidden = true;
  }

  // The repo defines hooks: say which events, and show the "I trust" box (needed to try again).
  function hooksRefused(d) {
    const list = (d.hooks || []).join(', ') || 'unknown events';
    showError('This repo defines hooks (' + list + '). Nothing was kept. Tick the "I trust this repo’s hooks" box above and add it again if you trust it.');
    $('add-trust-list').textContent = 'Hook events: ' + list + '.';
    $('add-trust-field').hidden = false;
    $('add-trust').focus();
  }

  function updateCounter() {
    $('add-prompt-count').textContent = $('add-prompt').value.length + ' / 4000';
  }

  function setBusy(on) {
    // Move focus to the progress status first: disabling the focused control would drop it to body.
    const progressHadFocus = document.activeElement === $('add-progress');
    if (on) { $('add-progress').hidden = false; $('add-progress').focus(); }
    busy = on;
    fields.disabled = on;
    $('add-submit').disabled = on;
    $('add-cancel').disabled = on;
    $('add-progress').hidden = !on;
    form.setAttribute('aria-busy', on ? 'true' : 'false');
    // Progress is hiding: give focus back to the first field rather than letting it fall to body.
    if (!on && progressHadFocus) $('add-repo').focus();
  }

  function syncAddAccount() {
    $('add-account-field').hidden = !accounts.multi();
    if (accounts.multi()) accounts.fill($('add-account'), $('add-account').value);
  }

  function openDialog() {
    lastOpener = document.activeElement;
    syncAddAccount();
    accounts.load();
    resetFeedback();
    loadDraft();
    updateCounter();
    dlg.showModal();
    $('add-repo').focus();
  }

  function closeDialog() {
    if (busy) return;
    $('add-token').value = '';
    $('add-trust').checked = false;
    $('add-trust-field').hidden = true;
    saveDraft();
    resetFeedback();
    if (dlg.open) dlg.close();
    if (lastOpener && lastOpener.isConnected) lastOpener.focus();
  }

  function showError(msg, log) {
    $('add-error-msg').textContent = msg;
    const pre = $('add-error-log');
    if (log) { pre.textContent = String(log); pre.hidden = false; }
    $('add-error').hidden = false;
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (busy) return;
    resetFeedback();
    const repo = $('add-repo').value.trim();
    if (!repo) { showError('Enter a repository (owner/repo or a GitHub URL).'); markRepoInvalid(true); $('add-repo').focus(); return; }
    const body = { repo };
    const token = $('add-token').value.trim();
    const prompt = $('add-prompt').value;
    if (token) body.token = token;
    if (prompt.trim()) body.prompt = prompt;
    if (!$('add-trust-field').hidden && $('add-trust').checked) body.trustHooks = true;
    body.kit = $('add-kit').checked;
    const acct = !$('add-account-field').hidden ? $('add-account').value : null;
    if (acct) body.account = acct;
    setBusy(true);
    try {
      const r = await api('/api/projects', { method: 'POST', body });
      if (!r.ok) {
        const d = r.data || {};
        if (r.status === 409 && d.error === 'repo-has-hooks') { hooksRefused(d); return; }
        if (r.status === 409 && (d.error === 'kit-failed' || d.error === 'memory-offline')) {
          showError(d.message || d.error, d.log || d.output);
          return;
        }
        showError(d.error || 'Could not add project (HTTP ' + r.status + ').', d.log);
        if (r.status === 400 && /repo|owner/i.test(d.error || '')) markRepoInvalid(true);
        return;
      }
      const { project, warning } = r.data;
      if (acct) accounts.setLast(project, acct);
      setBusy(false);
      form.reset(); // success: nothing to keep, and never keep the token around
      clearDraft();
      closeDialog();
      if (warning) notice(String(warning), 'info');
      if (active) load();
      window.ccdash.go(project);
    } catch (e) {
      if (e.message !== 'unauthorized') showError('Network error: ' + e.message);
    } finally {
      if (busy) setBusy(false);
    }
  });

  $('add-open').addEventListener('click', openDialog);
  $('add-cancel').addEventListener('click', closeDialog);
  $('add-prompt').addEventListener('input', () => { updateCounter(); saveDraft(); });
  $('add-repo').addEventListener('input', () => {
    $('add-trust').checked = false; // trust is for the repo that was refused, not for whatever is typed next
    $('add-trust-field').hidden = true;
    if ($('add-repo').getAttribute('aria-invalid') === 'true') resetFeedback();
    saveDraft();
  });
  dlg.addEventListener('cancel', (ev) => { if (busy) ev.preventDefault(); });
  dlg.addEventListener('close', () => { if (!busy) $('add-token').value = ''; });

  window.ccdash.projects = {
    start() {
      if (!loaded) $('projects-loading').hidden = false; // shown only when scripts run (see <noscript> in index.html)
      active = true;
      sigs.tree = sigs.state = undefined;
      load();
      for (const c of cards.values()) syncAccount(c);
      accounts.load();
      offs = [
        events.on('tree', (m) => onPush('tree', treeSig(m))),
        events.on('state', (m) => onPush('state', JSON.stringify(m.states || {}))),
      ];
    },
    stop() {
      active = false;
      clearTimeout(pending); pending = null;
      for (const off of offs) off();
      offs = [];
    },
    focusProject(name) { const c = cards.get(name); (c ? c.button : $('add-open')).focus(); },
  };
})();
