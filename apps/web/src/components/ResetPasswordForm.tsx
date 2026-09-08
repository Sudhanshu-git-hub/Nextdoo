'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

/**
 * Choose a new password from an emailed link (PRD §6.2).
 *
 * The token arrives in the query string. A completed reset signs every session
 * out, so the user is sent back to sign in rather than silently logged in.
 */
export function ResetPasswordForm({ token }: { token: string | null }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mismatch = confirm.length > 0 && password !== confirm;
  const tooShort = password.length > 0 && password.length < 12;
  const canSubmit = password.length >= 12 && password === confirm && !busy;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || !token) return;

    setBusy(true);
    setError(null);
    try {
      await api('/auth/password-reset/confirm', {
        method: 'POST',
        body: JSON.stringify({ token, password }),
      });
      setDone(true);
      // Give the confirmation a moment to be read before moving on.
      setTimeout(() => router.push('/login'), 2500);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.problem.detail
          : 'We could not reset your password. Please request a new link.',
      );
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="card">
            <h1 style={{ marginBottom: 8 }}>This link is incomplete</h1>
            <p className="muted">
              The reset link is missing its token. It may have been truncated by your email client.
            </p>
            <p style={{ marginTop: 14 }}>
              <Link href="/forgot-password">Request a new link</Link>
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand" style={{ padding: '0 0 18px', fontSize: 19 }}>NEXT<span>DOO</span></div>

        {done ? (
          <div className="card" role="status" aria-live="polite">
            <h1 style={{ marginBottom: 8 }}>Password changed</h1>
            <p className="muted">
              Every device has been signed out. Taking you to sign in…
            </p>
            <p style={{ marginTop: 14 }}><Link href="/login">Sign in now</Link></p>
          </div>
        ) : (
          <>
            <h1 style={{ marginBottom: 4 }}>Choose a new password</h1>
            <p className="subtitle" style={{ marginBottom: 20 }}>
              This will sign you out everywhere else.
            </p>

            <form onSubmit={submit} className="card" noValidate>
              {error && (
                <div className="banner banner-error" role="alert">
                  {error} <Link href="/forgot-password">Request a new link</Link>.
                </div>
              )}

              <div className="field">
                <label htmlFor="password">New password</label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={12}
                  autoComplete="new-password"
                  autoFocus
                  aria-describedby="password-hint"
                  aria-invalid={tooShort || undefined}
                  disabled={busy}
                />
                <p id="password-hint" className="muted" style={{ marginTop: 5 }}>
                  {tooShort
                    ? `${12 - password.length} more character${12 - password.length === 1 ? '' : 's'} needed.`
                    : 'At least 12 characters. Length beats complexity.'}
                </p>
              </div>

              <div className="field">
                <label htmlFor="confirm">Confirm new password</label>
                <input
                  id="confirm"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  autoComplete="new-password"
                  aria-invalid={mismatch || undefined}
                  aria-describedby={mismatch ? 'confirm-error' : undefined}
                  disabled={busy}
                />
                {mismatch && (
                  <p id="confirm-error" style={{ color: 'var(--danger)', fontSize: 13, marginTop: 5 }} role="alert">
                    These passwords do not match.
                  </p>
                )}
              </div>

              <button type="submit" className="btn-primary" style={{ width: '100%' }} disabled={!canSubmit}>
                {busy ? 'Saving…' : 'Change password'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
