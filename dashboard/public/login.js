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
const $ = (id) => document.getElementById(id);
let enrollBound = false;

// qrSvg is server-generated. The page CSP forbids data: images, so it is inlined, but only after it is parsed and
// rebuilt from an allowlist of SVG shape elements and plain presentation attributes (no scripts, links, styles or handlers).
const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'g', 'path', 'rect']);
const SVG_ATTRS = new Set(['viewBox', 'preserveAspectRatio', 'd', 'x', 'y', 'width', 'height', 'fill', 'stroke', 'stroke-width', 'transform', 'shape-rendering', 'fill-rule']);
function safeSvg(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.localName !== 'svg' || doc.querySelector('parsererror')) throw new Error('invalid code image');
  const copy = (src) => {
    const el = document.createElementNS(SVG_NS, src.localName);
    for (const a of src.attributes) if (SVG_ATTRS.has(a.name) && !/url\(|javascript:/i.test(a.value)) el.setAttribute(a.name, a.value);
    for (const c of src.children) if (SVG_TAGS.has(c.localName)) el.append(copy(c));
    return el;
  };
  const svg = copy(root);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  return svg;
}

async function startEnroll() {
  form.hidden = true;
  const en = $('enroll');
  en.hidden = false;
  $('enroll-h').tabIndex = -1;
  $('enroll-h').focus();
  try {
    const r = await fetch('/api/totp/enroll', { credentials: 'same-origin', headers: { 'X-CCDash': '1' } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || typeof d.qrSvg !== 'string') throw new Error(d.error || 'HTTP ' + r.status);
    $('qr').replaceChildren(safeSvg(d.qrSvg));
    $('qr').hidden = false;
    $('uri').value = d.uri || '';
    $('manual').hidden = !d.uri;
    $('qr-status').hidden = true;
    $('ecode').focus();
  } catch (e) {
    $('qr-status').textContent = 'Could not load the setup code (' + e.message + '). Reload the page and sign in again.';
    $('qr-status').setAttribute('role', 'alert');
    return;
  }
  if (enrollBound) return;
  enrollBound = true;
  en.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = $('esubmit');
    $('eerror').textContent = '';
    $('ecode').removeAttribute('aria-invalid');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      const res = await fetch('/api/totp/enroll', { method: 'POST', headers: H, credentials: 'same-origin', body: JSON.stringify({ code: en.ecode.value.trim() }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(data.recovery)) {
        $('eerror').textContent = data.error || 'Failed. Try again.';
        $('ecode').setAttribute('aria-invalid', 'true');
        $('ecode').select();
        return;
      }
      showRecovery(data.recovery);
    } catch {
      $('eerror').textContent = 'Network error. Try again.';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Enable and sign in';
    }
  });
}

function showRecovery(codes) {
  const text = codes.join('\n');
  $('recovery').textContent = text;
  $('enroll-setup').hidden = true;
  $('enroll-done').hidden = false;
  $('enroll-h').textContent = 'Recovery codes';
  $('enroll-h').focus();
  $('copy').onclick = async () => {
    const status = $('copy-status');
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = 'Copied.';
    } catch {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents($('recovery'));
      sel.removeAllRanges();
      sel.addRange(range);
      status.textContent = 'Could not copy automatically. The codes are selected: copy them yourself.';
    }
  };
  $('done').onclick = () => window.location.assign('/');
}
