'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';

/**
 * Shared login/registration form (PRD §6.1, §6.2).
 *
 * Login is two-phase when MFA is on: the password round-trip answers
 * MFA_REQUIRED, and the form then asks for a second factor without having
 * issued a session.
 */
export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needsMfa, setNeedsMfa] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isRegister = mode === 'register';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const result = await api<{ deletionCancelled?: boolean }>(`/auth/${mode}`, {
        method: 'POST',
        body: JSON.stringify({
          email: email.trim(),
          password,
          // Only sent once the server has asked for it.
          ...(needsMfa && totp.trim() ? { totp: totp.trim() } : {}),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });

      if (result?.deletionCancelled) {
        // Signing in during the grace window revives the account; say so rather
        // than letting a scheduled deletion vanish silently.
        router.push('/settings?deletion=cancelled');
      } else {
        router.push('/today');
      }
      router.refresh();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'MFA_REQUIRED') {
        setNeedsMfa(true);
        setError(null);
      } else {
        setError(
          caught instanceof ApiError
            ? caught.problem.detail
            : 'Something went wrong. Please check your connection and try again.',
        );
        // A rejected second factor should be retyped, not resubmitted.
        setTotp('');
      }
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand" style={{ padding: '0 0 18px', fontSize: 19 }}>NEXT<span>DOO</span></div>
        <h1 style={{ marginBottom: 4 }}>
          {needsMfa ? 'Two-factor verification' : isRegister ? 'Create your account' : 'Sign in'}
        </h1>
        <p className="subtitle" style={{ marginBottom: 20 }}>
          {needsMfa
            ? 'Enter the code from your authenticator app, or one of your recovery codes.'
            : isRegister
              ? 'Plan work against the time you actually have.'
              : 'Welcome back.'}
        </p>

        <form onSubmit={submit} className="card" noValidate>
          {error && <div className="banner banner-error" role="alert">{error}</div>}

          {needsMfa ? (
            <>
              <div className="field">
                <label htmlFor="totp">Authentication code</label>
                <input
                  id="totp"
                  type="text"
                  inputMode="text"
                  value={totp}
                  onChange={(e) => setTotp(e.target.value)}
                  required
                  autoFocus
                  autoComplete="one-time-code"
                  placeholder="123456"
                  aria-describedby="totp-hint"
                  disabled={busy}
                  style={{ fontVariantNumeric: 'tabular-nums', letterSpacing: '.08em' }}
                />
                <p id="totp-hint" className="muted" style={{ marginTop: 5 }}>
                  A 6-digit code, or a recovery code like <span className="kbd">ABCDE-FGHIJ</span>.
                </p>
              </div>

              <button type="submit" className="btn-primary" style={{ width: '100%' }} disabled={busy || !totp.trim()}>
                {busy ? 'Verifying…' : 'Verify and sign in'}
              </button>

              <button
                type="button"
                className="btn-ghost btn-sm"
                style={{ width: '100%', marginTop: 8 }}
                onClick={() => {
                  setNeedsMfa(false);
                  setTotp('');
                  setPassword('');
                  setError(null);
                }}
              >
                Use a different account
              </button>
            </>
          ) : (
            <>
              <div className="field">
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  disabled={busy}
                />
              </div>

              <div className="field">
                <div className="spread" style={{ marginBottom: 5 }}>
                  <label htmlFor="password" style={{ margin: 0 }}>Password</label>
                  {!isRegister && (
                    <Link href="/forgot-password" style={{ fontSize: 13 }}>Forgot?</Link>
                  )}
                </div>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={isRegister ? 12 : undefined}
                  autoComplete={isRegister ? 'new-password' : 'current-password'}
                  aria-describedby={isRegister ? 'password-hint' : undefined}
                  disabled={busy}
                />
                {isRegister && (
                  <p id="password-hint" className="muted" style={{ marginTop: 5 }}>
                    At least 12 characters. Length beats complexity.
                  </p>
                )}
              </div>

              <button type="submit" className="btn-primary" style={{ width: '100%' }} disabled={busy}>
                {busy ? 'Please wait…' : isRegister ? 'Create account' : 'Sign in'}
              </button>
            </>
          )}
        </form>

        {!needsMfa && (
          <p className="muted" style={{ textAlign: 'center', marginTop: 16 }}>
            {isRegister ? (
              <>Already have an account? <Link href="/login">Sign in</Link></>
            ) : (
              <>New here? <Link href="/register">Create an account</Link></>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
