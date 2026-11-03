'use strict';
document.getElementById('logout').addEventListener('click', async () => {
  const res = await fetch('/logout', {
    method: 'POST',
    headers: { 'X-CCDash': '1' },
    credentials: 'same-origin',
  }).catch(() => null);
  if (res && res.ok) window.location.assign('/login');
  else document.getElementById('error').textContent = 'Sign out failed.';
});
