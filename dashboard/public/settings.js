'use strict';
// Notifications settings: Web Push subscribe / unsubscribe and which events to notify about.
(function () {
  const { api, h, notice, accounts } = window.ccdash;
  const $ = (id) => document.getElementById(id);
  const KEYS = ['approval', 'error', 'finished'];
  const STATE_TEXT = {
    checking: 'Checking…',
    unsupported: 'This browser cannot receive push notifications (no service worker or PushManager, or the page is not served over HTTPS).',
    denied: 'Notifications are blocked for this site. Allow them in the browser site settings, then reopen this panel.',
    off: 'Notifications are off on this browser.',
    on: 'Notifications are on for this browser.',
    unavailable: 'Notifications are not available on this server right now.',
  };

  let config = null;

  const supported = () => window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  function b64urlToBytes(s) {
    const pad = '='.repeat((4 - (s.length % 4)) % 4);
    const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function showError(msg) {
    // The live region stays rendered; it is empty (and collapsed by CSS :empty) when there is no message.
    $('notif-error').textContent = msg || '';
  }

  function prefsFromUi() {
    const o = {};
    for (const k of KEYS) o[k] = $('toggle-' + k).checked;
    return o;
  }

  function paint(state, prefs) {
    $('notif-state').textContent = STATE_TEXT[state];
    $('notif-state').dataset.state = state;
    $('notif-enable').hidden = !(state === 'off');
    $('notif-prefs').hidden = state !== 'on';
    $('notif-disable').hidden = state !== 'on';
    if (prefs) for (const k of KEYS) $('toggle-' + k).checked = !!prefs[k];
  }

  async function localSubscription() {
    const reg = await navigator.serviceWorker.getRegistration('/');
    return reg ? reg.pushManager.getSubscription() : null;
  }

  async function load() {
    showError('');
    paint('checking');
    if (!supported()) { paint('unsupported'); return; }
    let r;
    try { r = await api('/api/push/config'); } catch { paint('unavailable'); return; }
    if (!r.ok || !r.data || !r.data.publicKey) { paint('unavailable'); return; }
    config = r.data;
    if (Notification.permission === 'denied') { paint('denied'); return; }
    let sub = null;
    try { sub = await localSubscription(); } catch { /* treated as not subscribed */ }
    paint(config.subscribed && sub ? 'on' : 'off', config.prefs);
  }

  async function enable() {
    const btn = $('notif-enable');
    btn.disabled = true;
    showError('');
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { paint(perm === 'denied' ? 'denied' : 'off'); return; }
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(config.publicKey) });
      const prefs = config.prefs || { approval: true, error: true, finished: false };
      const r = await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), prefs } });
      if (!r.ok) throw new Error((r.data && r.data.error) || 'HTTP ' + r.status);
      config.subscribed = true;
      config.prefs = prefs;
      paint('on', prefs);
      notice('Notifications turned on.', 'info');
      $('toggle-approval').focus();
    } catch (e) {
      if (e.message !== 'unauthorized') showError('Could not turn on notifications: ' + e.message);
    } finally { btn.disabled = false; }
  }

  async function disable() {
    const btn = $('notif-disable');
    btn.disabled = true;
    showError('');
    try {
      const sub = await localSubscription();
      if (sub) await sub.unsubscribe();
      const r = await api('/api/push/unsubscribe', { method: 'POST', body: {} });
      if (!r.ok) throw new Error((r.data && r.data.error) || 'HTTP ' + r.status);
      config.subscribed = false;
      paint('off');
      notice('Notifications turned off on this browser.', 'info');
      $('notif-enable').focus();
    } catch (e) {
      if (e.message !== 'unauthorized') showError('Could not turn off notifications: ' + e.message);
    } finally { btn.disabled = false; }
  }

  async function savePrefs(changed) {
    showError('');
    const prefs = prefsFromUi();
    for (const k of KEYS) $('toggle-' + k).disabled = true;
    try {
      const r = await api('/api/push/prefs', { method: 'POST', body: prefs });
      if (!r.ok) throw new Error((r.data && r.data.error) || 'HTTP ' + r.status);
      if (config) config.prefs = prefs;
    } catch (e) {
      changed.checked = !changed.checked;
      if (e.message !== 'unauthorized') showError('Could not save: ' + e.message);
    } finally {
      for (const k of KEYS) $('toggle-' + k).disabled = false;
      changed.focus();
    }
  }

  // Once the state is known: Enable when it is shown, else the first toggle; otherwise stay on Close.
  function focusFirst() {
    if (!dlg.open || document.activeElement !== $('notif-close')) return;
    const enable = $('notif-enable');
    if (!enable.hidden) enable.focus();
    else if (!$('notif-prefs').hidden) $('toggle-approval').focus();
  }

  const dlg = $('notif-dialog');
  let opener = null;
  $('notif-open').addEventListener('click', () => {
    opener = $('notif-open');
    dlg.showModal();
    gidStatus('');
    gidField(gidName, $('gid-name-err'), '');
    gidField(gidEmail, $('gid-email-err'), '');
    gidLoad();
    sessLoad();
    acctReset();
    $('kit-confirm').hidden = true;
    if (kitSec.open) kitLoad();
    accounts.load();
    load().then(focusFirst);
    $('notif-close').focus(); // until the state is known
  });
  $('notif-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => { if (opener) opener.focus(); });
  $('notif-enable').addEventListener('click', enable);
  $('notif-disable').addEventListener('click', disable);
  for (const k of KEYS) $('toggle-' + k).addEventListener('change', (e) => savePrefs(e.target));

  // ---- Git identity ----
  const gidName = $('gid-name');
  const gidEmail = $('gid-email');
  let gidDirty = false;

  // Field-error slots and the status line are always rendered; empty ones keep their reserved space or collapse via CSS.
  function gidField(input, errEl, msg) {
    errEl.textContent = msg || '';
    if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
  }

  function gidStatus(msg, isError) {
    const el = $('gid-status');
    el.textContent = msg || '';
    el.classList.toggle('is-error', !!isError);
  }

  function gidValidate() {
    const name = gidName.value.trim();
    const email = gidEmail.value.trim();
    let nameErr = '';
    let emailErr = '';
    if (!name) nameErr = 'Enter a name.';
    else if (name.length > 100) nameErr = 'Name must be 100 characters or fewer.';
    else if (/[\u0000-\u001f\u007f]/.test(name)) nameErr = 'Name cannot contain control characters.';
    if (!email) emailErr = 'Enter an email address.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[\u0000-\u001f\u007f]/.test(email)) emailErr = 'Enter an email like name@example.com.';
    gidField(gidName, $('gid-name-err'), nameErr);
    gidField(gidEmail, $('gid-email-err'), emailErr);
    return { name, email, ok: !nameErr && !emailErr, first: nameErr ? gidName : gidEmail };
  }

  async function gidLoad() {
    if (gidDirty) return; // keep what the user is typing
    try {
      const r = await api('/api/git-identity');
      if (!r.ok) throw new Error((r.data && r.data.error) || 'HTTP ' + r.status);
      if (!gidDirty) {
        gidName.value = (r.data && r.data.name) || '';
        gidEmail.value = (r.data && r.data.email) || '';
      }
    } catch (e) {
      if (e.message !== 'unauthorized') gidStatus('Could not load the git identity: ' + e.message, true);
    }
  }

  $('gid-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const save = $('gid-save');
    if (save.getAttribute('aria-busy') === 'true') return;
    gidStatus('');
    const v = gidValidate();
    if (!v.ok) { v.first.focus(); return; }
    save.setAttribute('aria-busy', 'true');
    save.setAttribute('aria-disabled', 'true');
    save.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), document.createTextNode('Saving…'));
    try {
      const r = await api('/api/git-identity', { method: 'POST', body: { name: v.name, email: v.email } });
      const d = r.data || {};
      if (!r.ok) {
        const msg = d.error || 'Could not save (HTTP ' + r.status + ').';
        if (r.status === 400) {
          // Attach the server's refusal to the field it names, else show it as the status.
          if (/email/i.test(msg)) { gidField(gidEmail, $('gid-email-err'), msg); gidEmail.focus(); }
          else if (/name/i.test(msg)) { gidField(gidName, $('gid-name-err'), msg); gidName.focus(); }
          else gidStatus(msg, true);
        } else gidStatus(msg, true);
        return;
      }
      if (typeof d.name === 'string') gidName.value = d.name;
      if (typeof d.email === 'string') gidEmail.value = d.email;
      gidDirty = false;
      gidStatus(d.message || 'Git identity saved.', false);
    } catch (e) {
      if (e.message !== 'unauthorized') gidStatus('Network error: ' + e.message, true);
    } finally {
      save.removeAttribute('aria-busy');
      save.removeAttribute('aria-disabled');
      save.textContent = 'Save identity';
    }
  });
  for (const input of [gidName, gidEmail]) {
    input.addEventListener('input', () => {
      gidDirty = true;
      if (input.getAttribute('aria-invalid') === 'true') {
        gidField(input, input === gidName ? $('gid-name-err') : $('gid-email-err'), '');
      }
    });
  }

  // ---- Claude accounts ----
  const acctName = $('acct-name');
  const acctAdd = $('acct-add');
  let acctBusy = false;

  function acctPaint() {
    $('acct-list').replaceChildren(...accounts.list().map((a) => h('li', { 'data-testid': 'account-row', 'data-account': a.name }, [
      h('span', { class: 'acct-name', text: a.name }),
      // Icon plus words, never colour alone.
      h('span', { class: 'chip ' + (a.loggedIn ? 'chip-done' : 'chip-shell') }, [
        h('span', { class: 'chip-icon', 'aria-hidden': 'true', text: a.loggedIn ? '✓' : '!' }),
        h('span', { text: a.loggedIn ? 'logged in' : 'Not logged in. Use Add account to sign in.' }),
      ]),
    ])));
  }
  accounts.onChange(acctPaint);
  acctPaint();

  function acctProblem(name) {
    if (!name) return '';
    if (name === 'default') return '“default” is reserved. Choose another name.';
    if (!accounts.RULE.test(name)) return 'Use lowercase letters, digits, - and _ (up to 32), starting with a letter or digit.';
    if (accounts.names().includes(name)) return 'That account already exists.';
    return '';
  }
  function acctSync() { acctAdd.disabled = acctBusy; }
  // Show (or clear) the name problem; typing only clears it, blur and submit show it.
  function acctCheck(show) {
    const msg = acctProblem(acctName.value.trim());
    if (show || !msg) { $('acct-name-err').textContent = msg; if (msg) acctName.setAttribute('aria-invalid', 'true'); else acctName.removeAttribute('aria-invalid'); }
    return msg;
  }
  function acctError(msg) { $('acct-error').textContent = msg || ''; }
  function acctReset() { acctName.value = ''; acctError(''); acctCheck(false); acctBusy = false; acctSync(); }
  acctName.addEventListener('input', () => { acctError(''); acctCheck(false); });
  acctName.addEventListener('blur', () => { if (acctName.value.trim()) acctCheck(true); });

  $('acct-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const name = acctName.value.trim();
    if (acctBusy) return;
    if (!name || acctCheck(true)) {
      if (!name) { $('acct-name-err').textContent = 'Enter a name for the account.'; acctName.setAttribute('aria-invalid', 'true'); }
      acctName.focus();
      return;
    }
    acctBusy = true;
    acctError('');
    acctSync();
    try {
      const r = await api('/api/accounts', { method: 'POST', body: { name } });
      const d = r.data || {};
      if (!r.ok) {
        const msg = d.error || 'Could not add the account (HTTP ' + r.status + ').';
        if (r.status === 400) { $('acct-name-err').textContent = msg; acctName.setAttribute('aria-invalid', 'true'); acctName.focus(); }
        else acctError(msg);
        return;
      }
      acctReset();
      opener = null; // the terminal takes over; do not hand focus back to the Settings button
      dlg.close();
      window.ccdash.go(d.project || '_login', d.account || name);
      accounts.load().catch(() => {}); // in the background: the new account shows up in the pickers when it arrives
    } catch (e) {
      if (e.message !== 'unauthorized') acctError('Network error: ' + e.message);
    } finally {
      acctBusy = false; acctSync();
    }
  });

  // ---- Signed-in devices ----
  const sessList = $('sess-list');
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const UNITS = [['day', 86400000], ['hour', 3600000], ['minute', 60000]];

  function rel(ms) {
    const diff = ms - Date.now();
    if (Math.abs(diff) < 60000) return 'just now';
    const [unit, size] = UNITS.find(([, sz]) => Math.abs(diff) >= sz);
    return rtf.format(Math.round(diff / size), unit);
  }

  // "Chrome 126 on Windows" from a User-Agent string; null when nothing is recognised.
  function describeUa(ua) {
    const m = /(Edg|Firefox|Chrome|CriOS|FxiOS|curl)\/(\d+)/.exec(ua);
    const safari = !m && /Safari\//.test(ua) && /Version\/(\d+)/.exec(ua);
    if (!m && !safari) return null;
    const [name, ver] = m ? [m[1], m[2]] : ['Safari', safari[1]];
    const browser = { Edg: 'Edge', CriOS: 'Chrome', FxiOS: 'Firefox' }[name] || name;
    const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux|X11/.test(ua) ? 'Linux' : '';
    return browser + ' ' + ver + (os ? ' on ' + os : '');
  }

  function sessState(msg) { $('sess-state').textContent = msg || ''; $('sess-state').hidden = !msg; }
  function sessError(msg) { $('sess-error').textContent = msg || ''; }

  function sessRow(s) {
    const ua = s.ua || 'Unknown browser';
    const label = describeUa(ua) || (ua.length > 60 ? ua.slice(0, 59) + '…' : ua);
    const head = [h('span', { class: 'sess-ua', title: ua, text: label })];
    if (s.current) head.push(h('span', { class: 'chip chip-done sess-badge', text: 'This device' }));
    const meta = h('dl', { class: 'sess-meta' }, [
      h('div', {}, [h('dt', { text: 'Signed in' }), h('dd', {}, [h('time', { datetime: new Date(s.created).toISOString(), title: new Date(s.created).toLocaleString(), text: rel(s.created) })])]),
      h('div', {}, [h('dt', { text: 'Last seen' }), h('dd', {}, [h('time', { datetime: new Date(s.lastSeen).toISOString(), title: new Date(s.lastSeen).toLocaleString(), text: rel(s.lastSeen) })])]),
      h('div', {}, [h('dt', { text: 'IP' }), h('dd', { class: 'sess-ip', text: s.ip || 'unknown' })]),
    ]);
    const li = h('li', { class: 'sess-row', 'data-testid': 'session-row', 'data-current': s.current ? 'true' : null }, [
      h('div', { class: 'sess-head' }, head), ...(label !== ua ? [h('p', { class: 'sess-ua-full', text: ua })] : []), meta,
    ]);
    if (!s.current) {
      const btn = h('button', { type: 'button', class: 'btn btn-danger sess-revoke', 'data-testid': 'session-revoke', 'aria-label': 'Revoke session: ' + label + ', last seen ' + rel(s.lastSeen), text: 'Revoke' });
      btn.addEventListener('click', () => sessRevoke(s.id, btn));
      li.append(btn);
    }
    return li;
  }

  async function sessLoad(focusSel) {
    sessError('');
    $('sess-confirm').hidden = true;
    if (!sessList.children.length) { sessList.hidden = true; $('sess-actions').hidden = true; sessState('Loading…'); }
    let r;
    try { r = await api('/api/sessions'); } catch (e) { return; }
    if (!r.ok || !r.data || !Array.isArray(r.data.sessions)) {
      sessList.replaceChildren(); sessList.hidden = true; $('sess-actions').hidden = true;
      sessState('');
      sessError('Could not load devices (' + ((r.data && r.data.error) || 'HTTP ' + r.status) + ').');
      return;
    }
    const list = r.data.sessions;
    sessList.replaceChildren(...list.map(sessRow));
    sessList.hidden = !list.length;
    $('sess-actions').hidden = !list.length;
    sessState(list.length ? '' : 'No signed-in devices.');
    if (focusSel) { const t = sessList.querySelector(focusSel) || $('sess-all'); if (t && !t.closest('[hidden]')) t.focus(); }
  }

  async function sessRevoke(id, btn) {
    sessError('');
    btn.disabled = true;
    btn.textContent = 'Revoking…';
    try {
      const r = await api('/api/sessions/revoke', { method: 'POST', body: { id } });
      if (r.ok && r.data && r.data.current) { window.location.assign('/login'); return; }
      if (!r.ok && r.status !== 404) throw new Error((r.data && r.data.error) || 'HTTP ' + r.status);
      await sessLoad('.sess-revoke');
      sessState(r.status === 404 ? 'That device was already signed out.' : 'Device signed out.');
    } catch (e) {
      if (e.message !== 'unauthorized') { sessError('Could not revoke: ' + e.message); btn.disabled = false; btn.textContent = 'Revoke'; }
    }
  }

  $('sess-all').addEventListener('click', () => { $('sess-confirm').hidden = false; $('sess-actions').hidden = true; $('sess-all-no').focus(); });
  $('sess-all-no').addEventListener('click', () => { $('sess-confirm').hidden = true; $('sess-actions').hidden = false; $('sess-all').focus(); });
  $('sess-confirm').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); $('sess-all-no').click(); } });
  $('sess-all-yes').addEventListener('click', async () => {
    const btn = $('sess-all-yes');
    sessError('');
    btn.disabled = true;
    btn.textContent = 'Logging out…';
    try {
      const r = await api('/api/sessions/revoke-all', { method: 'POST', body: {} });
      if (!r.ok) throw new Error((r.data && r.data.error) || 'HTTP ' + r.status);
      window.location.assign('/login');
    } catch (e) {
      if (e.message !== 'unauthorized') sessError('Could not log out everywhere: ' + e.message);
      btn.disabled = false;
      btn.textContent = 'Yes, log out everywhere';
    }
  });

  // ---- Agent kit ----
  // GET /api/kit runs only when the section opens or the user presses Check; update and reset can run up to 10 minutes.
  const kitSec = $('kit-section');
  let kitState = null;
  let kitBusy = false;

  const short = (sha) => (sha ? String(sha).slice(0, 7) : '');
  function kitSetStatus(msg, isError) {
    const el = $('kit-status');
    el.textContent = msg || '';
    el.classList.toggle('is-error', !!isError);
  }
  function kitSync() {
    const s = kitState;
    // aria-disabled (not disabled) keeps focus on the button while busy; handlers guard.
    const set = (id, off) => $(id).setAttribute('aria-disabled', off ? 'true' : 'false');
    set('kit-check', kitBusy);
    set('kit-reset', kitBusy);
    set('kit-update', kitBusy || !(s && s.updateAvailable));
    set('kit-reset-yes', kitBusy);
  }
  function kitPaint() {
    const s = kitState;
    const act = s && s.active;
    $('kit-active').textContent = act ? (act.version || 'unknown version') + (act.sha ? ' (' + short(act.sha) + ')' : '') : 'Unknown';
    const img = s && s.image && s.image.sha;
    $('kit-image').textContent = img && (!act || act.sha !== img) ? short(img) : (img ? 'Same as active' : '');
    $('kit-image').closest('div').hidden = !img;
    const nw = s && s.newest && s.newest.sha;
    $('kit-newest').textContent = nw ? short(nw) + (s.updateAvailable ? ' (update available)' : ' (up to date)') : (s ? 'Unknown' : '');
    const err = $('kit-error');
    err.textContent = s && s.error ? String(s.error) : '';
    err.hidden = !(s && s.error);
    kitSync();
  }
  function kitProblem(r, what) {
    const d = r.data || {};
    if (r.status === 409) return 'The kit is busy (another update or check is running). Try again in a moment.';
    if (r.status === 504) return what + ' timed out. It may still finish; check again in a few minutes.';
    if (r.status === 502 && what === 'The check') return what + ' failed: the kit source could not be reached' + (d.error ? ' (' + d.error + ')' : '') + '.';
    return what + ' failed: ' + (d.message || d.error || 'HTTP ' + r.status) + '.';
  }
  async function kitLoad() {
    if (kitBusy) return;
    kitBusy = true;
    kitSync();
    kitSetStatus('Checking…');
    $('kit-status').prepend(h('span', { class: 'spinner', 'aria-hidden': 'true' }));
    try {
      const r = await api('/api/kit');
      if (!r.ok || !r.data) kitSetStatus(kitProblem(r, 'The check'), true);
      else { kitState = r.data; kitSetStatus(''); }
    } catch (e) {
      if (e.message !== 'unauthorized') kitSetStatus('Network error: ' + e.message, true);
    } finally { kitBusy = false; kitPaint(); }
  }
  function kitShowFailed(list, truncated) {
    const ul = $('kit-failed');
    const bad = (Array.isArray(list) ? list : []).filter((p) => p && p.status === 'failed');
    const rows = bad.map((p) => h('li', {}, [h('strong', { text: String(p.name) }), document.createTextNode(': ' + String(p.message || p.status))]));
    if (truncated) rows.push(h('li', { text: 'The list was truncated; more projects may have failed.' }));
    ul.replaceChildren(...rows);
    ul.hidden = !rows.length;
  }
  async function kitRun(body, what, running, done) {
    if (kitBusy) return;
    kitBusy = true;
    kitSync();
    $('kit-failed').hidden = true;
    kitSetStatus(running + ' This can take up to 10 minutes.');
    $('kit-status').prepend(h('span', { class: 'spinner', 'aria-hidden': 'true' }));
    let ok = false;
    try {
      // No client timeout: the server enforces the 10 minute limit and answers 504.
      const r = await api('/api/kit/update', { method: 'POST', body });
      const d = r.data || {};
      if (!r.ok) {
        kitSetStatus(kitProblem(r, what), true);
      } else {
        ok = true;
        const failed = (d.projects || []).filter((p) => p && p.status === 'failed').length;
        kitSetStatus(done + (d.new ? ' Active kit is now ' + (d.versions && d.versions.new ? d.versions.new : '') + ' (' + short(d.new) + ').' : '')
          + (failed ? ' ' + failed + ' project' + (failed === 1 ? '' : 's') + ' failed.' : ''), failed > 0);
        kitShowFailed(d.projects, d.truncated);
      }
    } catch (e) {
      if (e.message !== 'unauthorized') kitSetStatus('Network error: ' + e.message, true);
    }
    // Only a successful update/reset refreshes state; busy stays true until it is done so clicks cannot overlap.
    try {
      if (ok) {
        const keep = $('kit-status').textContent;
        const keepErr = $('kit-status').classList.contains('is-error');
        try {
          const r = await api('/api/kit');
          if (r.ok && r.data) kitState = r.data;
        } catch { /* keep the last state */ }
        kitPaint();
        kitSetStatus(keep, keepErr);
      }
    } finally {
      kitBusy = false;
      kitPaint();
    }
  }

  kitSec.addEventListener('toggle', () => { if (kitSec.open) kitLoad(); });
  $('kit-check').addEventListener('click', () => { if (kitBusy) return; $('kit-confirm').hidden = true; kitLoad(); });
  $('kit-update').addEventListener('click', () => $('kit-update').getAttribute('aria-disabled') !== 'true' && kitRun({}, 'The update', 'Updating the kit…', 'Kit updated.'));
  $('kit-reset').addEventListener('click', () => { if (kitBusy) return; $('kit-confirm').hidden = false; $('kit-reset-no').focus(); });
  $('kit-reset-no').addEventListener('click', () => { $('kit-confirm').hidden = true; $('kit-reset').focus(); });
  $('kit-confirm').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); $('kit-reset-no').click(); } });
  $('kit-reset-yes').addEventListener('click', async () => {
    if (kitBusy) return;
    $('kit-confirm').hidden = true;
    $('kit-reset').focus();
    await kitRun({ reset: true }, 'The reset', 'Going back to the image version…', 'Back on the image version.');
  });

  // Register the worker early when the user already opted in, so pushes arrive even before the panel is opened.
  if (supported() && Notification.permission === 'granted') {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  }
})();
