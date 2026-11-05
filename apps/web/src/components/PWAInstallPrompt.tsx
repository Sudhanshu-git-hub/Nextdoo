'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Phase 1 PWA install prompt.
 *
 * Listens for the browser's `beforeinstallprompt` event (fires when the app
 * is installable) and shows a dismissible banner with an Install button.
 * After installation, the `appinstalled` event dismisses the banner.
 *
 * This never auto-prompts — the user must tap Install. Browsers that do not
 * fire `beforeinstallprompt` (e.g. desktop Chrome without install criteria)
 * simply never show the banner.
 */

interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function PWAInstallPrompt() {
  const [installable, setInstallable] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const deferredRef = useRef<InstallEvent | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Already installed? Don't show the prompt.
    if (window.matchMedia('(display-mode: standalone)').matches) {
      return;
    }

    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      deferredRef.current = event as InstallEvent;
      setInstallable(true);
    };

    const onAppInstalled = () => {
      setInstallable(false);
      setDismissed(true);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  async function install() {
    const event = deferredRef.current;
    if (!event) return;
    await event.prompt();
    await event.userChoice;
    setInstallable(false);
    setDismissed(true);
  }

  if (!installable || dismissed) return null;

  return (
    <div className="pwa-install" role="dialog" aria-label="Install NEXTDOO">
      <span className="pwa-install-icon" aria-hidden="true">⬇</span>
      <span className="pwa-install-text">Install NEXTDOO for a faster, offline-capable experience.</span>
      <button className="btn-primary btn-sm" onClick={() => void install()}>
        Install
      </button>
      <button className="btn-ghost btn-sm" aria-label="Dismiss install prompt" onClick={() => setDismissed(true)}>
        ✕
      </button>
    </div>
  );
}
