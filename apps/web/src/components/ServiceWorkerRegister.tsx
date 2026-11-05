'use client';

import { useEffect } from 'react';

/**
 * Phase 1 PWA service-worker registration.
 *
 * Registers /sw.js on every page load so the PWA app shell (static assets +
 * cached navigation) works across the whole site — not only when the user
 * enables browser push (which also registers the SW, but only from Settings).
 *
 * Fails soft: unsupported browsers and registration errors are silently
 * ignored. The SW handles push notifications, app-shell caching, and offline
 * fallback; this component only ensures it is loaded.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    // Skip registration during E2E test runs to avoid caching interfering
    // with Playwright's request interception.
    if (navigator.webdriver) return;

    // Register after the page loads so it never blocks initial render.
    const onLoad = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* silent — SW is an enhancement, not a requirement */
      });
    };
    if (document.readyState === 'complete') onLoad();
    else window.addEventListener('load', onLoad, { once: true });
  }, []);

  return null;
}
