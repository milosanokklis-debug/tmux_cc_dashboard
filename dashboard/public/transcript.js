'use strict';
// Read-only subagent transcript sheet. Loads GET /api/transcript and tails it by polling next_offset
// every 2 s, but only while the sheet is open and the tab is visible. All text goes in through
// textContent. There are no input or send controls here.
(function () {
  const { api, h } = window.ccdash;
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 2000;
  const RETRY_MS = 5000;
  const MAX_ENTRIES = 400;
  const TOOL_SHORT = 300;
  const RESULT_SHORT = 600;
  const ROLE = { assistant: 'Assistant', user: 'User', system: 'System' };

  const dlg = $('transcript-dialog');
  const log = $('tx-log');
  const statusEl = $('tx-status');
  const jump = $('tx-jump');
  let gen = 0; // bumped on open and close; a response from an older generation is dropped
  let timer = null;
  let target = null; // { conv, agent }
  let offset = null;
  let opener = null;
  let openerKey = null;
  let busyGen = -1; // generation with a request in flight

  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  const clip = (t, n) => { t = String(t == null ? '' : t); return t.length > n ? t.slice(0, n) + '\n… (' + (t.length - n) + ' more characters not shown)' : t; };
  const say = (t) => { statusEl.textContent = t; };

  function part(p) {
    const text = p && p.text != null ? p.text : '';
    switch (p && p.kind) {
      case 'thinking':
        return h('details', { class: 'tx-part tx-thinking', 'data-kind': 'thinking' }, [h('summary', { text: 'Thinking' }), h('pre', { text: clip(text, 4000) })]);
      case 'tool_use':
        return h('div', { class: 'tx-part tx-tool', 'data-kind': 'tool_use' }, [
          h('span', { class: 'tx-tool-name', text: 'Tool: ' + (p.name || 'unknown') }),
          text ? h('pre', { text: clip(text, TOOL_SHORT) }) : null,
        ].filter(Boolean));
      case 'tool_result':
        return h('div', { class: 'tx-part tx-result', 'data-kind': 'tool_result' }, [
          h('span', { class: 'tx-tool-name', text: 'Result' }),
          h('pre', { text: clip(text, RESULT_SHORT) }),
        ]);
      default:
        return h('p', { class: 'tx-part tx-text', 'data-kind': 'text', text: clip(text, 20000) });
    }
  }

  function entry(e) {
    const role = ROLE[e.role] || String(e.role || 'entry');
    const meta = [];
    if (e.model) meta.push(e.model);
    if (e.ts) { const d = new Date(e.ts * 1000); if (!Number.isNaN(d.getTime())) meta.push(d.toLocaleTimeString()); } // ts is in seconds
    return h('article', { class: 'tx-entry tx-' + (e.role === 'assistant' ? 'assistant' : 'user'), 'data-testid': 'transcript-entry', 'data-role': String(e.role || '') }, [
      h('header', { class: 'tx-head' }, [h('span', { class: 'tx-role', text: role }), ...meta.map((m) => h('span', { class: 'tx-meta', text: m }))]),
      ...(Array.isArray(e.parts) ? e.parts.map(part) : []),
    ]);
  }

  function append(entries, replace) {
    const stick = replace || atBottom();
    const nodes = entries.map(entry);
    if (replace) log.replaceChildren(...nodes); else log.append(...nodes);
    while (log.childElementCount > MAX_ENTRIES) log.firstElementChild.remove();
    $('tx-empty').hidden = log.childElementCount > 0;
    if (stick) { log.scrollTop = log.scrollHeight; jump.hidden = true; } else if (nodes.length) jump.hidden = false;
  }

  function schedule(ms) {
    clearTimeout(timer);
    const g = gen;
    timer = setTimeout(() => { timer = null; if (g === gen) fetchMore(); }, ms);
  }

  async function fetchMore() {
    if (!target) return;
    const g = gen;
    if (document.hidden || busyGen === g) return; // resumes on visibilitychange
    busyGen = g;
    const q = '/api/transcript?conv=' + encodeURIComponent(target.conv) + '&agent=' + encodeURIComponent(target.agent)
      + (offset != null ? '&offset=' + encodeURIComponent(offset) : '');
    let r;
    try { r = await api(q); } catch (e) {
      if (busyGen === g) busyGen = -1;
      if (g !== gen) return;
      if (e.message !== 'unauthorized') { say('Connection problem. Retrying…'); schedule(RETRY_MS); }
      return;
    }
    if (busyGen === g) busyGen = -1;
    if (g !== gen) return;
    if (r.status === 404) { say('Transcript not found. The agent may have ended and its file been removed.'); return; } // final: stop polling
    if (r.status === 503) { say('Transcript reader unavailable. Retrying…'); schedule(RETRY_MS); return; }
    if (!r.ok || !r.data) { say('Could not load the transcript (HTTP ' + r.status + '). Retrying…'); schedule(RETRY_MS); return; }
    const d = r.data;
    const first = offset == null;
    if (d.reset || first) {
      append(Array.isArray(d.entries) ? d.entries : [], true);
      say(d.reset && !first ? 'The file was rewritten; reloaded from the start.' : (d.truncated ? 'Showing the latest part of a long transcript.' : ''));
    } else if (Array.isArray(d.entries) && d.entries.length) {
      append(d.entries, false);
      say('');
    } else say('');
    if (Number.isFinite(d.next_offset)) offset = d.next_offset;
    schedule(POLL_MS);
  }

  function close() {
    gen++;
    clearTimeout(timer); timer = null;
    target = null; offset = null;
  }

  function open(opts) {
    close();
    target = { conv: opts.conv, agent: opts.agent };
    opener = opts.opener || null;
    openerKey = opener && opener.dataset ? opener.dataset.fk || null : null;
    $('tx-title').textContent = 'Transcript: ' + (opts.title || 'agent');
    log.replaceChildren();
    $('tx-empty').hidden = true;
    jump.hidden = true;
    say('Loading…');
    if (!dlg.open) dlg.showModal();
    fetchMore();
  }

  jump.addEventListener('click', () => { log.scrollTop = log.scrollHeight; jump.hidden = true; log.focus(); });
  log.addEventListener('scroll', () => { if (atBottom()) jump.hidden = true; }, { passive: true });
  $('tx-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => {
    close();
    // The tree re-renders while the sheet is open, so find the opener again by its key.
    const key = openerKey;
    let back = opener && opener.isConnected ? opener : null;
    if (!back && key) back = $('tree').querySelector('[data-fk="' + CSS.escape(key) + '"]');
    if (!back) back = $('tree-toggle');
    if (back) back.focus();
  });
  document.addEventListener('visibilitychange', () => { if (target && !document.hidden && !timer) fetchMore(); });

  window.ccdash.transcript = { open };
})();
