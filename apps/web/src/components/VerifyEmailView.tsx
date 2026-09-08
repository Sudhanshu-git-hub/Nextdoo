'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';

type State = 'verifying' | 'verified' | 'failed';

/**
 * Consumes an email verification token (PRD §6.2).
 *
 * Runs on mount because the user arrived by clicking the link — asking them to
 * click a second button would be pure ceremony.
 */
export function VerifyEmailView({ token }: { token: string | null }) {
  const [state, setState] = useState<State>(token ? 'verifying' : 'failed');
  const [message, setMessage] = useState<string | null>(
    token ? null : 'The verification link is missing its token. It may have been truncated by your email client.',
  );
  // React 18 StrictMode mounts twice in development; the token is single-use,
  // so a second call would always fail and show a false error.
  const attempted = useRef(false);

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;

    void (async () => {
      try {
        await api('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) });
        setState('verified');
      } catch (caught) {
        setState('failed');
        setMessage(
          caught instanceof ApiError
            ? caught.problem.detail
            : 'We could not confirm your email address. Please try again.',
        );
      }
    })();
  }, [token]);

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand" style={{ padding: '0 0 18px', fontSize: 19 }}>NEXT<span>DOO</span></div>

        <div className="card" aria-live="polite" aria-busy={state === 'verifying'}>
          {state === 'verifying' && (
            <>
              <h1 style={{ marginBottom: 8 }}>Confirming your email…</h1>
              <div className="skeleton" style={{ height: 16, width: '70%' }} />
            </>
          )}

          {state === 'verified' && (
            <>
              <h1 style={{ marginBottom: 8 }}>Email confirmed</h1>
              <p className="muted">Thank you — your address is verified.</p>
              <p style={{ marginTop: 14 }}><Link href="/today">Go to Today</Link></p>
            </>
          )}

          {state === 'failed' && (
            <>
              <h1 style={{ marginBottom: 8 }}>We could not confirm this link</h1>
              <p className="muted">{message}</p>
              <p className="muted" style={{ marginTop: 10 }}>
                Verification links expire after 24 hours and can only be used once. You can send yourself a new one
                from Settings.
              </p>
              <p style={{ marginTop: 14 }}><Link href="/settings">Go to Settings</Link></p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
