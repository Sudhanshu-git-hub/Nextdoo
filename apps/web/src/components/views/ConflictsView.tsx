'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { flushQueue, getDeviceId, listQueued, requeueMutation, type QueuedMutation } from '@/lib/offline-queue';
import { useWorkspace } from '@/components/WorkspaceContext';

interface ConflictSnapshot {
  id: string;
  entityType: string;
  entityId: string;
  deviceId: string | null;
  localPayload: Record<string, unknown>;
  serverPayload: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
}
interface ConflictsResponse { data: ConflictSnapshot[] }

const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  description: 'Description',
  location: 'Location',
  dueAt: 'Due date',
  estimateMinutes: 'Estimate (min)',
  priority: 'Priority',
  status: 'Status',
  projectId: 'Project',
  sectionId: 'Section',
  position: 'Position',
  completedAt: 'Completed at',
};

function ConflictsView() {
  const { id: workspaceId, timeZone } = useWorkspace();
  const deviceId = useRef(getDeviceId());
  const [conflicts, setConflicts] = useState<ConflictSnapshot[] | null>(null);
  const [attention, setAttention] = useState<QueuedMutation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null); // `${id}:${resolution}`
  const [retrying, setRetrying] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());
  const request = useRef<AbortController | null>(null);

  const date = useCallback((s: string) => new Date(s).toLocaleString(undefined, { timeZone }), [timeZone]);
  const value = useCallback((v: unknown): string => {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'string') {
      const asDate = Date.parse(v);
      if (/^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(asDate)) return new Date(v).toLocaleString(undefined, { timeZone });
      return v;
    }
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return JSON.stringify(v);
  }, [timeZone]);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [list, queued] = await Promise.all([
        api<ConflictsResponse>('/sync/conflicts', { signal }),
        listQueued(workspaceId, true).then((all) => all.filter((m) => m.quarantined)),
      ]);
      if (signal?.aborted) return;
      setConflicts(list.data);
      setAttention(queued);
    } catch (e) {
      if (signal?.aborted) return;
      setError(e instanceof ApiError ? e.problem.detail : 'Could not load conflicts. Your changes are kept locally; retry when connected.');
    }
  }, [workspaceId]);

  useEffect(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    void load(controller.signal);
    const onSynced = () => { request.current?.abort(); const c = new AbortController(); request.current = c; void load(c.signal); };
    window.addEventListener('nextdoo-synced', onSynced);
    window.addEventListener('nextdoo-queue-changed', onSynced);
    return () => { controller.abort(); request.current?.abort(); window.removeEventListener('nextdoo-synced', onSynced); window.removeEventListener('nextdoo-queue-changed', onSynced); };
  }, [load]);

  /** Stable identity per (conflict, choice): a lost acknowledgement retried
   *  with the same key replays the original server acknowledgement. */
  async function resolve(snapshot: ConflictSnapshot, resolution: 'local' | 'server') {
    const identity = `${snapshot.id}:${resolution}`;
    if (resolving || !keys.current.has(identity)) keys.current.set(identity, crypto.randomUUID());
    setResolving(identity);
    setError(null);
    setMessage(null);
    try {
      await api(`/sync/conflicts/${snapshot.id}/resolve`, {
        method: 'POST',
        headers: { 'Idempotency-Key': keys.current.get(identity)! },
        body: JSON.stringify({ resolution }),
      });
      keys.current.delete(identity);
      setMessage(resolution === 'local' ? 'Resolved: your version was kept.' : 'Resolved: the server version was kept.');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.problem.detail : 'The resolution was not acknowledged. It was not lost — an unchanged retry uses the same identity.');
    } finally {
      setResolving(null);
    }
  }

  async function retry(m: QueuedMutation) {
    if (retrying) return;
    setRetrying(m.mutationId);
    setError(null);
    setMessage(null);
    try {
      await requeueMutation(workspaceId, m.mutationId);
      const result = await flushQueue(workspaceId, deviceId.current);
      setMessage(result.applied > 0 ? 'Change re-sent and acknowledged.' : 'Change re-sent; the server could not apply it yet. It stays in your needs-attention list with its full content.');
      await load();
    } catch {
      setError('The retry was not acknowledged. The change is kept locally; retry again when connected.');
    } finally {
      setRetrying(null);
    }
  }

  return <div className="conflicts-view">
    <div className="page-head"><div><h1>Sync conflicts</h1>
      <p className="subtitle">Side-by-side versions of changes that could not be applied automatically · {timeZone}</p></div></div>
    <p>Nextdoo never silently discards your work: when two devices change the same free-text field, or an edit arrives for a task that was deleted elsewhere, the losing version is preserved here for 30 days and you choose which one stands.</p>
    {error && <p className="banner banner-error" role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}

    <section aria-labelledby="conflicts-heading">
      <h2 id="conflicts-heading">Conflicts to resolve</h2>
      {conflicts === null && <p role="status" aria-live="polite">Loading conflicts…</p>}
      {conflicts !== null && !conflicts.length && <p>No conflicts — every change applied cleanly.</p>}
      {conflicts?.map((c) => {
        const title = typeof c.serverPayload.title === 'string' ? c.serverPayload.title
          : typeof c.localPayload.title === 'string' ? c.localPayload.title : 'Untitled task';
        const fields = Object.keys(c.localPayload);
        const cardBusy = resolving?.startsWith(`${c.id}:`) ?? false;
        return <article className="card" key={c.id} data-conflict-id={c.id} style={{ marginTop: 12 }}>
          <h3>{title}</h3>
          <p className="muted">Change from device <code>{c.deviceId ?? 'unknown'}</code> · captured {date(c.createdAt)} · recoverable until {date(c.expiresAt)}</p>
          <table className="conflict-table">
            <caption className="sr-only">Side-by-side comparison of your version and the server version for {title}</caption>
            <thead><tr><th scope="col">Field</th><th scope="col">Your version</th><th scope="col">Server version</th></tr></thead>
            <tbody>
              {fields.map((f) => <tr key={f} data-conflict-field={f}>
                <th scope="row">{FIELD_LABELS[f] ?? f}</th>
                <td data-local-value>{value(c.localPayload[f])}</td>
                <td data-server-value>{value(c.serverPayload[f])}</td>
              </tr>)}
            </tbody>
          </table>
          <p className="muted">“Your version” is what this device sent; “Server version” is what stands on the account right now.</p>
          <div className="conflict-actions">
            <button disabled={cardBusy} onClick={() => void resolve(c, 'local')} aria-label={`Keep your version of ${title}`}>Keep my version</button>
            <button disabled={cardBusy} onClick={() => void resolve(c, 'server')} aria-label={`Keep the server version of ${title}`}>Keep server version</button>
          </div>
          {cardBusy && <p role="status">Applying your choice…</p>}
        </article>;
      })}
    </section>

    <section aria-labelledby="attention-heading" style={{ marginTop: 24 }}>
      <h2 id="attention-heading">Local changes needing attention</h2>
      <p>Changes this device could not get acknowledged after repeated attempts. Their full content is kept below — retry sends the exact same change again (never a duplicate).</p>
      {attention === null && <p role="status" aria-live="polite">Loading local changes…</p>}
      {attention !== null && !attention.length && <p>Nothing needs attention on this device.</p>}
      {attention?.map((m) => <article className="card" key={m.mutationId} data-attention-mutation={m.mutationId} style={{ marginTop: 12 }}>
        <h3>{m.operation} · {typeof m.payload.title === 'string' ? m.payload.title : 'change'}</h3>
        <p className="muted">{m.lastError ?? 'Waiting to sync'} · queued {m.createdAt}</p>
        <details><summary>Full saved content</summary><pre>{JSON.stringify(m.payload, null, 2)}</pre></details>
        <button disabled={retrying !== null && retrying !== m.mutationId} onClick={() => void retry(m)} aria-label={`Retry now — resend the saved ${m.operation} change`}>Retry now</button>
      </article>)}
    </section>

    {conflicts !== null && attention !== null && !conflicts.length && !attention.length && (
      <p style={{ marginTop: 24 }}>Everything is in sync. <Link href="/today">Back to Today</Link></p>
    )}
  </div>;
}

export { ConflictsView };
