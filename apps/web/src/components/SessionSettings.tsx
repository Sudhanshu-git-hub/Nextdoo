'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';

interface SessionRow {
  id: string;
  deviceLabel: string | null;
  lastSeenAt: string;
  createdAt: string;
  current: boolean;
}

/**
 * Active sessions / devices (PRD §6.1).
 *
 * Individual revocation and "sign out everywhere" are destructive, so both
 * require an explicit confirmation dialog. Revoking the current session — or
 * signing out everywhere — ends THIS client's session too (user decision,
 * M6-i5), so the page moves to sign-in on success rather than leaving a dead
 * session in the tab.
 */
export function SessionSettings() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSessions(await api<SessionRow[]>('/me/sessions'));
    } catch {
      setSessions(null);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function revoke(id: string, isCurrent: boolean) {
    const label = isCurrent ? 'Sign out of this device? You will be logged out.' : 'Revoke this session? It will be signed out immediately.';
    if (!window.confirm(label)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/me/sessions/${id}`, { method: 'DELETE' });
      if (isCurrent) {
        window.location.href = '/login';
        return;
      }
      setNotice('Session revoked.');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.problem.detail : 'Could not revoke the session.');
    } finally {
      setBusy(false);
    }
  }

  async function signOutEverywhere() {
    if (!window.confirm('Sign out everywhere? This revokes every active session, including this device.')) return;
    setBusy(true);
    setError(null);
    try {
      await api('/auth/logout-all', { method: 'POST' });
      // The caller's own session was revoked: this client is logged out.
      window.location.href = '/login';
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.problem.detail : 'Could not sign out everywhere.');
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="sessions-heading" data-testid="sessions-card">
      <h2 id="sessions-heading">Sessions</h2>
      {sessions === null ? (
        <p role="status" className="muted">Loading sessions…</p>
      ) : (
        <>
          <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px' }}>
            {sessions.map((s) => (
              <li
                key={s.id}
                className="spread"
                style={{ padding: '8px 0', borderBottom: '1px solid var(--border, #d0d0d0)', gap: 12 }}
              >
                <span>
                  {s.deviceLabel ?? 'Browser'}
                  {s.current && (
                    <span className="pill pill-ok" style={{ marginLeft: 8 }}>This device</span>
                  )}
                  <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                    Last seen {new Date(s.lastSeenAt).toLocaleString()} · Created {new Date(s.createdAt).toLocaleDateString()}
                  </span>
                </span>
                <button
                  className="btn-sm"
                  onClick={() => { void revoke(s.id, s.current); }}
                  disabled={busy}
                  aria-label={s.current ? 'Revoke this session and sign out' : `Revoke session for ${s.deviceLabel ?? 'Browser'}`}
                >
                  {s.current ? 'Revoke & sign out' : 'Revoke'}
                </button>
              </li>
            ))}
          </ul>
          {notice && <div className="banner banner-info" role="status">{notice}</div>}
          {error && <div className="banner banner-error" role="alert">{error}</div>}
          <button
            style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
            onClick={() => { void signOutEverywhere(); }}
            disabled={busy}
          >
            {busy ? 'Working…' : 'Sign out everywhere'}
          </button>
        </>
      )}
    </section>
  );
}
