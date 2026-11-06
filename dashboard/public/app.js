'use strict';
// Shell: hash-based view switching (#/ = projects, #/term/<project> = terminal) and sign out.
(function () {
  const { projects, terminal, tree } = window.ccdash;
  const $ = (id) => document.getElementById(id);
  let view = null;
  let lastProject = null;

  function parse() {
    const m = /^#\/term\/(.+)$/.exec(location.hash);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch { return null; }
  }

  function showList() {
    if (view === 'list') return;
    const returning = view === 'term';
    terminal.close();
    tree.stop();
    view = 'list';
    document.body.classList.remove('in-terminal');
    $('view-terminal').hidden = true;
    $('view-projects').hidden = false;
    document.title = 'ccdash';
    projects.start();
    if (returning) projects.focusProject(lastProject);
  }

  function showTerminal(proj) {
    if (view === 'term' && lastProject === proj) return;
    terminal.close();
    projects.stop();
    view = 'term';
    lastProject = proj;
    document.body.classList.add('in-terminal');
    $('view-projects').hidden = true;
    $('view-terminal').hidden = false;
    document.title = 'ccdash: ' + proj;
    terminal.open(proj);
    tree.start(proj);
  }

  function route() {
    const proj = parse();
    if (proj) showTerminal(proj); else showList();
  }

  window.ccdash.go = function go(proj) {
    const target = '#/term/' + encodeURIComponent(proj);
    if (location.hash === target) route(); else location.hash = target;
  };

  $('logout').addEventListener('click', async () => {
    const btn = $('logout');
    btn.disabled = true;
    try {
      const res = await fetch('/logout', { method: 'POST', headers: { 'X-CCDash': '1' }, credentials: 'same-origin' });
      if (res.ok || res.status === 401) { window.location.assign('/login'); return; }
      window.ccdash.notice('Sign out failed.', 'error');
    } catch {
      window.ccdash.notice('Sign out failed: network error.', 'error');
    }
    btn.disabled = false;
  });

  window.addEventListener('hashchange', route);
  window.ccdash.events.start();
  route();
})();
