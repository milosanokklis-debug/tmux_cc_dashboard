'use strict';
// Per-project sign-in view, shown above the project terminal while the project's Claude is not signed in.
// GET /api/projects/:p/login says whether it is (and carries the sign-in URL once Claude printed it);
// POST starts the login window. Polls every 2 s until signed in, then offers "Start Claude".
(function () {
  const { api, notice } = window.ccdash;
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 2000;

  let current = null;
  let gen = 0;
  let timer = null;
  let started = false;

  const path = () => '/api/projects/' + encodeURIComponent(current) + '/login';
  const say = (t) => { $('signin-status').textContent = t; };
  const safeUrl = (u) => (typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u) ? u : null);

  function paint(d) {
    const link = $('signin-link');
    const url = safeUrl(d.url);
    if (url) link.setAttribute('href', url); else link.removeAttribute('href');
    const signedIn = d.loggedIn === true;
    link.hidden = signedIn || !url;
    $('signin-start').hidden = !(signedIn || d.loggedIn == null);
    if (signedIn) say('Signed in. Choose Start Claude to continue.');
    else if (d.loggedIn == null) say('Could not tell whether this project is signed in. Try Start Claude, or sign in with the link.');
    else say(url ? 'Open the link, sign in, then paste the code into the terminal.' : 'Starting sign-in. The link appears here in a moment.');
  }

  async function check(my, first) {
    let d;
    try {
      const r = await api(path());
      if (my !== gen) return;
      if (!r.ok || !r.data) throw new Error('HTTP ' + r.status);
      d = r.data;
    } catch (e) {
      if (my !== gen) return;
      if (e.message !== 'unauthorized') {
        // Fail closed: show the sign-in view with the problem rather than nothing.
        $('signin').hidden = false;
        $('signin-link').hidden = true;
        $('signin-start').hidden = true;
        say('Could not check sign-in. Retrying.');
      }
      schedule(my, first);
      return;
    }
    if (first && d.loggedIn === true) { $('signin').hidden = true; return; } // already signed in: no sign-in view
    $('signin').hidden = false;
    if (d.loggedIn !== true && !started) {
      started = true;
      let err = null;
      try {
        const r = await api(path(), { method: 'POST', body: {} });
        if (!r.ok) err = (r.data && r.data.error) || 'HTTP ' + r.status;
      } catch (e) { if (e.message !== 'unauthorized') err = 'network error'; }
      if (my !== gen) return;
      if (err) {
        started = false; // try again on the next poll
        paint(d);
        say('Could not start sign-in: ' + err + '. Retrying.');
        schedule(my, first);
        return;
      }
    }
    paint(d);
    if (d.loggedIn !== true) schedule(my); // signed in: nothing left to wait for
  }

  function schedule(my, first) {
    clearTimeout(timer);
    timer = setTimeout(() => { if (my === gen) check(my, first === true); }, POLL_MS);
  }

  const clearBusy = () => { const b = $('signin-start'); b.removeAttribute('aria-busy'); b.removeAttribute('aria-disabled'); };

  $('signin-start').addEventListener('click', async () => {
    const btn = $('signin-start');
    if (current == null || btn.getAttribute('aria-busy') === 'true') return;
    const my = gen;
    btn.setAttribute('aria-busy', 'true');
    btn.setAttribute('aria-disabled', 'true');
    say('Starting Claude…');
    try {
      const r = await api('/api/projects/' + encodeURIComponent(current) + '/open', { method: 'POST', body: {} });
      if (my !== gen) return;
      if (r.ok) {
        $('signin').hidden = true;
        if (window.ccdash.terminal && window.ccdash.terminal.focus) window.ccdash.terminal.focus();
        notice('Started Claude in ' + current + '.', 'info');
        if (window.ccdash.windows) window.ccdash.windows.refresh();
      } else if (r.status === 409 && r.data && r.data.error === 'login-required') {
        say('Not signed in yet. Finish the sign-in first.');
        btn.hidden = true;
        if (window.ccdash.terminal && window.ccdash.terminal.focus) window.ccdash.terminal.focus();
        schedule(my);
      } else {
        say('Could not start Claude: ' + ((r.data && r.data.error) || 'HTTP ' + r.status));
      }
    } catch (e) {
      if (e.message !== 'unauthorized' && my === gen) say('Could not start Claude: network error.');
    } finally {
      if (my === gen) clearBusy();
    }
  });

  window.ccdash.signin = {
    start(project) {
      current = project;
      gen += 1;
      started = false;
      clearTimeout(timer);
      clearBusy();
      $('signin').hidden = true;
      $('signin-link').hidden = true;
      $('signin-start').hidden = true;
      say('');
      check(gen, true);
    },
    stop() {
      current = null;
      gen += 1;
      clearTimeout(timer);
      clearBusy();
      $('signin').hidden = true;
    },
  };
})();
