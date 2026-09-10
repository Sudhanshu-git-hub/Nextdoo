'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { earliestRetryAt, pendingSummary, reconcileOnce, type ReconcileResult } from './offline-queue';

/**
 * Reconcile loop (PRD §10.3/§10.8) — one per mounted view.
 *
 *  - recovers on mount (a reload/crash must not strand the queue),
 *  - drains when new work arrives online (a lost response is enqueued, not
 *    left in a dead-end error),
 *  - drains on `online` and when the tab becomes visible,
 *  - reschedules failures at the stored backoff (1 s to 5 min with jitter,
 *    already computed by the queue; quarantined items never auto-retry),
 *  - never loops hot: after a pass with nothing due, it waits for an event.
 *
 * `onSynced` fires after any pass that applied mutations or pulled changes,
 * so the view can refresh from the server (or its cached fallback).
 */
const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 300000;

export function useSyncReconcile(
  workspaceId: string,
  deviceId: string,
  onSynced: () => void,
): { queued: number; attention: number } {
  const [summary, setSummary] = useState({ queued: 0, attention: 0 });
  const onSyncedRef = useRef(onSynced);
  onSyncedRef.current = onSynced;
  const busyRef = useRef(false);
  const baselineRef = useRef<number | null>(null);

  /** Updates the visible counts; reports whether new work was enqueued. */
  const observe = useCallback(async (): Promise<boolean> => {
    const next = await pendingSummary(workspaceId).catch(() => null);
    if (!next) return false;
    const total = next.queued + next.attention;
    const grew = baselineRef.current !== null && total > baselineRef.current;
    baselineRef.current = total;
    setSummary(next);
    return grew;
  }, [workspaceId]);

  const attempt = useCallback(async (): Promise<ReconcileResult | null> => {
    if (busyRef.current || !workspaceId) return null;
    busyRef.current = true;
    try {
      if (!navigator.onLine) {
        await observe();
        return null;
      }
      const result = await reconcileOnce(workspaceId, deviceId).catch(() => null);
      await observe();
      if (result && (result.applied > 0 || result.pulledChanges > 0 || result.pulledDeletions > 0)) {
        // Views refresh their data from this; it also fires outside the view
        // that owns the loop (the loop is app-global, mounted in the shell).
        window.dispatchEvent(new CustomEvent('nextdoo-synced'));
        onSyncedRef.current();
      }
      return result;
    } finally {
      busyRef.current = false;
    }
  }, [workspaceId, deviceId, observe]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const scheduleNext = async () => {
      if (stopped) return;
      const due = await earliestRetryAt(workspaceId).catch(() => null);
      if (stopped) return;
      if (due === null) return; // nothing retryable — wait for an event
      // While offline the stored backoff never advances; re-check lazily.
      if (!navigator.onLine) {
        timer = setTimeout(() => { void run(); }, MAX_DELAY_MS);
        return;
      }
      const delay = Math.min(Math.max(due - Date.now(), MIN_DELAY_MS), MAX_DELAY_MS);
      timer = setTimeout(() => { void run(); }, delay);
    };

    const run = async () => {
      await attempt();
      void scheduleNext();
    };
    const onOnline = () => { void run(); };
    const onVisibility = () => { if (document.visibilityState === 'visible') void run(); };
    // A growing queue means new work arrived (capture, lost response): sync
    // it now when we can. Shrinking or failed-again queues just re-render the
    // counts — never an immediate hot retry.
    const onQueueChanged = () => {
      void observe().then((grew) => { if (grew && navigator.onLine && !stopped) void run(); });
    };

    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('nextdoo-queue-changed', onQueueChanged);
    void run(); // recovery on mount
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('nextdoo-queue-changed', onQueueChanged);
    };
  }, [workspaceId, attempt, observe]);

  return summary;
}
