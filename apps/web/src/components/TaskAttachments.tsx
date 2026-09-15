'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';

/**
 * Task attachments (PRD §6.8): upload → signed PUT → complete → async malware
 * scan → download (blocked until CLEAN) → delete.
 *
 * The browser only ever talks to /api/v1 — never to storage directly. Status
 * changes are announced (aria-live) so the scan outcome is perceivable.
 */

interface AttachmentView {
  id: string;
  taskId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  scanStatus: 'PENDING' | 'CLEAN' | 'INFECTED' | 'FAILED';
  uploadedAt: string | null;
  createdAt: string;
  downloadUrl: string | null;
}

interface AttachmentPage { data: AttachmentView[] }

const STATUS_LABEL: Record<AttachmentView['scanStatus'], string> = {
  PENDING: 'Scanning',
  CLEAN: 'Ready',
  INFECTED: 'Blocked — unsafe file detected',
  FAILED: 'Scan failed',
};

const POLL_MS = 2000;
const POLL_MAX_MS = 90_000;

function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

export function TaskAttachments({ taskId, disabled }: { taskId: string; disabled?: boolean }) {
  const [items, setItems] = useState<AttachmentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const polling = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const page = await api<AttachmentPage>(`/attachments?taskId=${taskId}`, { signal });
      setItems(page.data);
      return page.data;
    } catch (caught) {
      if (signal?.aborted) return null;
      setError(caught instanceof ApiError ? caught.problem.detail : 'Could not load attachments.');
      setItems(null);
      return null;
    }
  }, [taskId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => { controller.abort(); if (polling.current) clearInterval(polling.current); };
  }, [load]);

  const stopPolling = useCallback(() => {
    if (polling.current) { clearInterval(polling.current); polling.current = null; }
  }, []);

  const startPolling = useCallback(async () => {
    stopPolling();
    const startedAt = Date.now();
    polling.current = setInterval(async () => {
      const rows = await load();
      if (!rows) { stopPolling(); return; }
      if (rows.every((r) => r.scanStatus !== 'PENDING') || Date.now() - startedAt > POLL_MAX_MS) {
        stopPolling();
        setUploading(null);
      }
    }, POLL_MS);
  }, [load, stopPolling]);

  async function uploadFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const auth = await api<{ attachment: AttachmentView; uploadUrl: string }>(
        '/attachments',
        { method: 'POST', body: JSON.stringify({ taskId, fileName: file.name, contentType: file.type, sizeBytes: file.size }) },
      );
      const put = await fetch(auth.uploadUrl, {
        method: 'PUT',
        headers: { 'Idempotency-Key': crypto.randomUUID(), 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!put.ok) {
        const problem = await put.json().catch(() => null);
        throw new ApiError((problem as never) ?? { type: 'about:blank', title: 'Upload failed', status: put.status, code: 'INTERNAL_ERROR', detail: 'The file could not be uploaded.' });
      }
      await api(`/attachments/${auth.attachment.id}`, { method: 'POST', body: '{}' });
      await load();
      setUploading(auth.attachment.fileName);
      void startPolling();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.problem.detail : 'Upload failed.');
      stopPolling();
      setUploading(null);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function remove(item: AttachmentView) {
    if (!window.confirm(`Delete "${item.fileName}"? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/attachments/${item.id}`, { method: 'DELETE' });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.problem.detail : 'Delete failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="task-attachments">
      <h3>Attachments</h3>
      <label htmlFor="task-attachment-file">Upload a file</label>
      <input
        ref={fileRef}
        type="file"
        id="task-attachment-file"
        aria-describedby="task-attachment-help"
        disabled={disabled || busy}
        onChange={(e) => { const file = e.target.files?.[0]; if (file) void uploadFile(file); }}
      />
      <p id="task-attachment-help" className="muted">
        Files are scanned for malware before they can be downloaded. Downloads are blocked until the scan is clean.
      </p>
      {error && <p role="alert" style={{ color: 'var(--danger, #b00020)' }}>{error}</p>}
      {items === null ? (
        <p role="status">Loading attachments…</p>
      ) : items.length === 0 ? (
        <p className="muted">No attachments yet.</p>
      ) : (
        <ul role="list" style={{ listStyle: 'none', padding: 0 }}>
          {items.map((item) => (
            <li key={item.id} className="row" style={{ justifyContent: 'space-between', gap: 12, marginTop: 8 }}>
              <span>
                <strong>{item.fileName}</strong>{' '}
                <span className="muted">({humanSize(item.sizeBytes)})</span>{' '}
                <span
                  className={`pill${item.scanStatus === 'CLEAN' ? ' pill-ok' : item.scanStatus === 'INFECTED' ? ' pill-high' : item.scanStatus === 'FAILED' ? ' pill-medium' : ' pill-scan-pending'}`}
                  aria-label={`Scan status: ${STATUS_LABEL[item.scanStatus]}`}
                  aria-live="polite"
                >
                  {uploading === item.fileName && item.scanStatus === 'PENDING' ? 'Uploading…' : STATUS_LABEL[item.scanStatus]}
                </span>
              </span>
              <span className="row" style={{ gap: 8 }}>
                {item.downloadUrl && <a className="btn-ghost btn-sm" href={item.downloadUrl} download={item.fileName}>Download</a>}
                <button type="button" className="btn-ghost btn-sm" disabled={busy || uploading !== null} onClick={() => void remove(item)}>Delete</button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
