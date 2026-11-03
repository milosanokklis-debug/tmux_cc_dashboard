'use strict';
const form = document.getElementById('login');
const errorEl = document.getElementById('error');

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  errorEl.textContent = '';
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const res = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CCDash': '1' },
      credentials: 'same-origin',
      body: JSON.stringify({
        username: form.username.value,
        password: form.password.value,
      }),
    });
    if (res.ok) { window.location.assign('/'); return; }
    const data = await res.json().catch(() => ({}));
    errorEl.textContent = data.error || 'Sign in failed.';
    form.password.value = '';
    form.password.focus();
  } catch {
    errorEl.textContent = 'Network error. Try again.';
  } finally {
    button.disabled = false;
  }
});
