'use strict';
// Project list screen and the "Add project" dialog.
(function () {
  const { api, h, poller, notice, chip } = window.ccdash;
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
    const li = h('li', { class: 'card' }, [h('h3', { class: 'card-name', text: p.name }), button]);
    button.addEventListener('click', () => openProject(p.name, button));
    return { li, chip: null, state: null, button };
  }

  function updateCard(c, p) {
    if (c.state !== p.state) {
      const next = chip(STATES, p.state);
      if (c.chip) c.chip.replaceWith(next); else c.button.before(next);
      c.chip = next;
      c.state = p.state;
    }
    const fresh = p.state === 'none';
    if (c.button.getAttribute('aria-busy') !== 'true') c.button.textContent = fresh ? 'Start session' : 'Open';
    c.button.setAttribute('aria-label', fresh
      ? 'Start session for ' + p.name
      : 'Open ' + p.name + ' (' + STATES[p.state].label + ')');
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

  const poll = poller(load, 3000);

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
      poll.now();
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
      poll.start();
    },
    stop() { poll.stop(); },
    focusProject(name) { const c = cards.get(name); (c ? c.button : $('add-open')).focus(); },
  };
})();
