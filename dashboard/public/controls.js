'use strict';
// Per-conversation controls of the Windows panel: prompt box, interrupt, close (two-step), approval card, live pane preview.
// Everything from the server is rendered with textContent / createTextNode, never innerHTML.
(function () {
  const { api, h, notice } = window.ccdash;

  const MAX_PROMPT_BYTES = 8000;
  const LIVE = new Set(['working', 'needs_approval', 'waiting', 'error']);
  const enc = new TextEncoder();
  const domId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');
  const byteLen = (s) => enc.encode(s).length;
  // No byte count here: the live region only announces when the over-limit state changes, and the counter shows the number.
  const TOO_LONG = 'Prompt is too long. The limit is ' + MAX_PROMPT_BYTES + ' bytes. Shorten or split it.';
  const WHY_NO_PROMPT = {
    needs_approval: 'Answer the approval above first',
    working: 'Available when Claude is waiting for input',
    sleeping: 'Wake the conversation first',
    ended: 'Wake the conversation first',
    gone: 'Wake the conversation first',
  };
  const errText = (r) => (r.data && r.data.error) || 'HTTP ' + r.status;

  // State that must survive a re-render (the Windows panel rebuilds its DOM when the data changes).
  const drafts = new Map(); // sid -> prompt text being typed
  const closing = new Map(); // sid -> 'busy'
  const busyAction = new Set(); // 'sid:interrupt' | 'sid:send' | approval id
  const previewCache = new Map(); // sid -> raw text
  let onChange = () => {};

  // ---------------------------------------------------------------- ANSI preview

  const BASE = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
  const hex2 = (n) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0');
  // Colour spec: { v: 'var(--term-red)' } for 0-15, or a computed rgb string for 256/truecolor.
  function palette(n) {
    if (n < 16) return 'var(--term-' + (n < 8 ? '' : 'bright-') + BASE[n % 8] + ')';
    if (n < 232) {
      const i = n - 16;
      const lv = (x) => (x === 0 ? 0 : 55 + x * 40);
      return '#' + hex2(lv(Math.floor(i / 36))) + hex2(lv(Math.floor(i / 6) % 6)) + hex2(lv(i % 6));
    }
    const g = 8 + (n - 232) * 10;
    return '#' + hex2(g) + hex2(g) + hex2(g);
  }

  // Escape sequences: CSI (the only one we interpret is SGR, final byte m), OSC, charset selects, two-byte escapes.
  const ESC = /\u001b\[([0-?]*)[ -/]*([@-~])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[()*+][ -~]|\u001b[@-Z\\-_]/g;
  const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

  function applySgr(st, params) {
    const p = params === '' ? [0] : params.split(/[;:]/).map((x) => (x === '' ? 0 : Number(x)));
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === 0) { st.fg = null; st.bg = null; st.bold = false; st.dim = false; st.ul = false; st.rev = false; }
      else if (c === 1) st.bold = true;
      else if (c === 2) st.dim = true;
      else if (c === 4) st.ul = true;
      else if (c === 7) st.rev = true;
      else if (c === 22) { st.bold = false; st.dim = false; }
      else if (c === 24) st.ul = false;
      else if (c === 27) st.rev = false;
      else if (c >= 30 && c <= 37) st.fg = palette(c - 30);
      else if (c >= 90 && c <= 97) st.fg = palette(c - 90 + 8);
      else if (c >= 40 && c <= 47) st.bg = palette(c - 40);
      else if (c >= 100 && c <= 107) st.bg = palette(c - 100 + 8);
      else if (c === 39) st.fg = null;
      else if (c === 49) st.bg = null;
      else if (c === 38 || c === 48) {
        let col = null;
        if (p[i + 1] === 5 && Number.isFinite(p[i + 2])) { col = palette(Math.max(0, Math.min(255, p[i + 2]))); i += 2; }
        else if (p[i + 1] === 2 && p.length >= i + 5) { col = '#' + hex2(p[i + 2]) + hex2(p[i + 3]) + hex2(p[i + 4]); i += 4; }
        else break;
        if (c === 38) st.fg = col; else st.bg = col;
      }
    }
  }

  // Returns a DocumentFragment of text nodes and styled spans. Colours only ever come from the fixed
  // palette above or from numbers formatted as hex, so no server text reaches a style attribute.
  function ansiToNodes(text) {
    const frag = document.createDocumentFragment();
    const st = { fg: null, bg: null, bold: false, dim: false, ul: false, rev: false };
    function emit(chunk) {
      chunk = chunk.replace(/\r\n?/g, '\n').replace(CTRL, '');
      if (!chunk) return;
      if (!st.fg && !st.bg && !st.bold && !st.dim && !st.ul && !st.rev) { frag.append(document.createTextNode(chunk)); return; }
      const s = document.createElement('span');
      s.textContent = chunk;
      let fg = st.fg, bg = st.bg;
      if (st.rev) { fg = st.bg || 'var(--term-bg)'; bg = st.fg || 'var(--term-fg)'; }
      if (fg) s.style.color = fg;
      if (bg) s.style.backgroundColor = bg;
      if (st.bold) s.style.fontWeight = '700';
      if (st.dim) s.style.opacity = '.75';
      if (st.ul) s.style.textDecoration = 'underline';
      frag.append(s);
    }
    let last = 0;
    ESC.lastIndex = 0;
    let m;
    while ((m = ESC.exec(text))) {
      emit(text.slice(last, m.index));
      if (m[2] === 'm') applySgr(st, m[1] || '');
      last = ESC.lastIndex;
    }
    emit(text.slice(last).replace(/\u001b/g, ''));
    return frag;
  }

  function lastLines(text, n) {
    const lines = String(text).replace(/\s+$/, '').split('\n');
    return lines.slice(-n).join('\n');
  }

  // ---------------------------------------------------------------- previews (pushed over /events)

  // The IntersectionObserver tracks which preview boxes are on screen. The set of their conversation ids is
  // sent to the server as watch/unwatch; the server pushes {type:'preview'} when a pane's text changes.
  // Nothing here makes a request.
  const events = window.ccdash.events;
  const visible = new Map(); // element -> sid
  let syncTimer = null;
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      const sid = e.target.dataset.sid;
      if (e.isIntersecting) visible.set(e.target, sid); else visible.delete(e.target);
    }
    scheduleSync();
  }) : null;

  function syncWatch() {
    syncTimer = null;
    const ids = new Set();
    if (!document.hidden) for (const [el, sid] of visible) if (el.isConnected) ids.add(sid);
    events.setWatched(ids);
  }
  // Debounced: a panel re-render releases and re-observes every box; the unchanged set then sends nothing.
  function scheduleSync(now) {
    clearTimeout(syncTimer);
    if (now) syncWatch(); else syncTimer = setTimeout(syncWatch, 250);
  }
  document.addEventListener('visibilitychange', () => scheduleSync(true));

  function paint(el, text) {
    const stick = el.dataset.state !== 'ok' || el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    el.replaceChildren(ansiToNodes(lastLines(text, 10)));
    el.dataset.state = 'ok';
    if (stick) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }

  events.on('preview', (msg) => {
    if (typeof msg.id !== 'string' || typeof msg.text !== 'string') return;
    const same = previewCache.get(msg.id) === msg.text;
    previewCache.set(msg.id, msg.text);
    for (const el of document.querySelectorAll('pre.preview[data-sid]')) {
      if (el.dataset.sid === msg.id && (!same || el.dataset.state !== 'ok')) paint(el, msg.text);
    }
  });

  function previewBlock(c) {
    const pre = h('pre', {
      class: 'preview', tabindex: '0', role: 'region', 'data-testid': 'preview', 'data-sid': c.sid,
      'aria-label': 'Terminal preview of ' + (c.win || c.sid) + ' (read-only, last lines)',
    });
    if (previewCache.has(c.sid)) paint(pre, previewCache.get(c.sid));
    else {
      pre.textContent = 'Scroll to load preview';
      pre.dataset.state = 'loading';
    }
    if (io) io.observe(pre);
    else { visible.set(pre, c.sid); scheduleSync(); } // no observer: watch every box
    return pre;
  }

  // Called by the panel before it replaces its DOM.
  function releasePreviews() {
    for (const el of visible.keys()) io && io.unobserve(el);
    visible.clear();
    scheduleSync();
  }

  // ---------------------------------------------------------------- prompt box

  function promptBox(c) {
    const sid = c.sid;
    const id = 'prompt-' + domId(sid);
    const can = c.canPrompt != null ? !!c.canPrompt : c.status === 'waiting';
    const label = h('label', { for: id, class: 'ctl-label', text: 'Prompt' });
    const reason = h('p', { class: 'ctl-reason', id: id + '-reason', text: WHY_NO_PROMPT[c.status] || 'Available when the conversation is waiting' });
    const ta = h('textarea', {
      id, rows: '3', class: 'prompt-input', 'data-testid': 'prompt', 'data-fk': sid + ':prompt',
      autocomplete: 'off', autocapitalize: 'sentences', spellcheck: 'false', enterkeyhint: 'enter',
      placeholder: 'Message Claude, or start with / for a slash command such as /compact',
      'aria-describedby': id + '-count ' + id + '-error' + (can ? '' : ' ' + id + '-reason'),
    });
    if (!can) ta.disabled = true;
    ta.value = drafts.get(sid) || '';
    const count = h('span', { class: 'ctl-count', id: id + '-count' });
    const err = h('p', { class: 'ctl-error', id: id + '-error', 'aria-live': 'polite' });
    const send = h('button', { type: 'button', class: 'btn btn-primary', 'data-testid': 'send', 'data-fk': sid + ':send', text: 'Send' });
    const hint = h('span', { class: 'ctl-hint', text: 'Ctrl+Enter or Cmd+Enter sends' });
    const emptyWhy = h('p', { class: 'ctl-reason ctl-empty-why', id: id + '-empty', text: 'Type a message first' });
    let wasOver = false;

    function validate() {
      const n = byteLen(ta.value);
      count.textContent = n + ' / ' + MAX_PROMPT_BYTES + ' bytes';
      count.classList.toggle('is-over', n > MAX_PROMPT_BYTES);
      const over = n > MAX_PROMPT_BYTES;
      ta.setAttribute('aria-invalid', over ? 'true' : 'false');
      if (over !== wasOver) {
        wasOver = over;
        if (over) { err.dataset.kind = ''; err.textContent = TOO_LONG; }
        else if (err.dataset.kind !== 'server') err.textContent = '';
      }
      const empty = !ta.value.trim();
      send.disabled = !can || over || empty || busyAction.has(sid + ':send');
      const why = can && !over && empty && !busyAction.has(sid + ':send');
      emptyWhy.hidden = !why;
      if (why) send.setAttribute('aria-describedby', emptyWhy.id); else send.removeAttribute('aria-describedby');
      return !send.disabled;
    }

    async function submit() {
      if (!validate()) return;
      const text = ta.value;
      busyAction.add(sid + ':send');
      send.textContent = 'Sending…';
      ta.readOnly = true;
      validate();
      try {
        const r = await api('/api/conversations/' + encodeURIComponent(sid) + '/prompt', { method: 'POST', body: { text } });
        if (r.ok) {
          drafts.delete(sid);
          ta.value = '';
          err.dataset.kind = ''; err.textContent = '';
          notice('Sent to ' + (c.win || sid) + '.', 'info');
        } else {
          err.dataset.kind = 'server';
          err.textContent = errText(r);
          if (r.status !== 400 && r.status !== 413) notice('Could not send: ' + errText(r), 'error');
        }
      } catch (e) {
        if (e.message !== 'unauthorized') { err.dataset.kind = 'server'; err.textContent = 'Could not send: network error.'; notice('Could not send: network error.', 'error'); }
      }
      busyAction.delete(sid + ':send');
      send.textContent = 'Send';
      ta.readOnly = false;
      validate();
      onChange();
    }

    ta.addEventListener('input', () => {
      drafts.set(sid, ta.value);
      if (err.dataset.kind === 'server') { err.dataset.kind = ''; err.textContent = wasOver ? TOO_LONG : ''; }
      validate();
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
    });
    send.addEventListener('click', submit);
    validate();

    return h('div', { class: 'prompt' }, [
      label, ta,
      h('div', { class: 'prompt-bar' }, [count, hint]),
      err,
      can ? null : reason,
      h('div', { class: 'ctl-actions' }, [send, emptyWhy]),
    ].filter(Boolean));
  }

  // ---------------------------------------------------------------- interrupt / close

  function interruptButton(c) {
    const ok = c.status === 'working' || c.status === 'needs_approval';
    const key = c.sid + ':interrupt';
    const reasonId = 'int-' + domId(c.sid);
    const btn = h('button', {
      type: 'button', class: 'btn', 'data-testid': 'interrupt', 'data-fk': key, text: busyAction.has(key) ? 'Interrupting…' : 'Interrupt',
      'aria-describedby': ok ? null : reasonId,
    });
    btn.disabled = !ok || busyAction.has(key);
    btn.addEventListener('click', async () => {
      busyAction.add(key);
      btn.disabled = true; btn.textContent = 'Interrupting…';
      try {
        const r = await api('/api/conversations/' + encodeURIComponent(c.sid) + '/interrupt', { method: 'POST', body: {} });
        if (r.ok) notice('Interrupt sent to ' + (c.win || c.sid) + '.', 'info');
        else notice('Could not interrupt: ' + errText(r), 'error');
      } catch (e) { if (e.message !== 'unauthorized') notice('Could not interrupt: network error.', 'error'); }
      busyAction.delete(key);
      btn.textContent = 'Interrupt'; btn.disabled = false;
      onChange();
    });
    return { btn, reason: ok ? null : h('p', { class: 'ctl-reason', id: reasonId, text: 'Interrupt is available while the conversation is working or needs approval' }) };
  }

  const CLOSE_RESULT = {
    ended: 'Conversation ended.',
    killed: 'Claude did not exit within 10 s, so the pane was closed.',
    gone: 'The conversation was already gone.',
  };

  function closeControl(c) {
    const sid = c.sid;
    const live = LIVE.has(c.status);
    const busy = closing.get(sid) === 'busy';
    const panelId = 'close-' + domId(sid);
    const label = c.win || sid;
    const btn = h('button', {
      type: 'button', class: 'btn', 'data-testid': 'close', 'data-fk': sid + ':close', text: busy ? 'Closing…' : 'Close',
      'aria-label': 'Close ' + label, 'aria-describedby': live ? null : panelId + '-why',
      'aria-busy': busy ? 'true' : null,
    });
    btn.disabled = !live || busy;
    const out = { btn, why: live ? null : h('span', { class: 'sr-only', id: panelId + '-why', text: 'Only a running conversation can be closed' }), panel: null };
    if (busy) {
      out.panel = h('p', { class: 'ctl-progress', role: 'status' }, [h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { text: 'Closing… this can take up to 10 seconds.' })]);
    }
    btn.addEventListener('click', async () => {
      // Same native confirm as closing a window (windows.js): modal, keyboard and screen reader friendly.
      if (!window.confirm('Close ' + label + '? Asks Claude to exit; the pane closes after 10 s if it does not. A pending approval is dropped.')) return;
      const li = btn.closest('li');
      const idx = li && li.parentNode ? [...li.parentNode.children].indexOf(li) : -1;
      closing.set(sid, 'busy');
      onChange({ focus: sid + ':close' });
      try {
        const r = await api('/api/conversations/' + encodeURIComponent(sid) + '/close', { method: 'POST', body: {} });
        if (r.ok) notice(CLOSE_RESULT[r.data && r.data.result] || 'Closed.', 'info');
        else notice('Could not close: ' + errText(r), 'error');
      } catch (e) { if (e.message !== 'unauthorized') notice('Could not close: network error.', 'error'); }
      closing.delete(sid);
      onChange({ focusIdx: idx });
    });
    return out;
  }

  // ---------------------------------------------------------------- approval card

  // Bidi controls, zero-width characters and line/paragraph separators can make a command read
  // differently from what it is: show them as visible \uXXXX text.
  const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u2028\u2029]/g;
  const showInvisible = (t) => String(t).replace(INVISIBLE, (c) => '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));

  function fmtInput(input) {
    if (typeof input === 'string') return showInvisible(input);
    try { return showInvisible(JSON.stringify(input, null, 2)); } catch { return showInvisible(input); }
  }

  function approvalCard(c, project) {
    const a = c.approval;
    const id = 'appr-' + domId(a.id);
    const done = busyAction.has(a.id);
    const approve = h('button', { type: 'button', class: 'btn btn-primary', 'data-testid': 'approve', 'data-fk': a.id + ':approve', text: 'Approve', 'aria-describedby': id + '-tool' });
    const deny = h('button', { type: 'button', class: 'btn btn-danger', 'data-testid': 'deny', 'data-fk': a.id + ':deny', text: 'Deny', 'aria-describedby': id + '-tool' });
    const msgCount = h('span', { class: 'ctl-count', id: id + '-msg-count' });
    const msg = h('input', {
      'aria-describedby': id + '-msg-count',
      type: 'text', id: id + '-msg', class: 'appr-msg', maxlength: '500', autocomplete: 'off', 'data-testid': 'deny-message', 'data-fk': a.id + ':msg',
      placeholder: 'Tell Claude why (sent with Deny)',
    });
    msg.value = denyDrafts.get(a.id) || '';
    const countMsg = () => { msgCount.textContent = msg.value.length + ' / 500'; };
    countMsg();
    msg.addEventListener('input', () => { denyDrafts.set(a.id, msg.value); countMsg(); });
    const cut = !!a.truncated;
    approve.disabled = done || cut;
    deny.disabled = msg.disabled = done;
    if (cut) approve.setAttribute('aria-describedby', id + '-tool ' + id + '-why');
    const bashCommand = a.tool === 'Bash' && a.input && typeof a.input === 'object' && typeof a.input.command === 'string' ? a.input.command : null;
    const cmdPre = bashCommand === null ? null : h('pre', { class: 'appr-input appr-command', tabindex: '0', role: 'region', 'aria-label': 'Command', 'data-testid': 'approval-command', text: showInvisible(bashCommand) });
    const inputPre = h('pre', { class: 'appr-input', tabindex: '0', role: 'region', 'aria-label': 'Input for ' + showInvisible(a.tool), text: fmtInput(a.input) });
    const scrollHint = h('p', { class: 'appr-trunc', hidden: '', text: 'Scroll for more.' });
    requestAnimationFrame(() => {
      if ([inputPre, cmdPre].some((el) => el && el.scrollHeight > el.clientHeight + 1)) scrollHint.hidden = false;
    });

    async function decide(behavior) {
      let ok = false;
      const li = card.closest('li');
      const idx = li && li.parentNode ? [...li.parentNode.children].indexOf(li) : -1;
      busyAction.add(a.id);
      approve.disabled = deny.disabled = msg.disabled = true;
      const body = { behavior };
      if (behavior === 'deny' && msg.value.trim()) body.message = msg.value.trim().slice(0, 500);
      try {
        const r = await api('/api/approvals/' + encodeURIComponent(a.id) + '/decision', { method: 'POST', body });
        if (r.ok) {
          ok = true;
          card.remove();
          document.querySelectorAll('[data-approval-id="' + CSS.escape(a.id) + '"]').forEach((n) => n.remove());
          denyDrafts.delete(a.id);
          notice((behavior === 'allow' ? 'Approved ' : 'Denied ') + a.tool + ' for ' + (c.win || c.sid) + '.', 'info');
        } else {
          notice('Could not record the decision: ' + errText(r), 'error');
          busyAction.delete(a.id);
        }
      } catch (e) {
        if (e.message !== 'unauthorized') notice('Could not record the decision: network error.', 'error');
        busyAction.delete(a.id);
      }
      onChange(ok ? { decided: a.id, focusIdx: idx } : { decided: null });
    }
    approve.addEventListener('click', () => decide('allow'));
    deny.addEventListener('click', () => decide('deny'));

    const card = h('section', { class: 'approval', id, 'data-testid': 'approval-card', 'data-approval-id': a.id, 'aria-labelledby': id + '-t' }, [
      h('h4', { class: 'appr-title', id: id + '-t' }, [h('span', { class: 'chip-icon', 'aria-hidden': 'true', text: '!' }), h('span', { text: 'Approval needed' })]),
      h('dl', { class: 'appr-meta' }, [
        h('dt', { text: 'Project' }), h('dd', { text: project }),
        h('dt', { text: 'Conversation' }), h('dd', { text: c.win || c.sid }),
        h('dt', { text: 'Tool' }), h('dd', { class: 'appr-tool', id: id + '-tool', 'data-testid': 'approval-tool', text: showInvisible(a.tool) }),
      ]),
      cmdPre,
      // A Bash command is fully shown above; the raw JSON is one tap away. Other tools show their input directly.
      cmdPre ? h('details', { class: 'appr-raw' }, [h('summary', { text: 'Show raw input' }), inputPre]) : inputPre,
      scrollHint,
      a.truncated ? h('p', { class: 'appr-trunc', text: 'The input was cut short; what you see is only the start.' }) : null,
      cut ? h('p', { class: 'appr-trunc', id: id + '-why', text: 'Too long to review here. Deny, or answer in the terminal.' }) : null,
      h('div', { class: 'ctl-actions' }, [approve]),
      h('div', { class: 'appr-deny' }, [
        h('label', { for: id + '-msg', class: 'ctl-label', text: 'Deny message (optional)' }),
        h('div', { class: 'appr-deny-row' }, [msg, deny]),
        msgCount,
      ]),
    ].filter(Boolean));
    return card;
  }
  const denyDrafts = new Map();

  // ---------------------------------------------------------------- assembly

  // Controls block for a conversation card (everything below the header row).
  function convControls(c) {
    const interrupt = interruptButton(c);
    const close = closeControl(c);
    const els = [];
    const showPreview = c.status !== 'sleeping' && c.status !== 'ended' && c.status !== 'gone';
    const live = LIVE.has(c.status);
    if (showPreview) els.push(previewBlock(c));
    if (live || c.status === 'waiting') {
      els.push(promptBox(c));
      els.push(h('div', { class: 'ctl-actions ctl-row' }, [interrupt.btn, close.btn, interrupt.reason, close.why].filter(Boolean)));
      if (close.panel) els.push(close.panel);
    }
    return els;
  }

  function reset() { closing.clear(); }

  window.ccdash.controls = {
    convControls,
    approvalCard,
    releasePreviews,
    reset,
    ansiToNodes, // exposed for tests
    setOnChange(fn) { onChange = fn; },
  };
})();
