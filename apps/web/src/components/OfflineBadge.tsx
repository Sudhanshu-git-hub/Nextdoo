'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { getDeviceId } from '@/lib/offline-queue';
import { useSyncReconcile } from '@/lib/use-sync-reconcile';

/**
 * Offline state indicator (PRD §8.6) and the app-global reconcile loop.
 *
 * The queue must drain on every view, not just Today, so the loop lives in
 * the shell: it recovers on mount, drains on reconnect, on new work arriving
 * while online, and per stored backoff. Views react to `nextdoo-synced` to
 * refresh their own data.
 */
export function OfflineBadge({ workspaceId }: { workspaceId: string }) {
  const [online, setOnline] = useState(true);
  const deviceId = useMemo(() => getDeviceId(), []);
  const { queued, attention } = useSyncReconcile(workspaceId, deviceId, () => {});

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  if (online && queued === 0 && attention === 0) return null;

  const word = (n: number) => (n === 1 ? 'change' : 'changes');
  return (
    <div className="offline-badge" role="status" aria-live="polite">
      {online ? `Syncing ${queued} ${word(queued)}…` : `Offline — ${queued} ${word(queued)} queued`}
      {attention > 0 && (
        <>
          {' · '}
          <Link href="/conflicts">{attention} {word(attention)} need attention — review</Link>
        </>
      )}
    </div>
  );
}
