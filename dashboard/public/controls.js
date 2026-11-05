'use strict';
// Per-conversation controls: prompt box, interrupt, close (two-step), approval card, live pane preview.
// Everything from the server is rendered with textContent / createTextNode, never innerHTML.
(function () {
  const { api, h, notice } = window.ccdash;

  const MAX_PROMPT_BYTES = 8000;
  const LIVE = new Set(['working', 'needs_approval', 'waiting', 'error']);
  const enc = new TextEncoder();
  const domId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');
  const byteLen = (s) => enc.encode(s).length;
  const tooLong = (n) => 'Prompt is too long: ' + n + ' bytes, the limit is ' + MAX_PROMPT_BYTES + '. Shorten or split it.';
  const errText = (r) => (r.data && r.data.error) || 'HTTP ' + r.status;

  // State that must survive a tree re-render (the tree rebuilds its DOM when the data changes).
  const drafts = new Map(); // sid -> prompt text being typed
  const closing = new Map(); // sid -> 'confirm' | 'busy'
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

  // ---------------------------------------------------------------- preview refresh (visible cards only)

  const visible = new Map(); // element -> sid
  const inflight = new Set();
  let timer = null;
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      const sid = e.target.dataset.sid;
      if (e.isIntersecting) visible.set(e.target, sid); else visible.delete(e.target);
    }
    syncTimer(true);
  }) : null;

  function paint(el, text) {
    const stick = el.dataset.state !== 'ok' || el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    el.replaceChildren(ansiToNodes(lastLines(text, 10)));
    el.dataset.state = 'ok';
    if (stick) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }

  async function fetchPreview(el, sid) {
    if (inflight.has(sid)) return;
    inflight.add(sid);
    try {
      const r = await api('/api/conversations/' + encodeURIComponent(sid) + '/preview');
      if (!el.isConnected) return;
      if (r.ok && r.data && typeof r.data.text === 'string') {
        if (previewCache.get(sid) !== r.data.text || el.dataset.state !== 'ok') {
          previewCache.set(sid, r.data.text);
          paint(el, r.data.text);
        }
      } else if (el.dataset.state !== 'ok') {
        el.textContent = 'Preview unavailable.';
        el.dataset.state = 'none';
      }
    } catch { /* offline or signed out: keep the last preview */ } finally { inflight.delete(sid); }
  }

  function pump() {
    if (document.hidden) return;
    for (const [el, sid] of visible) {
      if (!el.isConnected) { visible.delete(el); io && io.unobserve(el); continue; }
      fetchPreview(el, sid);
    }
  }

  function syncTimer(immediate) {
    if (visible.size && !document.hidden) {
      if (!timer) timer = setInterval(pump, 3000);
      if (immediate) pump();
    } else if (timer) { clearInterval(timer); timer = null; }
  }
  document.addEventListener('visibilitychange', () => syncTimer(true));

  function previewBlock(c) {
    const pre = h('pre', {
      class: 'preview', tabindex: '0', 'data-testid': 'preview', 'data-sid': c.sid,
      'aria-label': 'Terminal preview of ' + (c.win || c.sid) + ' (read-only, last lines)',
    });
    if (previewCache.has(c.sid)) paint(pre, previewCache.get(c.sid));
    else { pre.textContent = 'Loading preview…'; pre.dataset.state = 'loading'; }
    if (io) io.observe(pre);
    return pre;
  }

  // Called by the tree before it replaces its DOM.
  function releasePreviews() {
    for (const el of visible.keys()) io && io.unobserve(el);
    visible.clear();
    syncTimer(false);
  }

  // ---------------------------------------------------------------- prompt box

  function promptBox(c) {
    const sid = c.sid;
    const id = 'prompt-' + domId(sid);
    const can = !!c.canPrompt;
    const label = h('label', { for: id, class: 'ctl-label', text: 'Prompt' });
    const reason = h('p', { class: 'ctl-reason', id: id + '-reason', text: 'Available when the conversation is waiting' });
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

    function validate() {
      const n = byteLen(ta.value);
      count.textContent = n + ' / ' + MAX_PROMPT_BYTES + ' bytes';
      count.classList.toggle('is-over', n > MAX_PROMPT_BYTES);
      const over = n > MAX_PROMPT_BYTES;
      ta.setAttribute('aria-invalid', over ? 'true' : 'false');
      if (over) err.textContent = tooLong(n);
      else if (err.dataset.kind !== 'server') err.textContent = '';
      send.disabled = !can || over || !ta.value.trim() || busyAction.has(sid + ':send');
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
      err.dataset.kind = '';
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
      h('div', { class: 'ctl-actions' }, [send]),
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
    const state = closing.get(sid) || null;
    const panelId = 'close-' + domId(sid);
    const btn = h('button', {
      type: 'button', class: 'btn', 'data-testid': 'close', 'data-fk': sid + ':close', text: 'Close',
      'aria-expanded': live ? String(!!state) : null, 'aria-controls': live ? panelId : null,
      'aria-describedby': live ? null : panelId + '-why',
    });
    btn.disabled = !live || state === 'busy';
    const out = { btn, why: live ? null : h('span', { class: 'sr-only', id: panelId + '-why', text: 'Only a running conversation can be closed' }), panel: null };
    if (!state) {
      btn.addEventListener('click', () => { closing.set(sid, 'confirm'); onChange({ focus: sid + ':close-cancel' }); });
      return out;
    }
    const confirm = h('button', { type: 'button', class: 'btn btn-danger', 'data-testid': 'close-confirm', 'data-fk': sid + ':close-confirm', text: state === 'busy' ? 'Closing…' : 'Close conversation' });
    const cancel = h('button', { type: 'button', class: 'btn', 'data-fk': sid + ':close-cancel', text: 'Cancel' });
    confirm.disabled = state === 'busy';
    cancel.disabled = state === 'busy';
    const panel = h('div', { class: 'confirm', id: panelId, role: 'group', 'aria-labelledby': panelId + '-t', 'aria-describedby': panelId + '-d' }, [
      h('p', { class: 'confirm-title', id: panelId + '-t', text: 'Close ' + (c.win || sid) + '?' }),
      h('p', { class: 'confirm-desc', id: panelId + '-d', text: 'Asks Claude to exit; the pane is closed after 10 s if it does not' }),
      state === 'busy' ? h('p', { class: 'ctl-progress', role: 'status' }, [h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { text: 'Closing… this can take up to 10 seconds.' })]) : null,
      h('div', { class: 'ctl-actions' }, [confirm, cancel]),
    ].filter(Boolean));
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && closing.get(sid) === 'confirm') {
        e.preventDefault(); e.stopPropagation();
        closing.delete(sid);
        onChange({ focus: sid + ':close' });
      }
    });
    cancel.addEventListener('click', () => { closing.delete(sid); onChange({ focus: sid + ':close' }); });
    confirm.addEventListener('click', async () => {
      closing.set(sid, 'busy');
      onChange({ focus: sid + ':close-confirm' });
      try {
        const r = await api('/api/conversations/' + encodeURIComponent(sid) + '/close', { method: 'POST', body: {} });
        if (r.ok) notice(CLOSE_RESULT[r.data && r.data.result] || 'Closed.', 'info');
        else notice('Could not close: ' + errText(r), 'error');
      } catch (e) { if (e.message !== 'unauthorized') notice('Could not close: network error.', 'error'); }
      closing.delete(sid);
      onChange();
    });
    out.panel = panel;
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
    const approve = h('button', { type: 'button', class: 'btn btn-primary', 'data-testid': 'approve', 'data-fk': a.id + ':approve', text: 'Approve' });
    const deny = h('button', { type: 'button', class: 'btn btn-danger', 'data-testid': 'deny', 'data-fk': a.id + ':deny', text: 'Deny' });
    const msg = h('input', {
      type: 'text', id: id + '-msg', class: 'appr-msg', maxlength: '500', autocomplete: 'off', 'data-testid': 'deny-message', 'data-fk': a.id + ':msg',
      placeholder: 'Tell Claude why (sent with Deny)',
    });
    msg.value = denyDrafts.get(a.id) || '';
    msg.addEventListener('input', () => denyDrafts.set(a.id, msg.value));
    approve.disabled = deny.disabled = msg.disabled = done;
    const bashCommand = a.tool === 'Bash' && a.input && typeof a.input === 'object' && typeof a.input.command === 'string' ? a.input.command : null;
    const cmdPre = bashCommand === null ? null : h('pre', { class: 'appr-input appr-command', tabindex: '0', 'aria-label': 'Command', 'data-testid': 'approval-command', text: showInvisible(bashCommand) });
    const inputPre = h('pre', { class: 'appr-input', tabindex: '0', 'aria-label': 'Input for ' + showInvisible(a.tool), text: fmtInput(a.input) });
    const scrollHint = h('p', { class: 'appr-trunc', hidden: '', text: 'Scroll for more.' });
    requestAnimationFrame(() => {
      if ([inputPre, cmdPre].some((el) => el && el.scrollHeight > el.clientHeight + 1)) scrollHint.hidden = false;
    });

    async function decide(behavior) {
      busyAction.add(a.id);
      approve.disabled = deny.disabled = msg.disabled = true;
      const body = { behavior };
      if (behavior === 'deny' && msg.value.trim()) body.message = msg.value.trim().slice(0, 500);
      try {
        const r = await api('/api/approvals/' + encodeURIComponent(a.id) + '/decision', { method: 'POST', body });
        if (r.ok) {
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
      onChange();
    }
    approve.addEventListener('click', () => decide('allow'));
    deny.addEventListener('click', () => decide('deny'));

    const card = h('section', { class: 'approval', id, 'data-testid': 'approval-card', 'data-approval-id': a.id, 'aria-labelledby': id + '-t' }, [
      h('h4', { class: 'appr-title', id: id + '-t' }, [h('span', { class: 'chip-icon', 'aria-hidden': 'true', text: '!' }), h('span', { text: 'Approval needed' })]),
      h('dl', { class: 'appr-meta' }, [
        h('dt', { text: 'Project' }), h('dd', { text: project }),
        h('dt', { text: 'Conversation' }), h('dd', { text: c.win || c.sid }),
        h('dt', { text: 'Tool' }), h('dd', { class: 'appr-tool', 'data-testid': 'approval-tool', text: showInvisible(a.tool) }),
      ]),
      cmdPre,
      inputPre,
      scrollHint,
      a.truncated ? h('p', { class: 'appr-trunc', text: 'The input was cut short; what you see is only the start.' }) : null,
      h('div', { class: 'ctl-actions' }, [approve]),
      h('div', { class: 'appr-deny' }, [
        h('label', { for: id + '-msg', class: 'ctl-label', text: 'Deny message (optional)' }),
        h('div', { class: 'appr-deny-row' }, [msg, deny]),
      ]),
    ].filter(Boolean));
    return card;
  }
  const denyDrafts = new Map();

  // "Needs approval" strip at the top of the tree panel: summaries only; the actions live on the cards.
  function approvalStrip(items, jump) {
    if (!items.length) return null;
    return h('section', { class: 'appr-strip', 'data-testid': 'approval-strip', 'aria-labelledby': 'appr-strip-t' }, [
      h('h3', { class: 'appr-strip-title', id: 'appr-strip-t' }, [
        h('span', { class: 'chip-icon', 'aria-hidden': 'true', text: '!' }),
        h('span', { text: 'Needs approval (' + items.length + ')' }),
      ]),
      h('ul', { class: 'appr-strip-list' }, items.map((it) => {
        const go = h('button', { type: 'button', class: 'btn', 'data-testid': 'approval-jump', 'data-fk': it.c.approval.id + ':jump', text: 'Review' });
        go.addEventListener('click', () => jump(it.c.approval.id));
        return h('li', { class: 'appr-strip-item', 'data-approval-id': it.c.approval.id }, [
          h('span', { class: 'appr-strip-text', text: it.project + ' / ' + (it.c.win || it.c.sid) + ': ' + it.c.approval.tool }),
          go,
        ]);
      })),
    ]);
  }

  // ---------------------------------------------------------------- assembly

  // Controls block for a conversation card (everything below the header row).
  function convControls(c) {
    const interrupt = interruptButton(c);
    const close = closeControl(c);
    const els = [];
    const showPreview = c.status !== 'sleeping' && c.status !== 'ended' && c.status !== 'gone';
    const live = LIVE.has(c.status);
    if (showPreview) els.push(previewBlock(c));
    if (live || c.canPrompt) {
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
    approvalStrip,
    releasePreviews,
    reset,
    ansiToNodes, // exposed for tests
    setOnChange(fn) { onChange = fn; },
  };
})();
