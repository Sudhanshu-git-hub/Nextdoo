'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

interface ConnectionView {
  id: string;
  provider: string;
  mode: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'DISCONNECTED';
  externalAccountId: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
}

interface ConflictView {
  mappingId: string;
  local: { taskId: string; title: string; dueAt: string | null };
  external: { externalId: string; title: string | null; startsAt: string | null; endsAt: string | null };
  detectedAt: string | null;
}

function formatWhen(iso: string | null): string {
  if (!iso) return 'unscheduled';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Google Calendar sync (PRD §16, §14.3).
 *
 * The sync mode is chosen BEFORE authorization (PRD §16.2): READ_ONLY
 * imports calendar events; READ_WRITE additionally exports task due times
 * as events. A paused connection (expired/revoked sign-in) shows the
 * reconnect prompt (PRD §16.6). Both-side conflicts list both values with
 * the three PRD §16.4 choices. When the deployment has no Google
 * credentials the section degrades honestly (503 PROVIDER_UNAVAILABLE).
 */
export function CalendarSettings() {
  const searchParams = useSearchParams();
  const [connections, setConnections] = useState<ConnectionView[] | null>(null);
  const [mode, setMode] = useState<'READ_ONLY' | 'READ_WRITE'>('READ_ONLY');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [syncSummary, setSyncSummary] = useState<string | null>(null);

  const marker = searchParams.get('calendar');

  const load = useCallback(async () => {
    try {
      const result = await api<{ connections: ConnectionView[] }>('/calendar/connections');
      setConnections(result.connections);
    } catch {
      setConnections([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (marker === 'connected') setNotice('Google Calendar connected — your calendar is being synced.');
    if (marker?.startsWith('error')) setNotice('Google sign-in could not be completed. Start the connection again.');
  }, [marker]);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ authorizationUrl: string }>('/calendar/connections/google/start', {
        method: 'POST',
        body: JSON.stringify({ mode }),
      });
      window.location.assign(result.authorizationUrl);
    } catch (caught) {
      if (caught instanceof ApiError && caught.problem.detail?.toLowerCase().includes('not configured')) {
        setUnavailable(true);
      } else {
        setError(caught instanceof ApiError ? caught.problem.detail : 'Could not start the calendar connection.');
      }
      setBusy(false);
    }
  }

  async function reconnect(id: string, nextMode: 'READ_ONLY' | 'READ_WRITE' | undefined) {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ authorizationUrl: string }>('/calendar/connections/' + id + '/reconnect', {
        method: 'POST',
        body: JSON.stringify(nextMode ? { mode: nextMode } : {}),
      });
      window.location.assign(result.authorizationUrl);
    } catch (caught) {
      if (caught instanceof ApiError && caught.problem.detail?.toLowerCase().includes('not configured')) {
        setUnavailable(true);
      } else {
        setError(caught instanceof ApiError ? caught.problem.detail : 'Could not start the reconnect.');
      }
      setBusy(false);
    }
  }

  async function syncNow(id: string) {
    setBusy(true);
    setError(null);
    setSyncSummary(null);
    try {
      const s = await api<{ imported: number; conflicts: number; unscheduledTasks: number; exportedCreated: number; exportedUpdated: number; exportedDeleted: number; paused: string | null; rateLimitedSeconds: number | null }>(
        '/calendar/connections/' + id + '/sync',
        { method: 'POST' },
      );
      if (s.paused) {
        setSyncSummary('The connection was paused — reconnect below to continue.');
      } else if (s.rateLimitedSeconds) {
        setSyncSummary('Google is rate-limiting us right now; the next automatic sync will pick up where this left off.');
      } else {
        const parts = [`${s.imported} imported`];
        if (s.exportedCreated || s.exportedUpdated || s.exportedDeleted) {
          parts.push(`${s.exportedCreated + s.exportedUpdated + s.exportedDeleted} event changes`);
        }
        if (s.unscheduledTasks) parts.push(`${s.unscheduledTasks} unscheduled`);
        if (s.conflicts) parts.push(`${s.conflicts} conflict${s.conflicts === 1 ? '' : 's'} to review`);
        setSyncSummary('Synced: ' + parts.join(', ') + '.');
      }
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.problem.detail : 'Sync failed.');
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(id: string) {
    if (!window.confirm('Disconnect this calendar? Your tasks and imported data stay; sync stops immediately.')) return;
    setBusy(true);
    setError(null);
    try {
      await api('/calendar/connections/' + id, { method: 'DELETE' });
      setNotice('Calendar disconnected.');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.problem.detail : 'Could not disconnect.');
    } finally {
      setBusy(false);
    }
  }

  const google = connections?.find((c) => c.provider === 'google') ?? null;

  return (
    <section className="card" aria-labelledby="calendar-heading" data-testid="calendar-card">
      <h2 id="calendar-heading">Calendar</h2>
      {marker === 'connected' && <div className="banner banner-info" role="status">Google Calendar connected — your calendar is being synced.</div>}
      {marker?.startsWith('error') && <div className="banner banner-error" role="alert">Google sign-in could not be completed. Start the connection again.</div>}
      {notice && <div className="banner banner-info" role="status">{notice}</div>}
      {error && <div className="banner banner-error" role="alert">{error}</div>}
      {syncSummary && <div className="banner banner-info" role="status">{syncSummary}</div>}

      {connections === null ? (
        <p role="status" className="muted">Loading…</p>
      ) : google === null ? (
        <>
          <p className="muted">
            Connect Google Calendar to see your busy time in capacity planning and to keep task due times in sync.
          </p>
          {unavailable ? (
            <div className="banner banner-warn" role="status" data-testid="calendar-unconfigured">
              Calendar sync is not configured in this deployment.
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void connect();
              }}
              aria-label="Connect Google Calendar"
            >
              <div className="field" role="radiogroup" aria-label="Sync mode">
                <label htmlFor="cal-mode-ro" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <input
                    id="cal-mode-ro"
                    type="radio"
                    name="cal-mode"
                    checked={mode === 'READ_ONLY'}
                    onChange={() => setMode('READ_ONLY')}
                    style={{ width: 'auto', minHeight: 'auto' }}
                  />
                  Read calendar (imports busy time)
                </label>
                <br />
                <label htmlFor="cal-mode-rw" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <input
                    id="cal-mode-rw"
                    type="radio"
                    name="cal-mode"
                    checked={mode === 'READ_WRITE'}
                    onChange={() => setMode('READ_WRITE')}
                    style={{ width: 'auto', minHeight: 'auto' }}
                  />
                  Read &amp; write (also exports task due times as events)
                </label>
              </div>
              <span className="muted" style={{ fontSize: 12, display: 'block', margin: '6px 0 10px' }}>
                The choice is made before the Google sign-in; changing it later asks Google for a fresh sign-in.
              </span>
              <button type="submit" disabled={busy} data-testid="calendar-connect">
                {busy ? 'Starting…' : 'Connect Google Calendar'}
              </button>
            </form>
          )}
        </>
      ) : (
        <ConnectionPanel
          key={google.id}
          connection={google}
          busy={busy}
          onSync={() => { void syncNow(google.id); }}
          onReconnect={(nextMode) => { void reconnect(google.id, nextMode); }}
          onDisconnect={() => { void disconnect(google.id); }}
          unavailable={unavailable}
        />
      )}
    </section>
  );
}

function ConnectionPanel({
  connection,
  busy,
  onSync,
  onReconnect,
  onDisconnect,
  unavailable,
}: {
  connection: ConnectionView;
  busy: boolean;
  onSync: () => void;
  onReconnect: (nextMode?: 'READ_ONLY' | 'READ_WRITE') => void;
  onDisconnect: () => void;
  unavailable: boolean;
}) {
  const [conflicts, setConflicts] = useState<ConflictView[] | null>(null);
  const [mode, setMode] = useState<'READ_ONLY' | 'READ_WRITE'>(connection.mode === 'READ_WRITE' ? 'READ_WRITE' : 'READ_ONLY');
  const [error, setError] = useState<string | null>(null);

  const loadConflicts = useCallback(async () => {
    try {
      const result = await api<{ conflicts: ConflictView[] }>('/calendar/connections/' + connection.id + '/conflicts');
      setConflicts(result.conflicts);
    } catch {
      setConflicts([]);
    }
  }, [connection.id]);

  useEffect(() => { void loadConflicts(); }, [loadConflicts]);

  async function resolve(mappingId: string, action: 'KEEP_TASK' | 'KEEP_CALENDAR' | 'UNLINK') {
    setError(null);
    try {
      await api('/calendar/connections/' + connection.id + '/conflicts/' + mappingId + '/resolve', {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      await loadConflicts();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.problem.detail : 'Could not resolve the conflict.');
    }
  }

  const statusPill =
    connection.status === 'ACTIVE' ? <span className="pill pill-ok">Connected</span>
    : connection.status === 'SUSPENDED' ? <span className="pill pill-medium">Paused</span>
    : <span className="pill">Disconnected</span>;

  return (
    <>
      <div className="spread" style={{ marginBottom: 8 }}>
        <span>
          Google Calendar {statusPill}
          <span className="muted" style={{ display: 'block', fontSize: 12 }}>
            {connection.externalAccountId ?? 'google'} · {connection.mode}
            {connection.lastSyncedAt ? ` · last synced ${new Date(connection.lastSyncedAt).toLocaleString()}` : ' · not synced yet'}
          </span>
        </span>
      </div>

      {connection.status === 'SUSPENDED' && (
        <div className="banner banner-warn" role="alert" data-testid="calendar-reconnect-prompt">
          <strong>Reconnect your calendar.</strong> The Google sign-in for this connection expired or was revoked. Your
          data is safe; sync is paused until you sign in again.
          <div style={{ marginTop: 8 }}>
            <button className="btn-sm" onClick={() => onReconnect()} disabled={busy} data-testid="calendar-reconnect">
              {busy ? 'Starting…' : 'Reconnect now'}
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0' }}>
        <button className="btn-sm" onClick={onSync} disabled={busy || connection.status !== 'ACTIVE'}>
          {busy ? 'Working…' : 'Sync now'}
        </button>
        <button className="btn-sm" onClick={() => onReconnect()} disabled={busy}>
          Reconnect…
        </button>
        <button
          className="btn-sm"
          style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
          onClick={onDisconnect}
          disabled={busy}
        >
          Disconnect
        </button>
      </div>

      {connection.status === 'ACTIVE' && (
        <div className="field" style={{ marginBottom: 10 }}>
          <label htmlFor="cal-conn-mode" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input
              id="cal-conn-mode"
              type="checkbox"
              checked={mode === 'READ_WRITE'}
              onChange={(e) => setMode(e.target.checked ? 'READ_WRITE' : 'READ_ONLY')}
              style={{ width: 'auto', minHeight: 'auto' }}
            />
            Export task due times as calendar events (read &amp; write)
          </label>
          {mode !== connection.mode && (
            <button className="btn-sm" style={{ marginLeft: 8 }} onClick={() => onReconnect(mode)} disabled={busy}>
              Apply (asks Google again)
            </button>
          )}
        </div>
      )}

      {error && <div className="banner banner-error" role="alert">{error}</div>}

      <h3 style={{ marginTop: 14 }}>Conflicts</h3>
      {conflicts === null ? (
        <p role="status" className="muted">Loading conflicts…</p>
      ) : conflicts.length === 0 ? (
        <p className="muted">No conflicts — NEXTDOO and your calendar agree.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {conflicts.map((c) => (
            <li key={c.mappingId} data-testid="calendar-conflict" style={{ border: '1px solid var(--border, #d0d0d0)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
              <div className="spread">
                <strong>{c.local.title || 'Task'}</strong>
                <span className="muted" style={{ fontSize: 12 }}>both sides changed</span>
              </div>
              <div className="spread" style={{ fontSize: 13, margin: '6px 0' }}>
                <span><strong>NEXTDOO:</strong> {formatWhen(c.local.dueAt)}</span>
                <span><strong>Calendar:</strong> {c.external.title ? `${c.external.title} · ` : ''}{formatWhen(c.external.startsAt)}</span>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button className="btn-sm" onClick={() => { void resolve(c.mappingId, 'KEEP_TASK'); }}>
                  Keep NEXTDOO
                </button>
                <button className="btn-sm" onClick={() => { void resolve(c.mappingId, 'KEEP_CALENDAR'); }}>
                  Keep calendar
                </button>
                <button className="btn-sm" onClick={() => { void resolve(c.mappingId, 'UNLINK'); }}>
                  Unlink
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {unavailable && (
        <div className="banner banner-warn" role="status" data-testid="calendar-unconfigured">
          Calendar sync is not configured in this deployment.
        </div>
      )}
    </>
  );
}
