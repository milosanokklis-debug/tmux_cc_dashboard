'use strict';
// Notifications settings: Web Push subscribe / unsubscribe and which events to notify about.
(function () {
  const { api, h, notice } = window.ccdash;
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

  // Register the worker early when the user already opted in, so pushes arrive even before the panel is opened.
  if (supported() && Notification.permission === 'granted') {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  }
})();
