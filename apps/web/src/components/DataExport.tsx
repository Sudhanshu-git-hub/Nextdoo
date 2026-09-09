'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';

/**
 * Asynchronous data export (PRD §7.10, §14, §18.1). Requests a CSV/JSON
 * archive of tracking events, execution results and daily/weekly rollups;
 * the worker generates it and the download link stays available for 24 hours.
 */

interface ExportItem {
  id: string;
  format: string;
  status: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED' | 'EXPIRED';
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  sizeBytes: number | null;
  error: string | null;
  downloadUrl: string | null;
}

interface ExportPage {
  data: ExportItem[];
  pagination: { next_cursor: string | null; has_more: boolean };
}

const STATUS_LABEL: Record<ExportItem['status'], string> = {
  PENDING: 'Queued',
  PROCESSING: 'Generating',
  READY: 'Ready',
  FAILED: 'Failed',
  EXPIRED: 'Expired',
};

const POLL_MS = 10_000;

export function DataExport({ exportsPerDay }: { exportsPerDay: number | null }) {
  const [items, setItems] = useState<ExportItem[] | null>(null);
  const [format, setFormat] = useState<'json' | 'csv'>('json');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const page = await api<ExportPage>('/exports');
      setItems(page.data);
      return page.data;
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.problem.detail : 'Could not load your exports.');
      setItems(null);
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Refresh while any export is still in flight and the tab is visible.
  useEffect(() => {
    if (!items?.some((i) => i.status === 'PENDING' || i.status === 'PROCESSING')) return;
    const tick = () => {
      timer.current = setTimeout(async () => {
        if (!document.hidden) {
          const next = await load();
          if (next?.some((i) => i.status === 'READY')) setNotice('Your export is ready to download.');
        }
        tick();
      }, POLL_MS);
    };
    tick();
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [items, load]);

  async function request(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api<ExportItem>('/exports', { method: 'POST', body: JSON.stringify({ format }) });
      setNotice('Export requested — it is generated in the background.');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.problem.detail : 'Could not request the export.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="data-export-heading">
      <h2 id="data-export-heading">Data export</h2>
      <p className="muted" style={{ marginBottom: 12 }}>
        Generates a CSV or JSON archive of your tracking events, execution results and daily/weekly rollups.
        Each download link stays available for 24 hours, then the file is removed.
      </p>

      {exportsPerDay !== null && (
        <p className="muted" style={{ marginBottom: 10 }}>
          Your plan allows {exportsPerDay} export per day.
        </p>
      )}

      <form onSubmit={request} className="spread" style={{ marginBottom: 12, alignItems: 'flex-end' }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="export-format">Format</label>
          <select
            id="export-format"
            value={format}
            onChange={(e) => setFormat(e.target.value === 'csv' ? 'csv' : 'json')}
            disabled={busy}
          >
            <option value="json">JSON</option>
            <option value="csv">CSV</option>
          </select>
        </div>
        <button type="submit" disabled={busy}>{busy ? 'Requesting…' : 'Request export'}</button>
      </form>

      <div aria-live="polite">
        {notice && <div className="banner banner-info" role="status" style={{ marginBottom: 10 }}>{notice}</div>}
        {error && <div className="banner banner-error" role="alert" style={{ marginBottom: 10 }}>{error}</div>}
      </div>

      {items === null ? (
        <p className="muted">Loading your exports…</p>
      ) : items.length === 0 ? (
        <p className="muted">You have not requested an export yet.</p>
      ) : (
        <table>
          <caption className="visually-hidden">Your requested exports and their status</caption>
          <thead>
            <tr>
              <th scope="col">Requested</th>
              <th scope="col">Format</th>
              <th scope="col">Status</th>
              <th scope="col"><span className="visually-hidden">Action</span></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} data-export-status={item.status}>
                <td>{new Date(item.createdAt).toLocaleString()}</td>
                <td style={{ textTransform: 'uppercase' }}>{item.format}</td>
                <td>
                  {STATUS_LABEL[item.status]}
                  {item.status === 'FAILED' && item.error && (
                    <span className="muted"> · {item.error}</span>
                  )}
                  {item.status === 'READY' && item.expiresAt && (
                    <span className="muted"> · until {new Date(item.expiresAt).toLocaleString()}</span>
                  )}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {item.downloadUrl ? (
                    <a className="btn-sm" href={item.downloadUrl} data-export-download={item.id}>
                      Download
                    </a>
                  ) : item.status === 'PENDING' || item.status === 'PROCESSING' ? (
                    <span className="muted">Preparing…</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
