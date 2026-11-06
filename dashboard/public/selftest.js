(function () {
  'use strict';
  // Warning badge for `ccd doctor --live` mismatches (never an error: the install is unaffected).
  const { api } = window.ccdash;
  const badge = document.getElementById('selftest-badge');
  api('/api/selftest').then((r) => {
    const w = r.ok && r.data && Array.isArray(r.data.warnings) ? r.data.warnings : [];
    if (!w.length) return;
    badge.textContent = `Self-test: ${w.length} warning${w.length === 1 ? '' : 's'}`;
    badge.title = w.map((x) => `${x.check}: ${x.detail}`).join('\n');
    badge.hidden = false;
  }).catch(() => {});
})();
