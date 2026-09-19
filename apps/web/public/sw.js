/* NEXTDOO service worker — browser push only (PRD §6.6, M8-i1).
 * Receives Web Push messages, displays them as browser notifications, and
 * routes a click to the application destination carried in the payload.
 * No caching, no background sync, no other responsibilities.
 */
self.addEventListener('push', (event) => {
  let data = { title: 'NEXTDOO', body: 'You have a new notification.' };
  try {
    if (event.data) {
      const parsed = event.data.json();
      if (parsed && typeof parsed === 'object') data = { ...data, ...parsed };
    }
  } catch {
    // Malformed payloads degrade to the generic notification.
  }
  const tag = typeof data.tag === 'string' ? data.tag : undefined;
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: typeof data.body === 'string' ? data.body : '',
      tag,
      data: { url: typeof data.url === 'string' ? data.url : '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  const url = new URL(target, self.location.origin).toString();
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        if (new URL(client.url).pathname === new URL(url).pathname) {
          await client.focus();
          return;
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});
