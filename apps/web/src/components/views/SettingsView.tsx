'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { EntitlementLimits, Plan } from '@nextdoo/contracts';
import { api, ApiError } from '@/lib/api';
import { WorkspaceSettings } from '@/components/WorkspaceSettings';
import { MfaSettings } from '@/components/MfaSettings';
import { AuditLog } from '@/components/AuditLog';
import { DataExport } from '@/components/DataExport';

interface EntitlementSnapshot {
  plan: Plan;
  limits: EntitlementLimits;
  usage: { activeTasks: number; projects: number; calendarConnections: number };
}

interface DeletionStatus {
  scheduled: boolean;
  requestedAt: string | null;
  purgeAfter: string | null;
}

/** Settings (PRD §8.3, §12). Destructive actions require typed confirmation. */
export function SettingsView({
  email,
  emailVerified,
  entitlements,
}: {
  email: string;
  emailVerified: boolean;
  entitlements: EntitlementSnapshot;
}) {
  const searchParams = useSearchParams();
  const [contrast, setContrast] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  const [deletion, setDeletion] = useState<DeletionStatus | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resendState, setResendState] = useState<'idle' | 'sent'>('idle');

  useEffect(() => {
    document.documentElement.dataset.contrast = contrast ? 'high' : '';
  }, [contrast]);

  useEffect(() => {
    document.documentElement.dataset.motion = reducedMotion ? 'reduced' : '';
  }, [reducedMotion]);

  const loadDeletion = useCallback(async () => {
    try {
      setDeletion(await api<DeletionStatus>('/account/deletion'));
    } catch {
      setDeletion(null);
    }
  }, []);

  useEffect(() => { void loadDeletion(); }, [loadDeletion]);

  // Signing in during the grace window cancels a scheduled deletion; the login
  // redirect flags it so the change is not silent.
  useEffect(() => {
    if (searchParams.get('deletion') === 'cancelled') {
      setNotice('Welcome back — the scheduled deletion of your account has been cancelled.');
    }
  }, [searchParams]);

  async function requestDeletion(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<DeletionStatus>('/account/deletion', {
        method: 'POST',
        body: JSON.stringify({ password, confirm: 'DELETE' }),
      });
      setDeletion(result);
      setPassword('');
      setConfirmText('');
      // Every session was revoked, so send them to sign-in rather than leaving
      // a dead session in the tab.
      window.location.href = '/login';
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.problem.detail : 'Could not schedule deletion.');
      setBusy(false);
    }
  }

  async function cancelDeletion() {
    setBusy(true);
    setError(null);
    try {
      await api('/account/deletion', { method: 'DELETE' });
      setNotice('Your account will not be deleted.');
      await loadDeletion();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.problem.detail : 'Could not cancel deletion.');
    } finally {
      setBusy(false);
    }
  }

  async function resendVerification() {
    setBusy(true);
    setError(null);
    try {
      await api('/auth/verify-email', { method: 'PUT' });
      setResendState('sent');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.problem.detail : 'Could not send the verification email.');
    } finally {
      setBusy(false);
    }
  }

  const timeZone = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="subtitle">Account, security, plan limits, accessibility and your data.</p>
        </div>
      </div>

      <WorkspaceSettings />
      {notice && <div className="banner banner-info" role="status">{notice}</div>}
      {error && <div className="banner banner-error" role="alert">{error}</div>}

      {deletion?.scheduled && (
        <div className="banner banner-error" role="alert">
          <strong>This account is scheduled for deletion.</strong> Everything will be permanently removed on{' '}
          {new Date(deletion.purgeAfter!).toLocaleDateString(undefined, {
            year: 'numeric', month: 'long', day: 'numeric',
          })}
          .{' '}
          <button className="btn-sm" onClick={cancelDeletion} disabled={busy} style={{ marginLeft: 8 }}>
            Keep my account
          </button>
        </div>
      )}

      <div className="grid grid-2">
        <section className="card" aria-labelledby="account-heading">
          <h2 id="account-heading">Account</h2>
          <table>
            <tbody>
              <tr>
                <th scope="row">Email</th>
                <td>
                  {email}{' '}
                  {emailVerified ? (
                    <span className="pill pill-ok">Verified</span>
                  ) : (
                    <span className="pill pill-medium">Unverified</span>
                  )}
                </td>
              </tr>
              <tr><th scope="row">Browser time zone</th><td>{timeZone}</td></tr>
              <tr><th scope="row">Plan</th><td>{entitlements.plan}</td></tr>
            </tbody>
          </table>

          {!emailVerified && (
            <div className="banner banner-warn" style={{ marginTop: 12 }} role="status">
              {resendState === 'sent'
                ? 'Verification email sent — check your inbox.'
                : 'Confirm your email address so you can recover your account if you lose your password.'}
              {resendState === 'idle' && (
                <button className="btn-sm" onClick={resendVerification} disabled={busy} style={{ marginLeft: 8 }}>
                  Resend
                </button>
              )}
            </div>
          )}

          <form action="/api/v1/auth/logout" method="post" style={{ marginTop: 14 }}>
            <button type="submit">Sign out</button>
          </form>
        </section>

        <MfaSettings />

        <section className="card" aria-labelledby="usage-heading">
          <h2 id="usage-heading">Usage</h2>
          <Usage label="Active tasks" used={entitlements.usage.activeTasks} max={entitlements.limits.activeTasks} />
          <Usage label="Projects" used={entitlements.usage.projects} max={entitlements.limits.projects} />
          <Usage label="Calendar connections" used={entitlements.usage.calendarConnections} max={entitlements.limits.calendarConnections} />
          <p className="muted" style={{ marginTop: 10 }}>
            Limits are enforced on the server, so they hold even if a client is modified.
          </p>
        </section>

        <section className="card" aria-labelledby="a11y-heading">
          <h2 id="a11y-heading">Accessibility</h2>
          <div className="field">
            <label htmlFor="contrast" style={{ display: 'inline' }}>
              <input
                id="contrast"
                type="checkbox"
                checked={contrast}
                onChange={(e) => setContrast(e.target.checked)}
                style={{ width: 'auto', minHeight: 'auto', marginRight: 8 }}
              />
              Increase contrast
            </label>
          </div>
          <div className="field">
            <label htmlFor="motion" style={{ display: 'inline' }}>
              <input
                id="motion"
                type="checkbox"
                checked={reducedMotion}
                onChange={(e) => setReducedMotion(e.target.checked)}
                style={{ width: 'auto', minHeight: 'auto', marginRight: 8 }}
              />
              Reduce motion
            </label>
          </div>
          <p className="muted">
            Your system preferences are respected by default; these override them for this browser.
          </p>
        </section>

        <section className="card" aria-labelledby="data-heading">
          <h2 id="data-heading">Your data</h2>
          <p className="muted" style={{ marginBottom: 12 }}>
            Export produces a complete JSON archive of your tasks, projects and tracking history. It excludes your
            password and two-factor secret.
          </p>
          <a
            className="btn"
            href="/api/v1/account/export"
            download
            style={{ display: 'inline-block', textDecoration: 'none' }}
          >
            Export my data
          </a>

          {!deletion?.scheduled && (
            <>
              <h2 style={{ marginTop: 22, color: 'var(--danger)' }}>Delete account</h2>
              <p className="muted" style={{ marginBottom: 10 }}>
                Your account is scheduled for deletion and permanently removed after 30 days. Signing in during that
                window cancels it.
              </p>

              <form onSubmit={requestDeletion}>
                <div className="field">
                  <label htmlFor="delete-password">Confirm your password</label>
                  <input
                    id="delete-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    disabled={busy}
                  />
                </div>
                <div className="field">
                  <label htmlFor="confirm-delete">
                    Type <strong>DELETE</strong> to enable the button
                  </label>
                  <input
                    id="confirm-delete"
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    placeholder="DELETE"
                    autoComplete="off"
                    disabled={busy}
                  />
                </div>
                <button
                  type="submit"
                  style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
                  disabled={busy || confirmText !== 'DELETE' || !password}
                >
                  {busy ? 'Scheduling…' : 'Delete my account'}
                </button>
              </form>
            </>
          )}
        </section>

        <DataExport exportsPerDay={entitlements.limits.exportsPerDay} />

        <AuditLog />
      </div>
    </>
  );
}

function Usage({ label, used, max }: { label: string; used: number; max: number | null }) {
  const pct = max ? Math.min(100, (used / max) * 100) : 0;
  const near = max !== null && used / max >= 0.8;
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="spread" style={{ fontSize: 13, marginBottom: 5 }}>
        <span>{label}</span>
        <span className="muted">{max === null ? `${used} · unlimited` : `${used} of ${max}`}</span>
      </div>
      {max !== null && (
        <div className="bar">
          <i style={{ width: `${pct}%`, background: near ? 'var(--warn)' : 'var(--accent)' }} />
        </div>
      )}
    </div>
  );
}
