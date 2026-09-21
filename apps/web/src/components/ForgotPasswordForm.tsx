'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';

/**
 * Request a password reset link (PRD §6.2).
 *
 * The success message is deliberately identical whether or not the address has
 * an account — the API refuses to confirm existence, and the UI must not undo
 * that by saying "no account found".
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/password-reset/request', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim() }),
      });
      setSent(true);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.problem.detail
          : 'We could not reach the server. Please check your connection and try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand" style={{ padding: '0 0 18px', fontSize: 19 }}>NEXT<span>DOO</span></div>

        {sent ? (
          <div className="card" role="status" aria-live="polite">
            <h1 style={{ marginBottom: 8 }}>Check your email</h1>
            <p className="muted">
              If <strong>{email}</strong> has an account, a reset link is on its way. The link works once and
              expires in an hour.
            </p>
            <p className="muted" style={{ marginTop: 12 }}>
              Nothing arrived?{' '}
              <button className="btn-ghost btn-sm" onClick={() => setSent(false)}>Try another address</button>
            </p>
          </div>
        ) : (
          <>
            <h1 style={{ marginBottom: 4 }}>Reset your password</h1>
            <p className="subtitle" style={{ marginBottom: 20 }}>
              We will email you a link to choose a new one.
            </p>

            <form onSubmit={submit} className="card" noValidate>
              {error && <div className="banner banner-error" role="alert">{error}</div>}

              <div className="field">
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  autoFocus
                  disabled={busy}
                />
              </div>

              <button type="submit" className="btn-primary" style={{ width: '100%' }} disabled={busy || !email.trim()}>
                {busy ? 'Sending…' : 'Send reset link'}
              </button>
            </form>
          </>
        )}

        <p className="muted" style={{ textAlign: 'center', marginTop: 16 }}>
          <Link href="/login">Back to sign in</Link>
        </p>
      </div>
    </div>
  );
}
