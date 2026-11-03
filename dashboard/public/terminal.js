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
      background: v('bg'), foreground: v('fg'), cursor: v('fg'), cursorAccent: v('bg'), selectionBackground: v('sel'),
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

  // First control of the agent panel, or its toggle when the panel is collapsed.
  function focusAgents() {
    const openPanel = $('tree-toggle').getAttribute('aria-expanded') === 'true';
    $(openPanel ? 'tree-all-projects' : 'tree-toggle').focus();
  }

  function isChord(ev, key) {
    return ev.key === key && ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey;
  }

  function open(proj) {
    close();
    project = proj;
    $('term-title').textContent = proj;
    term = new window.Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim(),
      fontSize: mobile.matches ? 13 : 14,
      cursorBlink: true,
      scrollback: 5000,
      theme: readTheme(),
      allowProposedApi: false,
    });
    // xterm swallows Tab (the shell needs it), so keyboard users leave with a chord instead.
    // Ctrl+Shift+Up/Down is unused by browsers, Claude Code and tmux (prefix is Ctrl-a).
    term.attachCustomKeyEventHandler((ev) => {
      if (isChord(ev, 'ArrowUp')) {
        if (ev.type === 'keydown') { ev.preventDefault(); focusAgents(); }
        return false;
      }
      return true;
    });
    fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new window.WebLinksAddon.WebLinksAddon());
    term.open($('term'));
    fitNow();
    disposables = [
      term.onData((d) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(d); }),
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
    fit = null;
    $('term').replaceChildren();
    project = null;
  }

  $('reconnect').addEventListener('click', () => {
    if (!term) return;
    term.reset();
    fitNow();
    connect();
    term.focus();
  });

  // Collapsible agent panel (default collapsed on phones so the terminal gets the room).
  const toggle = $('tree-toggle');
  function setTreeOpen(openIt) {
    toggle.setAttribute('aria-expanded', String(openIt));
    $('tree-body').hidden = !openIt;
    document.querySelector('.term-split').classList.toggle('tree-collapsed', !openIt);
  }
  toggle.addEventListener('click', () => setTreeOpen(toggle.getAttribute('aria-expanded') !== 'true'));

  $('skip-agents').addEventListener('click', focusAgents);
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
