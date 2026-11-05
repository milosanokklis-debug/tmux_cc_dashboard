'use strict';
// Agent tree panel: projects > conversations (tmux windows) > subagents.
(function () {
  const { api, h, poller, fmtDuration, chip, notice } = window.ccdash;
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
  const FLAGS = [['idle', 'idle'], ['quiet', 'quiet'], ['outsideTmux', 'outside tmux']];
  const AGENT = {
    running: { label: 'running', icon: '●' },
    done: { label: 'done', icon: '✓' },
  };

  let current = null; // project id of the open terminal
  let lastJson = null;
  let skew = 0; // server clock minus client clock, seconds
  let ticker = null;
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

  function agentItem(a, sid) {
    const running = a.status === 'running';
    const li = h('li', { class: 'node agent' }, [
      h('div', { class: 'row' }, [
        h('span', { class: 'agent-type', text: a.agent_type || 'agent' }),
        chip(AGENT, a.status),
        elapsed(a.startTs, a.endTs, running),
      ]),
    ]);
    if (a.task) {
      const key = sid + '/' + (a.agent_id || a.startTs);
      const open = expanded.has(key);
      const task = h('p', { class: 'agent-task' + (open ? ' is-open' : ''), id: 'task-' + domId(key), text: '“' + a.task + '”' });
      li.append(task);
      // Clamped to two lines; the button makes the full text reachable by keyboard and touch.
      // It starts hidden and fitTasks() reveals it only for text that is really cut off.
      const more = h('button', {
        type: 'button', class: 'btn btn-ghost task-more', 'aria-expanded': String(open), 'aria-controls': task.id,
        'data-key': key, hidden: !open, text: open ? 'Show less' : 'Show full task',
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

  async function wake(c, btn) {
    btn.disabled = true;
    try {
      const r = await api('/api/conversations/' + encodeURIComponent(c.sid) + '/wake', { method: 'POST', body: {} });
      if (r.ok) notice('Woke ' + (c.win || c.sid) + '.', 'info');
      else notice('Could not wake the conversation: ' + ((r.data && r.data.error) || 'HTTP ' + r.status), 'error');
    } catch (e) {
      if (e.message !== 'unauthorized') notice('Could not wake the conversation.', 'error');
    }
    btn.disabled = false;
    refresh();
  }

  function wakeControl(c) {
    const note = h('p', { class: 'wake-note', id: 'wake-' + domId(c.sid), text: 'Resumes the full history. A step that was interrupted does not continue, and processes Claude started do not come back.' });
    const btn = h('button', { type: 'button', class: 'btn', 'aria-describedby': note.id, text: 'Wake' });
    btn.addEventListener('click', () => wake(c, btn));
    return h('div', { class: 'wake' }, [btn, note]);
  }

  function convItem(c) {
    const running = c.status === 'running';
    const li = h('li', { class: 'node conv' }, [
      h('div', { class: 'row' }, [
        h('span', { class: 'conv-name', text: c.win || c.sid }),
        chip(CONV, c.status),
        elapsed(c.startedTs, c.endedTs, running),
      ]),
    ]);
    const flags = FLAGS.filter(([k]) => c[k]);
    if (flags.length) li.firstChild.insertBefore(h('span', { class: 'flags', text: flags.map((f) => f[1]).join(', ') }), li.firstChild.children[2]);
    if (c.wakeable) li.append(wakeControl(c));
    if (c.subagents.length) li.append(h('ul', { class: 'branch', 'aria-label': 'Subagents of ' + (c.win || c.sid) }, c.subagents.map((a) => agentItem(a, c.sid))));
    return li;
  }

  function render(data) {
    let projects = data.projects;
    const all = $('tree-all-projects').checked;
    if (!all && current) projects = projects.filter((p) => p.project === current);
    const ul = $('tree');
    // replaceChildren drops focus, so remember which task button had it and put it back.
    const focused = ul.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    ul.replaceChildren(
      ...projects.map((p) => {
        const isCurrent = p.project === current;
        const head = h('div', { class: 'project-head' }, [h('h3', { class: 'project-name', text: p.project })]);
        if (isCurrent && all) head.append(h('span', { class: 'here', text: 'this terminal' }));
        const li = h('li', { class: 'project' + (isCurrent ? ' is-current' : '') }, [head]);
        li.append(h('ul', { class: 'branch', 'aria-label': 'Conversations in ' + p.project }, p.conversations.map(convItem)));
        return li;
      })
    );
    fitTasks(); // before focusing: a still-hidden button cannot take focus
    if (focused) {
      const again = ul.querySelector('.task-more[data-key="' + CSS.escape(focused) + '"]');
      if (again) again.focus();
    }
    const empty = $('tree-empty');
    empty.hidden = projects.length > 0;
    if (!projects.length) {
      empty.textContent = $('tree-all-time').checked
        ? 'No Claude conversations recorded yet.'
        : 'No active Claude conversations. Start claude in the terminal and its subagents appear here.';
    }
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

  async function load() {
    const q = $('tree-all-time').checked ? '?all=1' : '';
    try {
      const r = await api('/api/tree' + q);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      $('tree-error').hidden = true;
      skew = r.data.now - Date.now() / 1000;
      // `now` changes every poll; the ticker keeps durations live, so only re-render on real changes.
      const json = JSON.stringify(r.data.projects);
      if (json !== lastJson) { lastJson = json; render(r.data); }
    } catch (e) {
      if (e.message !== 'unauthorized') $('tree-error').hidden = false;
    }
  }

  function tick() {
    if (document.hidden) return;
    const now = nowSec();
    for (const el of document.querySelectorAll('#tree .elapsed[data-start]')) {
      if (el.dataset.end) continue; // finished: fixed value
      const t = fmtDuration(now - Number(el.dataset.start));
      if (el.textContent !== t) el.textContent = t;
    }
  }

  const poll = poller(load, 2000);

  function refresh() { lastJson = null; poll.now(); }
  $('tree-all-projects').addEventListener('change', refresh);
  $('tree-all-time').addEventListener('change', refresh);

  window.ccdash.tree = {
    start(project) {
      current = project;
      lastJson = null;
      $('tree').replaceChildren();
      $('tree-empty').hidden = true;
      poll.start();
      clearInterval(ticker);
      ticker = setInterval(tick, 1000);
    },
    stop() {
      poll.stop();
      clearInterval(ticker);
      current = null;
    },
  };
})();
