'use strict';
// Agent tree panel: projects > conversations (tmux windows) > subagents.
(function () {
  const { api, h, fmtDuration, fmtNum, chip, notice } = window.ccdash;
  const controls = window.ccdash.controls;
  const events = window.ccdash.events;
  const $ = (id) => document.getElementById(id);

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
  // Extra flags the reconciler sets next to the status.
  const FLAGS = [
    ['idle', 'idle', 'Idle: no activity for a while.'],
    ['quiet', 'quiet', 'Quiet: running, but it has not printed anything recently.'],
    ['outsideTmux', 'outside tmux', 'Outside tmux: Claude runs somewhere other than a tmux window here, so it cannot be prompted or closed from this page.'],
  ];
  const AGENT = {
    running: { label: 'running', icon: '●' },
    done: { label: 'done', icon: '✓' },
  };

  let current = null; // project id of the open terminal
  let lastJson = null;
  let lastData = null;
  let skew = 0; // server clock minus client clock, seconds
  let ticker = null;
  const waking = new Set(); // sids with a wake request in flight
  const seenApprovals = new Set(); // approval ids already counted for the auto-open
  const phone = window.matchMedia('(max-width: 720px)');
  const expanded = new Set(); // task rows the user opened, by conversation/agent id

  const nowSec = () => Date.now() / 1000 + skew;

  const domId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');

  // data-start/data-end drive the once-a-second tick; no end means "still running".
  function elapsed(start, end, live) {
    const span = h('span', { class: 'elapsed' });
    if (live || end != null) {
      span.dataset.start = String(start);
      if (!live) span.dataset.end = String(end);
      span.textContent = fmtDuration((live ? nowSec() : end) - start);
    }
    return span;
  }

  // Model and in/out token totals under a node's header row. Null tokens (transcript not read yet) show nothing.
  function metaLine(n) {
    const bits = [];
    if (n.model) bits.push(h('span', { class: 'meta-model', 'data-testid': 'node-model', text: n.model }));
    const t = n.tokens;
    if (t && typeof t === 'object') {
      bits.push(h('span', { class: 'meta-tokens', 'data-testid': 'node-tokens', title: 'Input and output tokens', 'aria-label': 'Tokens: ' + fmtNum(t.input) + ' in, ' + fmtNum(t.output) + ' out' }, [
        h('span', { 'aria-hidden': 'true', text: 'in ' + fmtNum(t.input) + ' · out ' + fmtNum(t.output) }),
      ]));
    }
    return bits.length ? h('div', { class: 'meta-line' }, bits) : null;
  }

  function agentItem(a, sid) {
    const running = a.status === 'running';
    const label = a.agent_type || 'agent';
    const canOpen = !!(a.transcript && a.transcript.conv && a.transcript.agent);
    const open = canOpen
      ? h('button', {
        type: 'button', class: 'btn btn-ghost agent-open', 'data-testid': 'agent-open', 'data-fk': sid + '/' + (a.agent_id || a.startTs) + ':open',
        'aria-haspopup': 'dialog', 'aria-label': 'Open transcript of ' + label + ' agent', title: 'Read-only transcript',
        text: label,
      })
      : h('span', { class: 'agent-type', text: label });
    if (canOpen) {
      open.addEventListener('click', () => window.ccdash.transcript.open({ conv: a.transcript.conv, agent: a.transcript.agent, title: label, opener: open }));
    }
    const li = h('li', { class: 'node agent', 'data-testid': 'tree-node', 'data-kind': 'agent' }, [
      h('div', { class: 'row' }, [open, chip(AGENT, a.status), elapsed(a.startTs, a.endTs, running)]),
      metaLine(a),
    ].filter(Boolean));
    if (a.task) {
      const key = sid + '/' + (a.agent_id || a.startTs);
      const open = expanded.has(key);
      const task = h('p', { class: 'agent-task' + (open ? ' is-open' : ''), id: 'task-' + domId(key), text: '“' + a.task + '”' });
      li.append(task);
      // Clamped to two lines; the button makes the full text reachable by keyboard and touch.
      // It starts hidden and fitTasks() reveals it only for text that is really cut off.
      const more = h('button', {
        type: 'button', class: 'btn btn-ghost task-more', 'aria-expanded': String(open), 'aria-controls': task.id,
        'data-key': key, 'data-fk': key, hidden: !open, text: open ? 'Show less' : 'Show full task',
      });
      more.addEventListener('click', () => {
        const now = more.getAttribute('aria-expanded') !== 'true';
        if (now) expanded.add(key); else expanded.delete(key);
        more.setAttribute('aria-expanded', String(now));
        more.textContent = now ? 'Show less' : 'Show full task';
        task.classList.toggle('is-open', now);
      });
      li.append(more);
    }
    return li;
  }

  // A persistent live region (the tree re-renders, so a status inside a card would be lost).
  function say(text) { const el = $('tree-status'); if (el) el.textContent = text; }

  async function wake(c, btn) {
    const name = c.win || c.sid;
    waking.add(c.sid);
    btn.disabled = true; btn.textContent = 'Waking…'; btn.setAttribute('aria-busy', 'true');
    say('Waking ' + name + '…');
    try {
      const r = await api('/api/conversations/' + encodeURIComponent(c.sid) + '/wake', { method: 'POST', body: {} });
      if (r.ok) { notice('Woke ' + name + '.', 'info'); say('Woke ' + name + '.'); }
      else {
        const m = 'Could not wake the conversation: ' + ((r.data && r.data.error) || 'HTTP ' + r.status);
        notice(m, 'error'); say(m);
      }
    } catch (e) {
      if (e.message !== 'unauthorized') { notice('Could not wake the conversation.', 'error'); say('Could not wake the conversation.'); }
    }
    waking.delete(c.sid);
    btn.disabled = false; btn.textContent = 'Wake'; btn.removeAttribute('aria-busy');
    refresh();
  }

  function wakeControl(c) {
    const note = h('p', { class: 'wake-note', id: 'wake-' + domId(c.sid), text: 'Resumes the full history. A step that was interrupted does not continue, and processes Claude started do not come back.' });
    const busy = waking.has(c.sid);
    const btn = h('button', { type: 'button', class: 'btn', 'aria-describedby': note.id, 'aria-busy': busy ? 'true' : null, text: busy ? 'Waking…' : 'Wake' });
    btn.disabled = busy;
    btn.addEventListener('click', () => wake(c, btn));
    return h('div', { class: 'wake' }, [btn, note]);
  }

  function convItem(c, project) {
    const running = c.endedTs == null && !['sleeping', 'ended', 'gone'].includes(c.status);
    const li = h('li', { class: 'node conv', 'data-testid': 'tree-node', 'data-kind': 'conversation', 'data-sid': c.sid }, [
      h('div', { class: 'row' }, [
        h('span', { class: 'conv-name', text: c.win || c.sid }),
        chip(CONV, c.status),
        elapsed(c.startedTs, c.endedTs, running),
      ]),
      metaLine(c),
    ].filter(Boolean));
    const flags = FLAGS.filter(([k]) => c[k]);
    if (flags.length) {
      const box = h('span', { class: 'flags' }, flags.map((f) => h('span', { class: 'flag', title: f[2], text: f[1] })));
      li.firstChild.insertBefore(box, li.firstChild.children[2]);
    }
    if (c.approval) li.append(controls.approvalCard(c, project));
    if (c.wakeable) li.append(wakeControl(c));
    const box = controls.convControls(c);
    if (box.length) li.append(h('div', { class: 'conv-controls' }, box));
    if (c.subagents.length) li.append(h('ul', { class: 'branch', 'aria-label': 'Subagents of ' + (c.win || c.sid) }, c.subagents.map((a) => agentItem(a, c.sid))));
    return li;
  }

  function render(data, focusKey) {
    lastData = data;
    let projects = data.projects;
    const all = $('tree-all-projects').checked;
    if (!all && current) projects = projects.filter((p) => p.project === current);
    const ul = $('tree');
    // replaceChildren drops focus, so remember which task button had it and put it back.
    const act = document.activeElement;
    const focused = focusKey || (ul.contains(act) && act.dataset ? (act.dataset.fk || act.dataset.key) : null);
    const caret = ul.contains(act) && act.selectionStart != null && !focusKey ? [act.selectionStart, act.selectionEnd] : null;
    controls.releasePreviews();
    renderStrip(data);
    ul.replaceChildren(
      ...projects.map((p) => {
        const isCurrent = p.project === current;
        const head = h('div', { class: 'project-head' }, [h('h3', { class: 'project-name', text: p.project })]);
        if (isCurrent && all) head.append(h('span', { class: 'here', text: 'this terminal' }));
        const li = h('li', { class: 'project' + (isCurrent ? ' is-current' : '') }, [head]);
        li.append(h('ul', { class: 'branch', 'aria-label': 'Conversations in ' + p.project }, p.conversations.map((c) => convItem(c, p.project))));
        return li;
      })
    );
    fitTasks(); // before focusing: a still-hidden button cannot take focus
    if (focused) {
      const q = CSS.escape(focused);
      const again = ul.querySelector('[data-fk="' + q + '"]:not(:disabled)') || ul.querySelector('.task-more[data-key="' + q + '"]');
      if (again) {
        again.focus();
        if (caret && again.setSelectionRange) try { again.setSelectionRange(caret[0], caret[1]); } catch { /* not a text control */ }
      }
    }
    const empty = $('tree-empty');
    empty.hidden = projects.length > 0;
    if (!projects.length) {
      empty.textContent = $('tree-all-time').checked
        ? 'No Claude conversations recorded yet.'
        : 'No active Claude conversations. Start claude in the terminal and its subagents appear here.';
    }
  }

  // "Needs approval" strip: every pending approval in the data, even for projects the filter hides.
  function renderStrip(data) {
    const items = [];
    for (const p of data.projects) for (const c of p.conversations) if (c.approval) items.push({ project: p.project, c });
    syncApprovalToggle(items);
    const box = $('approvals');
    const strip = controls.approvalStrip(items, jumpTo);
    const focused = box.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
    box.replaceChildren(...(strip ? [strip] : []));
    if (focused) { const again = box.querySelector('[data-fk="' + CSS.escape(focused) + '"]'); if (again) again.focus(); }
  }

  // Phones: the panel starts collapsed, so surface pending approvals on the Agents toggle and open the
  // panel once per approval. A user who collapses it again while that approval is pending is left alone.
  function syncApprovalToggle(items) {
    const n = items.length;
    const toggle = $('tree-toggle');
    const text = n ? 'Agents, ' + n + ' needs approval' : 'Agents';
    if (toggle.textContent !== text) toggle.textContent = text;
    const ids = new Set(items.map((it) => it.c.approval.id));
    let fresh = false;
    for (const id of ids) if (!seenApprovals.has(id)) { seenApprovals.add(id); fresh = true; }
    for (const id of seenApprovals) if (!ids.has(id)) seenApprovals.delete(id);
    if (fresh && phone.matches && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
  }

  function jumpTo(id) {
    const find = () => $('tree').querySelector('[data-approval-id="' + CSS.escape(id) + '"]');
    let card = find();
    if (!card && lastData) {
      $('tree-all-projects').checked = true;
      render(lastData);
      card = find();
    }
    if (!card) return;
    card.scrollIntoView({ block: 'nearest' });
    const btn = card.querySelector('[data-testid="approve"]');
    const target = btn && !btn.disabled ? btn : card.querySelector('[data-testid="deny"]');
    if (target && !target.disabled) target.focus();
  }

  // Show 'Show full task' only where the two-line clamp hides text. Open tasks keep their button
  // ('Show less'). A hidden panel has no layout (height 0), so skip it; the observer re-runs when it opens.
  function fitTasks() {
    for (const more of document.querySelectorAll('#tree .task-more')) {
      const task = more.previousElementSibling;
      if (task.classList.contains('is-open')) { more.hidden = false; continue; }
      if (task.clientHeight) more.hidden = task.scrollHeight <= task.clientHeight;
    }
  }
  new ResizeObserver(fitTasks).observe($('tree-body'));

  // Push path: the server sends the same body as GET /api/tree (without ?all=1).
  function apply(data) {
    if (!data || !Array.isArray(data.projects)) return;
    $('tree-error').hidden = true;
    skew = data.now - Date.now() / 1000;
    // `now` changes with every push; the ticker keeps durations live, so only re-render on real changes.
    const json = JSON.stringify(data.projects);
    if (json !== lastJson) { lastJson = json; render(data); }
  }

  // One request, only on a user action or for "Show ended / older than 24h" (which the socket does not carry).
  async function load() {
    const q = $('tree-all-time').checked ? '?all=1' : '';
    try {
      const r = await api('/api/tree' + q);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      apply(r.data);
    } catch (e) {
      if (e.message !== 'unauthorized') $('tree-error').hidden = false;
    }
  }

  events.on('tree', (msg) => {
    if (current == null || $('tree-all-time').checked) return; // all-time data is fetched, not pushed
    apply(msg.tree);
  });

  function tick() {
    if (document.hidden) return;
    const now = nowSec();
    for (const el of document.querySelectorAll('#tree .elapsed[data-start]')) {
      if (el.dataset.end) continue; // finished: fixed value
      const t = fmtDuration(now - Number(el.dataset.start));
      if (el.textContent !== t) el.textContent = t;
    }
  }

  function refresh() { lastJson = null; if (current != null) load(); }
  controls.setOnChange((opts) => {
    if (opts && opts.focus && lastData) render(lastData, opts.focus);
    else { if (lastData) render(lastData); refresh(); }
  });
  $('tree-all-projects').addEventListener('change', () => { if (lastData) render(lastData); });
  $('tree-all-time').addEventListener('change', refresh);

  window.ccdash.tree = {
    start(project) {
      current = project;
      lastJson = null;
      seenApprovals.clear();
      $('tree-toggle').textContent = 'Agents';
      $('tree').replaceChildren();
      $('approvals').replaceChildren();
      controls.releasePreviews();
      controls.reset();
      $('tree-empty').hidden = true;
      const pushed = events.last('tree');
      if (pushed && !$('tree-all-time').checked) apply(pushed.tree); else if (!events.connected()) load();
      clearInterval(ticker);
      ticker = setInterval(tick, 1000);
    },
    stop() {
      controls.releasePreviews();
      clearInterval(ticker);
      current = null;
    },
  };
})();
