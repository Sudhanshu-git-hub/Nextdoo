'use client';

import { useEffect, useState } from 'react';
import { pendingCount, refreshCount } from '@/lib/offline-queue';

/**
 * Offline state indicator (PRD §8.6).
 * Non-blocking and always shows how many changes are waiting, so the user
 * knows nothing has been lost.
 */
export function OfflineBadge({ workspaceId }: { workspaceId: string }) {
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    void refreshCount(workspaceId).catch(() => {});
    const poll = setInterval(() => setPending(pendingCount(workspaceId)), 1500);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      clearInterval(poll);
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, [workspaceId]);

  if (online && pending === 0) return null;

  return (
    <div className="offline-badge" role="status" aria-live="polite">
      {online ? `Syncing ${pending} change${pending === 1 ? '' : 's'}…` : `Offline — ${pending} change${pending === 1 ? '' : 's'} queued`}
    </div>
  );
}
