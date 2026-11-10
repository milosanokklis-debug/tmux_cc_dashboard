'use strict';
// Terminal view: xterm.js bound to /term/<project> over a WebSocket.
(function () {
  const $ = (id) => document.getElementById(id);

  // Colours live in CSS (--term-*) so the page and the terminal share one palette.
  const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name) => cs.getPropertyValue('--term-' + name).trim();
    const theme = {
      background: v('bg'), foreground: v('fg'), cursor: v('fg'), cursorAccent: v('bg'),
      selectionBackground: v('sel'), selectionInactiveBackground: v('sel-inactive'),
    };
    for (const n of ANSI) {
      theme[n] = v(n);
      theme['bright' + n[0].toUpperCase() + n.slice(1)] = v('bright-' + n);
    }
    return theme;
  }

  // xterm 6 injects generated <style> elements (theme colours, cell metrics). Under
  // `default-src 'self'` setting their text is blocked. Constructable stylesheets
  // are CSSOM, not inline style, so route those writes through one (and adopt it).
  // Nothing else in the app creates <style> elements.
  const createElement = Document.prototype.createElement;
  Document.prototype.createElement = function (tag, options) {
    if (typeof tag === 'string' && tag.toLowerCase() === 'style') {
      // Even an empty <style> in the DOM is a CSP violation, so hand xterm a hidden stub.
      const stub = createElement.call(this, 'div');
      stub.hidden = true;
      shimStyleElement(stub);
      return stub;
    }
    return createElement.call(this, tag, options);
  };
  // The DOM renderer also writes per-cell style="" attributes; route those through CSSOM too.
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (typeof name === 'string' && name.toLowerCase() === 'style') { this.style.cssText = String(value); return; }
    return setAttribute.call(this, name, value);
  };
  function shimStyleElement(el) {
    let sheet = null;
    const remove = el.remove;
    Object.defineProperty(el, 'textContent', {
      configurable: true,
      get() { return ''; },
      set(css) {
        if (!sheet) {
          sheet = new CSSStyleSheet();
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        }
        sheet.replaceSync(String(css));
      },
    });
    el.remove = function () {
      if (sheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== sheet);
      sheet = null;
      remove.call(el);
    };
  }

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const mobile = window.matchMedia('(max-width: 720px)');

  let term = null;
  let fit = null;
  let ws = null;
  let ro = null;
  let project = null;
  let raf = 0;
  let disposables = [];
  let onTheme = null;

  const STATE = {
    connecting: { icon: '◌', text: 'Connecting…' },
    connected: { icon: '●', text: 'Connected' },
    disconnected: { icon: '○', text: 'Disconnected' },
  };
  function setState(name) {
    $('conn').dataset.state = name;
    $('conn-icon').textContent = STATE[name].icon;
    $('conn-text').textContent = STATE[name].text;
    $('reconnect').hidden = name !== 'disconnected';
  }

  function fitNow() {
    raf = 0;
    const el = $('term');
    if (!term || !fit || el.offsetWidth < 20 || el.offsetHeight < 20) return;
    try { fit.fit(); } catch { /* container not laid out yet */ }
  }
  function scheduleFit() { if (!raf) raf = requestAnimationFrame(fitNow); }

  // ===== Clipboard =====
  // Needs a secure context (https or localhost) and, for reads, a user gesture and permission.
  const INFO_MS = 4000;
  const ERROR_MS = 8000;
  let clipNotice = null;
  let clipTimer = 0;
  // One notice element, updated in place on bursts: no flicker, and a screen reader hears each
  // change once. Re-saying the same message only restarts the timer.
  function say(message, kind, action) {
    clearTimeout(clipTimer);
    const err = kind === 'error';
    // Sit just under the toolbar (it wraps on phones) so Copy, Paste and Agents stay clickable.
    $('notices').style.setProperty('--notice-top', ($('view-terminal').querySelector('.term-bar').getBoundingClientRect().bottom + 6) + 'px');
    if (!clipNotice || !clipNotice.isConnected) {
      clipNotice = window.ccdash.notice(message, kind);
    } else {
      const text = clipNotice.querySelector('.notice-text');
      if (text.textContent !== message) text.textContent = message;
      clipNotice.className = 'notice notice-' + (err ? 'error' : 'info');
      clipNotice.setAttribute('role', err ? 'alert' : 'status');
      clipNotice.querySelector('.notice-icon').textContent = err ? '!' : 'i';
    }
    const item = clipNotice;
    const old = item.querySelector('.notice-action');
    if (old) old.remove();
    if (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn notice-action';
      btn.textContent = action.label;
      btn.addEventListener('click', () => { item.remove(); action.run(); });
      item.querySelector('.notice-close').before(btn);
    }
    clipTimer = setTimeout(() => {
      item.remove();
      if (clipNotice === item) clipNotice = null;
    }, err || action ? ERROR_MS : INFO_MS);
  }

  async function writeClipboard(text) {
    if (!(navigator.clipboard && navigator.clipboard.writeText)) throw new Error('no clipboard API');
    await navigator.clipboard.writeText(text);
  }
  // `done` is the message for success: 'Copied' for the user's own copies.
  async function putOnClipboard(text, done) {
    try {
      await writeClipboard(text);
      say(done, 'info');
      return true;
    } catch {
      say('Could not copy: the browser blocked clipboard access. It needs https or localhost and a recent click or key press.', 'error');
      return false;
    }
  }

  function copySelection() {
    if (!term || !term.hasSelection()) return Promise.resolve(false);
    return putOnClipboard(term.getSelection(), 'Copied');
  }

  // A terminal-originated clipboard write (OSC 52) is honoured only shortly after the user
  // interacted with the terminal, so a program cannot silently replace the clipboard.
  const GESTURE_MS = 1500;
  const MAX_OSC52 = 100000;
  let lastGesture = -Infinity;
  const markGesture = () => { lastGesture = performance.now(); };

  // OSC 52 from tmux or Claude Code. Writes only: a program in the terminal must not be able
  // to read the user's clipboard, so reads ("?") answer with an empty string. Never rejects.
  const clipboardProvider = {
    readText() { return ''; },
    async writeText(_selection, text) {
      // tmux may send an empty selection parameter; a browser has only one clipboard, so take any.
      // An empty payload (undecodable or a clear request) must not wipe what the user copied.
      if (!text) return;
      const n = text.length;
      if (n > MAX_OSC52) {
        say('A program in the terminal tried to set your clipboard (' + n + ' chars). Blocked.', 'info');
      } else if (performance.now() - lastGesture <= GESTURE_MS) {
        await putOnClipboard(text, 'Terminal set the clipboard (' + n + ' chars)');
      } else {
        say('A program in the terminal tried to set your clipboard (' + n + ' chars). Blocked.', 'info',
          { label: 'Copy anyway', run: () => putOnClipboard(text, 'Copied') });
      }
    },
  };

  // Pasted text goes to the shell inside a bracketed-paste wrapper, which text containing
  // ESC[201~ could close early. Drop C0 controls (keeping tab, newline, CR), DEL and C1.
  function sanitisePaste(text) {
    return String(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
  }
  function pasteText(t, text) {
    const clean = sanitisePaste(text);
    if (clean) t.paste(clean);
  }

  // The server drops a socket on a message over 64 KiB, so send in slices of at most 16 KiB,
  // in order, never cutting a surrogate pair in half.
  const CHUNK = 16 * 1024;
  function sendChunked(sock, data) {
    for (let i = 0; i < data.length;) {
      let end = Math.min(i + CHUNK, data.length);
      if (end < data.length) {
        const c = data.charCodeAt(end - 1);
        if (c >= 0xd800 && c <= 0xdbff) end--;
      }
      sock.send(data.slice(i, end));
      i = end;
    }
  }

  function pasteFallback() {
    const dlg = $('paste-dialog');
    if (dlg.open) return;
    $('paste-text').value = '';
    dlg.showModal();
    $('paste-text').focus();
  }
  async function pasteFromClipboard() {
    const t = term;
    if (!t) return;
    if (!(navigator.clipboard && navigator.clipboard.readText)) { pasteFallback(); return; }
    let text;
    try { text = await navigator.clipboard.readText(); } catch { if (t === term) pasteFallback(); return; }
    if (t !== term) return;
    pasteText(t, text);
    t.focus();
  }

  $('copy').addEventListener('click', async () => {
    await copySelection();
    if (term) term.focus();
  });
  $('paste').addEventListener('click', pasteFromClipboard);
  $('paste-cancel').addEventListener('click', () => $('paste-dialog').close());
  $('paste-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = $('paste-text').value;
    $('paste-dialog').close();
    if (term && text) pasteText(term, text);
  });
  // Escape and Cancel both end up here: hand focus back to the shell.
  $('paste-dialog').addEventListener('close', () => { $('paste-text').value = ''; if (term) term.focus(); });

  // Copy on select. A drag may end outside the terminal, so listen on the document but only
  // for drags that started in it. mouseup counts as a user gesture for the clipboard API.
  let dragging = false;
  // Capture phase: xterm stops propagation of some mouse events (e.g. while tmux has mouse tracking on).
  $('term').addEventListener('mousedown', (ev) => { if (ev.button === 0) dragging = true; }, true);
  for (const type of ['mousedown', 'mouseup', 'keydown', 'keyup']) $('term').addEventListener(type, markGesture, true);
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    markGesture(); // the drag may have ended outside the terminal; tmux then sends OSC 52
    // xterm finalises the selection in its own mouseup handler; look after it ran.
    setTimeout(() => { if (term && term.hasSelection()) copySelection(); }, 0);
  }, true);
  window.addEventListener('blur', () => { dragging = false; });

  // Returns 'copy' | 'paste' | null for the clipboard chords.
  function clipboardKey(ev) {
    if (ev.altKey || ev.metaKey) return null;
    if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyC') return 'copy';
    if (ev.ctrlKey && !ev.shiftKey && ev.code === 'Insert') return 'copy';
    if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyV') return 'paste';
    if (!ev.ctrlKey && ev.shiftKey && ev.code === 'Insert') return 'paste';
    return null;
  }

  function connect() {
    closeSocket();
    setState('connecting');
    const url = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host +
      '/term/' + encodeURIComponent(project) + '?cols=' + term.cols + '&rows=' + term.rows;
    const sock = new WebSocket(url);
    ws = sock;
    sock.binaryType = 'arraybuffer';
    sock.addEventListener('open', () => {
      if (ws !== sock) return;
      setState('connected');
      // Size may have changed while connecting.
      sock.send(JSON.stringify({ resize: [term.cols, term.rows] }));
    });
    sock.addEventListener('message', (ev) => {
      if (ws !== sock || !term) return;
      if (typeof ev.data === 'string') term.write(ev.data);
      else term.write(new Uint8Array(ev.data)); // xterm decodes UTF-8 across chunk boundaries
    });
    sock.addEventListener('close', () => {
      if (ws !== sock) return;
      ws = null;
      setState('disconnected');
      if (term) term.write('\r\n\x1b[2m[disconnected]\x1b[0m\r\n');
      // A dropped socket may mean the session expired: probing any API redirects to /login on 401.
      window.ccdash.api('/api/projects').catch(() => {});
    });
    sock.addEventListener('error', () => { /* close follows */ });
  }

  function closeSocket() {
    if (!ws) return;
    const s = ws;
    ws = null;
    try { s.close(1000); } catch { /* already closed */ }
  }

  // First control of the Windows panel, or its toggle when the panel is collapsed.
  function focusWindows() {
    const openPanel = $('tree-toggle').getAttribute('aria-expanded') === 'true';
    $(openPanel ? 'win-new-claude' : 'tree-toggle').focus();
  }

  function isChord(ev, key) {
    return ev.key === key && ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey;
  }

  function open(proj) {
    close();
    project = proj;
    window.ccdash.view.project = proj;
    $('term-title').textContent = proj;
    term = new window.Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim(),
      fontSize: mobile.matches ? 13 : 14,
      cursorBlink: true,
      scrollback: 5000,
      theme: readTheme(),
      allowProposedApi: false,
      macOptionClickForcesSelection: true, // Option+drag selects in xterm on a Mac, as Shift does elsewhere
    });
    // xterm swallows Tab (the shell needs it), so keyboard users leave with a chord instead.
    // Ctrl+Shift+Up/Down is unused by browsers, Claude Code and tmux (prefix is Ctrl-a).
    term.attachCustomKeyEventHandler((ev) => {
      if (isChord(ev, 'ArrowUp')) {
        if (ev.type === 'keydown') { ev.preventDefault(); focusWindows(); }
        return false;
      }
      // Keep Ctrl+C an interrupt: only the Shift and Insert chords touch the clipboard.
      const action = clipboardKey(ev);
      if (action === 'copy') {
        if (ev.type === 'keydown') { ev.preventDefault(); copySelection(); }
        return false; // never sent to the shell, with or without a selection
      }
      // Paste is left to the browser: it fires a paste event on xterm's textarea, handled (and
      // sanitised) by the capture listener in open(). Handling it here as well would paste twice.
      if (action === 'paste') return false;
      return true;
    });
    fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new window.WebLinksAddon.WebLinksAddon());
    if (window.ClipboardAddon) term.loadAddon(new window.ClipboardAddon.ClipboardAddon(undefined, clipboardProvider));
    term.open($('term'));
    // Browser-native pastes (Ctrl+Shift+V, Shift+Insert, context menu) reach xterm's textarea:
    // take them over so they are sanitised too. Capture + immediate stop keeps xterm's own
    // handler from pasting a second time.
    const t = term;
    t.textarea.addEventListener('paste', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      if (t !== term) return;
      const text = ev.clipboardData && ev.clipboardData.getData('text/plain');
      if (text) pasteText(t, text);
    }, true);
    fitNow();
    $('copy').disabled = true;
    disposables = [
      term.onSelectionChange(() => { $('copy').disabled = !(term && term.hasSelection()); }),
      term.onData((d) => { if (d && ws && ws.readyState === WebSocket.OPEN) sendChunked(ws, d); }),
      term.onResize(({ cols, rows }) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ resize: [cols, rows] }));
      }),
    ];
    ro = new ResizeObserver(scheduleFit);
    ro.observe($('term'));
    onTheme = () => { if (term) term.options.theme = readTheme(); };
    mq.addEventListener('change', onTheme);
    connect();
    term.focus();
  }

  function close() {
    cancelAnimationFrame(raf);
    raf = 0;
    if (ro) { ro.disconnect(); ro = null; }
    if (onTheme) { mq.removeEventListener('change', onTheme); onTheme = null; }
    closeSocket();
    for (const d of disposables) d.dispose();
    disposables = [];
    if (term) { term.dispose(); term = null; }
    $('copy').disabled = true;
    if ($('paste-dialog').open) $('paste-dialog').close();
    if (clipNotice) { clipNotice.remove(); clipNotice = null; }
    clearTimeout(clipTimer);
    fit = null;
    $('term').replaceChildren();
    project = null;
    window.ccdash.view.project = null;
  }

  $('reconnect').addEventListener('click', () => {
    if (!term) return;
    term.reset();
    fitNow();
    connect();
    term.focus();
  });

  // Collapsible Windows panel (default collapsed on phones so the terminal gets the room).
  const toggle = $('tree-toggle');
  function setTreeOpen(openIt) {
    toggle.setAttribute('aria-expanded', String(openIt));
    $('tree-body').hidden = !openIt;
    document.querySelector('.term-split').classList.toggle('tree-collapsed', !openIt);
  }
  toggle.addEventListener('click', () => setTreeOpen(toggle.getAttribute('aria-expanded') !== 'true'));

  $('skip-agents').addEventListener('click', focusWindows);
  $('skip-term').addEventListener('click', () => { if (term) term.focus(); });
  // Way back from the agent panel to the shell.
  document.addEventListener('keydown', (ev) => {
    if (term && isChord(ev, 'ArrowDown') && !$('view-terminal').hidden) { ev.preventDefault(); term.focus(); }
  });

  window.ccdash.terminal = {
    open(proj) { setTreeOpen(!mobile.matches); open(proj); },
    close,
  };
})();
