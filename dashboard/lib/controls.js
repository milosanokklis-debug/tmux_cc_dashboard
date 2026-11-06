'use strict';
// Conversation controls: prompt, interrupt, close, preview. Every handler resolves the
// conversation through the reconciler and acts on its recorded tmux pane. Prompt text is only
// ever passed to tmux on stdin: it is never logged and never part of an error message.
const crypto = require('node:crypto');
const { setTimeout: sleepMs } = require('node:timers/promises');
const { HttpError, readJson } = require('./http');

const MAX_BODY = 64 * 1024; // 8000 bytes, up to 6 bytes each when \u-escaped
const MAX_PROMPT_BYTES = 8000;
const ESCAPE_WAIT_MS = 2000;
const PREVIEW_LINES = 20;
const PREVIEW_BYTES = 8 * 1024;
const PREVIEW_TTL_MS = 1000;
const LIVE = new Set(['working', 'needs_approval', 'waiting', 'error']);
// C0 except \n and \t, DEL and C1: an ESC could end the bracketed paste early.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;

function createControls(svc, {
  closeWaitSec = /^[0-9]+$/.test(process.env.CCDASH_CLOSE_WAIT ?? '') ? Number(process.env.CCDASH_CLOSE_WAIT) : 10,
  pollMs = 250, sleep = sleepMs, log = console.error,
} = {}) {
  const busy = new Set(); // sids with a prompt or close in flight
  const previews = new Map(); // sid -> { t, text }

  async function lookup(sid, fresh = true) {
    if (!/^[0-9a-f-]{36}$/.test(sid)) throw new HttpError(400, 'invalid conversation id');
    if (fresh) await svc.reconciler.tick(); // fresh = false: the last snapshot (the /events hub previews often)
    const rec = svc.reconciler.get(sid);
    if (!rec) throw new HttpError(404, 'no such conversation');
    if (rec.hidden) throw new HttpError(409, 'this conversation was already woken');
    if (!rec.pane) throw new HttpError(409, 'this conversation is not in a tmux pane');
    return rec;
  }
  const need = (rec, ok, what) => {
    if (!ok.includes(rec.status)) throw new HttpError(409, `conversation is ${rec.status}, not ${what}`);
  };

  // load-buffer (text on stdin), paste-buffer -p (bracketed, so newlines stay in the prompt), Enter.
  async function pasteAndEnter(sid, pane, text) {
    const id = crypto.randomBytes(8).toString('hex');
    try {
      await svc.tmux.runInput(['load-buffer', '-b', id, '-'], text);
      await svc.tmux.run(['paste-buffer', '-p', '-d', '-b', id, '-t', pane]);
      await svc.tmux.run(['send-keys', '-t', pane, 'Enter']);
    } catch {
      try { await svc.tmux.run(['delete-buffer', '-b', id]); } catch { /* not created or already deleted */ }
      log(`controls: sending to the terminal failed for ${sid} (${Buffer.byteLength(text)} bytes)`);
      throw new HttpError(502, 'could not send to the terminal');
    }
  }

  function checkText(raw) {
    if (typeof raw !== 'string' || !raw.trim()) throw new HttpError(400, 'Prompt is empty.');
    const text = raw.replace(/\r\n/g, '\n');
    const bytes = Buffer.byteLength(text);
    if (bytes > MAX_PROMPT_BYTES) {
      throw new HttpError(413, `Prompt is too long: ${bytes} bytes, the limit is ${MAX_PROMPT_BYTES}. Shorten or split it.`);
    }
    if (CONTROL.test(text) || !text.isWellFormed()) {
      throw new HttpError(400, 'Prompt contains control or invalid characters.');
    }
    return text;
  }

  async function exclusive(sid, fn) {
    if (busy.has(sid)) throw new HttpError(409, 'another prompt or close is in progress for this conversation');
    busy.add(sid);
    try { return await fn(); } finally { busy.delete(sid); }
  }

  return {
    async prompt(sid, req) {
      const body = await readJson(req, MAX_BODY);
      const rec = await lookup(sid);
      need(rec, ['waiting'], 'waiting');
      const text = checkText(body.text);
      return exclusive(sid, async () => {
        // The conversation may have turned needs_approval since the check above: Enter would answer the dialog.
        await svc.reconciler.tick();
        const cur = svc.reconciler.get(sid);
        if (!cur) throw new HttpError(404, 'no such conversation');
        need(cur, ['waiting'], 'waiting');
        await pasteAndEnter(sid, cur.pane, text);
        return { ok: true };
      });
    },

    async interrupt(sid) {
      const rec = await lookup(sid);
      need(rec, ['working', 'needs_approval'], 'working');
      try { await svc.tmux.run(['send-keys', '-t', rec.pane, 'Escape']); } catch { throw new HttpError(502, 'could not send to the terminal'); }
      return { ok: true };
    },

    async close(sid) {
      const rec = await lookup(sid);
      if (!LIVE.has(rec.status)) throw new HttpError(409, `conversation is ${rec.status}, not running`);
      return exclusive(sid, async () => {
        let paste = true;
        if (rec.status === 'needs_approval') {
          // A pasted /exit + Enter could land on the dialog's default (Yes) and approve the tool:
          // Escape cancels the dialog first, and /exit is only sent once the conversation has left it.
          try { await svc.tmux.run(['send-keys', '-t', rec.pane, 'Escape']); } catch { throw new HttpError(502, 'could not send to the terminal'); }
          paste = false;
          for (let i = 0; i * pollMs < ESCAPE_WAIT_MS; i++) {
            await sleep(pollMs);
            await svc.reconciler.tick();
            const cur = svc.reconciler.get(sid);
            if (cur?.status === 'ended') return { ok: true, result: 'ended' };
            if (cur?.status !== 'needs_approval') { paste = true; break; }
          }
        }
        if (paste) await pasteAndEnter(sid, rec.pane, '/exit');
        const polls = Math.ceil((closeWaitSec * 1000) / pollMs);
        for (let i = 0; i <= polls; i++) {
          await svc.reconciler.tick();
          const cur = svc.reconciler.get(sid);
          if (cur?.status === 'ended') return { ok: true, result: 'ended' };
          if (i < polls) await sleep(pollMs);
        }
        // Still running: kill the pane, but only if it is still this conversation's live pane.
        await svc.reconciler.tick();
        const cur = svc.reconciler.get(sid);
        if (cur?.status === 'ended') return { ok: true, result: 'ended' };
        if (!cur || cur.pane !== rec.pane || !LIVE.has(cur.status)) return { ok: true, result: 'gone' };
        try { await svc.tmux.run(['kill-pane', '-t', rec.pane]); } catch { throw new HttpError(502, 'could not close the terminal'); }
        return { ok: true, result: 'killed' };
      });
    },

    async preview(sid, { fresh = true } = {}) {
      const rec = await lookup(sid, fresh);
      if (rec.status === 'sleeping' || rec.status === 'ended') throw new HttpError(409, `conversation is ${rec.status}`);
      const now = svc.now();
      const hit = previews.get(sid);
      if (hit && now - hit.t < PREVIEW_TTL_MS) return { text: hit.text };
      let out;
      try { out = await svc.tmux.run(['capture-pane', '-p', '-e', '-t', rec.pane]); } catch { throw new HttpError(502, 'could not read the terminal'); }
      const lines = out.split('\n');
      while (lines.length && !lines[lines.length - 1].replace(ANSI, '').trim()) lines.pop();
      let text = lines.slice(-PREVIEW_LINES).join('\n');
      while (Buffer.byteLength(text) > PREVIEW_BYTES) {
        const nl = text.indexOf('\n');
        text = nl < 0 ? text.slice(-PREVIEW_BYTES / 4) : text.slice(nl + 1);
      }
      if (previews.size > 200) previews.clear();
      previews.set(sid, { t: now, text });
      return { text };
    },
  };
}

module.exports = { createControls };
