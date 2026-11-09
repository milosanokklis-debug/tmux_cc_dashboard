'use strict';
// Shell: hash-based view switching (#/ = projects, #/term/<project> = terminal) and sign out.
(function () {
  const { projects, terminal, tree } = window.ccdash;
  const $ = (id) => document.getElementById(id);
  let view = null;
  let lastProject = null;
  let lastKey = null;

  // #/term/<project> or #/term/<project>?account=NAME (the account sign-in terminal carries its account here).
  const key = (proj, account) => proj + '\n' + (account || '');
  const termHash = (proj, account) => '#/term/' + encodeURIComponent(proj) + (account ? '?account=' + encodeURIComponent(account) : '');

  function parse() {
    const m = /^#\/term\/([^?]+)(?:\?account=([^&]*))?$/.exec(location.hash);
    if (!m) return null;
    try {
      const account = m[2] ? decodeURIComponent(m[2]) : null;
      return { proj: decodeURIComponent(m[1]), account: account && window.ccdash.accounts.RULE.test(account) ? account : null };
    } catch { return null; }
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

  function showTerminal(proj, account) {
    const k = key(proj, account);
    if (view === 'term' && lastKey === k) return;
    lastKey = k;
    terminal.close();
    projects.stop();
    view = 'term';
    lastProject = proj;
    document.body.classList.add('in-terminal');
    $('view-projects').hidden = true;
    $('view-terminal').hidden = false;
    document.title = 'ccdash: ' + proj;
    terminal.open(proj, account);
    tree.start(proj);
  }

  function route() {
    const t = parse();
    if (t) showTerminal(t.proj, t.account); else showList();
  }

  window.ccdash.go = function go(proj, account) {
    const target = termHash(proj, account);
    if (location.hash === target) route(); else location.hash = target;
  };

  // The terminal header changed account in place: keep the URL (and the same-route check) in step.
  window.ccdash.retarget = function retarget(proj, account) {
    lastKey = key(proj, account);
    history.replaceState(null, '', termHash(proj, account));
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
