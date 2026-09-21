'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface AuditEntry {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/**
 * Security-relevant account history (PRD §12.4).
 *
 * Action codes are mapped to plain language: `account.mfa_enabled` tells a
 * developer something, but this page is for the account's owner.
 */
const LABELS: Record<string, string> = {
  'account.registered': 'Account created',
  'account.signed_in': 'Signed in',
  'account.email_verified': 'Email address confirmed',
  'account.password_reset_requested': 'Password reset requested',
  'account.password_reset': 'Password changed',
  'account.mfa_enabled': 'Two-factor authentication turned on',
  'account.mfa_disabled': 'Two-factor authentication turned off',
  'account.mfa_failed': 'Failed two-factor attempt',
  'account.recovery_code_used': 'Recovery code used',
  'account.exported': 'Data exported',
  'account.deletion_requested': 'Account deletion requested',
  'account.deletion_cancelled': 'Account deletion cancelled',
};

/** Entries worth drawing attention to. */
const NOTABLE = new Set([
  'account.mfa_failed',
  'account.mfa_disabled',
  'account.password_reset',
  'account.deletion_requested',
  'account.recovery_code_used',
]);

export function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await api<{ data: AuditEntry[] }>('/audit-logs?limit=25&category=account');
        setEntries(response.data);
      } catch {
        setError('Could not load your account activity.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <section className="card" aria-labelledby="audit-heading">
      <h2 id="audit-heading">Recent account activity</h2>

      {loading && <div className="skeleton" style={{ height: 60 }} />}
      {error && <div className="banner banner-error" role="alert">{error}</div>}

      {!loading && !error && entries.length === 0 && (
        <p className="muted">No security events recorded yet.</p>
      )}

      {entries.length > 0 && (
        <table>
          <caption className="sr-only">Security-relevant events on your account, most recent first</caption>
          <thead>
            <tr>
              <th scope="col">Event</th>
              <th scope="col">When</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td style={NOTABLE.has(entry.action) ? { color: 'var(--warn)' } : undefined}>
                  {LABELS[entry.action] ?? entry.action}
                </td>
                <td className="muted">
                  <time dateTime={entry.createdAt}>
                    {new Date(entry.createdAt).toLocaleString(undefined, {
                      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                    })}
                  </time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
