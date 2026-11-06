'use strict';
const form = document.getElementById('login');
const errorEl = document.getElementById('error');

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  errorEl.textContent = '';
  form.password.removeAttribute('aria-invalid');
  form.password.removeAttribute('aria-describedby');
  const button = form.querySelector('button');
  button.disabled = true;
  form.setAttribute('aria-busy', 'true');
  button.textContent = 'Signing in…';
  try {
    const res = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CCDash': '1' },
      credentials: 'same-origin',
      body: JSON.stringify({
        username: form.username.value,
        password: form.password.value,
        code: form.code.value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.enroll) { startEnroll(); return; }
    if (res.ok) { window.location.assign('/'); return; }
    if (data.totp) {
      document.getElementById('codebox').hidden = false;
      form.code.focus();
      errorEl.textContent = data.error || '';
      return;
    }
    errorEl.textContent = data.error || 'Sign in failed.';
    form.password.value = '';
    form.password.setAttribute('aria-invalid', 'true');
    form.password.setAttribute('aria-describedby', 'error');
    form.password.focus();
  } catch {
    errorEl.textContent = 'Network error. Try again.';
  } finally {
    button.disabled = false;
    form.removeAttribute('aria-busy');
    button.textContent = 'Sign in';
  }
});

const H = { 'Content-Type': 'application/json', 'X-CCDash': '1' };
async function startEnroll() {
  form.hidden = true;
  const en = document.getElementById('enroll');
  en.hidden = false;
  const r = await fetch('/api/totp/enroll', { credentials: 'same-origin' });
  const d = await r.json().catch(() => ({}));
  document.getElementById('qr').innerHTML = d.qrSvg || ''; // server-generated SVG
  en.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const res = await fetch('/api/totp/enroll', { method: 'POST', headers: H, credentials: 'same-origin', body: JSON.stringify({ code: en.ecode.value }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { document.getElementById('eerror').textContent = data.error || 'Failed.'; return; }
    const pre = document.getElementById('recovery');
    pre.textContent = `Recovery codes (shown once):\n${data.recovery.join('\n')}`;
    pre.hidden = false;
    en.querySelector('button[type=submit]').hidden = true;
    const done = document.getElementById('done');
    done.hidden = false;
    done.onclick = () => window.location.assign('/');
  });
}
