'use strict';
// Push only: no fetch handling, no caching. The payload is { project, status }; the text shown
// comes from a fixed map here, never from the payload.
const BODY = {
  needs_approval: 'Needs your approval',
  error: 'Hit an error',
  waiting: 'Finished, waiting for you',
};

self.addEventListener('push', (event) => {
  let data = null;
  try { data = event.data ? event.data.json() : null; } catch { data = null; }
  const project = data && typeof data.project === 'string' && data.project ? data.project.slice(0, 100) : 'ccdash';
  const status = data && Object.hasOwn(BODY, data.status) ? data.status : null;
  if (!status) return;
  event.waitUntil(self.registration.showNotification(project, { body: BODY[status], tag: `${project}:${status}` }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if (new URL(c.url).pathname === '/' && 'focus' in c) return c.focus(); }
    return self.clients.openWindow('/');
  })());
});
