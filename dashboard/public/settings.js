'use strict';
// Notifications settings: Web Push subscribe / unsubscribe and which events to notify about.
(function () {
  const { api, notice } = window.ccdash;
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
    const el = $('notif-error');
    el.textContent = msg || '';
    el.hidden = !msg;
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
    gidDirty = false;
    gidStatus('');
    gidField(gidName, $('gid-name-err'), '');
    gidField(gidEmail, $('gid-email-err'), '');
    gidLoad();
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

  function gidField(input, errEl, msg) {
    errEl.textContent = msg || '';
    errEl.hidden = !msg;
    if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
  }

  function gidStatus(msg, isError) {
    const el = $('gid-status');
    el.textContent = msg || '';
    el.hidden = !msg;
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
    save.textContent = 'Saving…';
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

  // Register the worker early when the user already opted in, so pushes arrive even before the panel is opened.
  if (supported() && Notification.permission === 'granted') {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  }
})();
