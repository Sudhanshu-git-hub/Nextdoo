/* NEXTDOO service worker — PWA shell caching + browser push (PRD §6.6, M8-i1).
 *
 * Responsibilities:
 *   1. App shell caching: static assets (cache-first), navigation requests
 *      (network-first with offline fallback to the cached shell). This lets
 *      the installed app open and show its UI even without a connection;
 *      the in-app IndexedDB offline queue handles data, not the shell.
 *   2. Browser push: receive Web Push messages, display notifications,
 *      route clicks to the application destination.
 *   3. No background sync — the client-side offline queue already owns that.
 *
 * The SW is registered globally (not only for push) so the PWA shell works
 * on every visit. Caching is versioned: bumping VERSION forces a fresh
 * activation that replaces old caches.
 */

const VERSION = 'pwa-v1';
const SHELL_CACHE = 'nextdoo-shell-' + VERSION;
const STATIC_CACHE = 'nextdoo-static-' + VERSION;

/** App shell entry points to precache on install. */
const SHELL_URLS = ['/', '/login'];

/* ----------------------------- install / activate ----------------------------- */

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // addAll follows redirects; use allSettled so one failure doesn't abort the rest.
      .then((cache) => Promise.allSettled(SHELL_URLS.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== STATIC_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/* ---------------------------------- fetch ---------------------------------- */

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GET requests.
  if (url.origin !== self.location.origin || request.method !== 'GET') return;

  // API calls always hit the network — never cache API responses.
  if (url.pathname.startsWith('/api/')) return;

  // Static assets (JS, CSS, icons, SW itself): cache-first, network fallback.
  if (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/sw.js'
  ) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          // Only cache successful, basic responses (not redirects or errors).
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      }),
    );
    return;
  }

  // Navigation requests: network-first, fall back to the cached shell when offline.
  if (request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/login') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Cache a copy of the successful navigation response for offline use.
          if (response.ok) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match('/')),
        ),
    );
  }
});

/* ------------------------------------ push ------------------------------------ */

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
