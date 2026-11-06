'use strict';
// Project list screen and the "Add project" dialog.
(function () {
  const { api, h, notice, chip } = window.ccdash;
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
    const li = h('li', { class: 'card' }, [h('h3', { class: 'card-name', text: p.name }), meta, results, button]);
    const c = { li, chip: null, state: null, button, meta, head, pull, status, alert: failure, repo: null };
    button.addEventListener('click', () => openProject(p.name, button));
    pull.addEventListener('click', () => pullProject(p.name, c));
    return c;
  }

  function updateCard(c, p) {
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
    try {
      const r = await api('/api/projects/' + encodeURIComponent(name) + '/open', { method: 'POST' });
      if (!r.ok) throw new Error((r.data && r.data.error) || 'HTTP ' + r.status);
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
    c.status.replaceChildren();
    c.alert.replaceChildren();
    const show = (msg, log, isError) => {
      const kids = [h('p', { class: 'card-result-msg', text: msg })];
      if (log) {
        kids.push(h('details', {}, [
          h('summary', { text: 'Show log' }),
          h('pre', { tabindex: '0', 'aria-label': 'Pull log for ' + name, text: String(log) }),
        ]));
      }
      // Failures go to the alert region, results to the polite status region; the other one is cleared.
      const region = isError ? c.alert : c.status;
      (isError ? c.status : c.alert).replaceChildren();
      region.replaceChildren(...kids);
    };
    try {
      const r = await api('/api/projects/' + encodeURIComponent(name) + '/pull', { method: 'POST', body: {} });
      const d = r.data || {};
      if (!r.ok) {
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

  function openDialog() {
    lastOpener = document.activeElement;
    resetFeedback();
    loadDraft();
    updateCounter();
    dlg.showModal();
    $('add-repo').focus();
  }

  function closeDialog() {
    if (busy) return;
    $('add-token').value = '';
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
    setBusy(true);
    try {
      const r = await api('/api/projects', { method: 'POST', body });
      if (!r.ok) {
        const d = r.data || {};
        showError(d.error || 'Could not add project (HTTP ' + r.status + ').', d.log);
        if (r.status === 400 && /repo|owner/i.test(d.error || '')) markRepoInvalid(true);
        return;
      }
      const { project, warning } = r.data;
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
