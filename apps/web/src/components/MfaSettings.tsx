'use client';

import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, ApiError } from '@/lib/api';

interface MfaStatus {
  enabled: boolean;
  recoveryCodesRemaining: number;
}

type Phase = 'idle' | 'scanning' | 'codes' | 'disabling';

/**
 * Two-factor authentication settings (PRD §6.2).
 *
 * Enrolment is deliberately three screens — scan, confirm, save codes — because
 * the recovery codes are shown exactly once and losing them means losing the
 * account.
 */
export function MfaSettings() {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [secret, setSecret] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api<MfaStatus>('/auth/mfa/status'));
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function beginEnrolment() {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ secret: string; uri: string }>('/auth/mfa/enrol', { method: 'POST' });
      setSecret(result.secret);
      // Rendered locally: the secret must not be handed to a third-party QR service.
      setQrDataUrl(await QRCode.toDataURL(result.uri, { margin: 1, width: 200 }));
      setPhase('scanning');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.problem.detail : 'Could not start setup.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnrolment(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ recoveryCodes: string[] }>('/auth/mfa/confirm', {
        method: 'POST',
        body: JSON.stringify({ code: code.trim() }),
      });
      setRecoveryCodes(result.recoveryCodes);
      setPhase('codes');
      setCode('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.problem.detail : 'Could not confirm that code.');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  async function disable(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/mfa/disable', { method: 'POST', body: JSON.stringify({ code: code.trim() }) });
      setPhase('idle');
      setCode('');
      setNotice('Two-factor authentication is off.');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.problem.detail : 'Could not turn off two-factor authentication.');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  function finishEnrolment() {
    setPhase('idle');
    setRecoveryCodes([]);
    setAcknowledged(false);
    setSecret('');
    setQrDataUrl('');
    setNotice('Two-factor authentication is on.');
    void load();
  }

  function downloadCodes() {
    const body = [
      'NEXTDOO recovery codes',
      'Each code works once. Store them somewhere safe and offline.',
      '',
      ...recoveryCodes,
      '',
      `Generated ${new Date().toISOString()}`,
    ].join('\n');

    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'nextdoo-recovery-codes.txt';
    anchor.click();
    URL.revokeObjectURL(url);
    setAcknowledged(true);
  }

  return (
    <section className="card" aria-labelledby="mfa-heading">
      <div className="spread" style={{ marginBottom: 10 }}>
        <h2 id="mfa-heading" style={{ margin: 0 }}>Two-factor authentication</h2>
        {status && (
          <span className={status.enabled ? 'pill pill-ok' : 'pill'}>{status.enabled ? 'On' : 'Off'}</span>
        )}
      </div>

      {error && <div className="banner banner-error" role="alert">{error}</div>}
      {notice && <div className="banner banner-info" role="status">{notice}</div>}

      {/* ---- idle: on or off, nothing in progress */}
      {phase === 'idle' && (
        <>
          <p className="muted" style={{ marginBottom: 12 }}>
            {status?.enabled
              ? 'Your account asks for a code from your authenticator app when you sign in.'
              : 'Require a code from an authenticator app in addition to your password.'}
          </p>

          {status?.enabled ? (
            <>
              {status.recoveryCodesRemaining <= 3 && (
                <div className="banner banner-warn" role="status">
                  Only {status.recoveryCodesRemaining} recovery code
                  {status.recoveryCodesRemaining === 1 ? '' : 's'} left. Turn two-factor off and on again to get a
                  fresh set.
                </div>
              )}
              <p className="muted" style={{ marginBottom: 12 }}>
                {status.recoveryCodesRemaining} recovery code{status.recoveryCodesRemaining === 1 ? '' : 's'} unused.
              </p>
              <button onClick={() => { setPhase('disabling'); setError(null); setNotice(null); }}>
                Turn off two-factor
              </button>
            </>
          ) : (
            <button className="btn-primary" onClick={beginEnrolment} disabled={busy}>
              {busy ? 'Starting…' : 'Set up two-factor'}
            </button>
          )}
        </>
      )}

      {/* ---- scanning: secret issued, not yet active */}
      {phase === 'scanning' && (
        <form onSubmit={confirmEnrolment}>
          <p className="muted" style={{ marginBottom: 12 }}>
            Scan this with your authenticator app, then enter the 6-digit code it shows.
          </p>

          {qrDataUrl && (
            <img
              src={qrDataUrl}
              alt="QR code for two-factor setup. If you cannot scan it, use the setup key below."
              width={200}
              height={200}
              style={{ background: '#fff', padding: 8, borderRadius: 8, display: 'block', marginBottom: 12 }}
            />
          )}

          <div className="field">
            <label htmlFor="mfa-secret">Or enter this setup key manually</label>
            <input
              id="mfa-secret"
              readOnly
              value={secret}
              onFocus={(e) => e.currentTarget.select()}
              style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}
            />
          </div>

          <div className="field">
            <label htmlFor="mfa-code">6-digit code</label>
            <input
              id="mfa-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              autoComplete="one-time-code"
              inputMode="numeric"
              placeholder="123456"
              disabled={busy}
              style={{ fontVariantNumeric: 'tabular-nums', letterSpacing: '.08em' }}
            />
          </div>

          <div className="row">
            <button type="submit" className="btn-primary" disabled={busy || code.trim().length < 6}>
              {busy ? 'Verifying…' : 'Verify and turn on'}
            </button>
            <button type="button" onClick={() => { setPhase('idle'); setCode(''); setError(null); }}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* ---- codes: shown exactly once */}
      {phase === 'codes' && (
        <div>
          <div className="banner banner-warn" role="alert">
            <strong>Save these now.</strong> They are shown once and cannot be retrieved later. Each one works a
            single time if you lose your authenticator.
          </div>

          <ul
            style={{
              listStyle: 'none', padding: 14, margin: '0 0 12px',
              background: 'var(--bg)', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm)',
              display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8,
              fontFamily: 'ui-monospace, monospace', fontSize: 13.5,
            }}
          >
            {recoveryCodes.map((c) => <li key={c}>{c}</li>)}
          </ul>

          <div className="row" style={{ marginBottom: 12 }}>
            <button type="button" onClick={downloadCodes}>Download as a file</button>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(recoveryCodes.join('\n'));
                setAcknowledged(true);
              }}
            >
              Copy to clipboard
            </button>
          </div>

          <div className="field">
            <label htmlFor="ack" style={{ display: 'inline' }}>
              <input
                id="ack"
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                style={{ width: 'auto', minHeight: 'auto', marginRight: 8 }}
              />
              I have saved these codes somewhere safe
            </label>
          </div>

          <button className="btn-primary" onClick={finishEnrolment} disabled={!acknowledged}>
            Done
          </button>
        </div>
      )}

      {/* ---- disabling: re-authenticate before lowering security */}
      {phase === 'disabling' && (
        <form onSubmit={disable}>
          <p className="muted" style={{ marginBottom: 12 }}>
            Enter a current code to confirm. A recovery code works too.
          </p>
          <div className="field">
            <label htmlFor="disable-code">Authentication code</label>
            <input
              id="disable-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              autoFocus
              autoComplete="one-time-code"
              placeholder="123456"
              disabled={busy}
              style={{ fontVariantNumeric: 'tabular-nums', letterSpacing: '.08em' }}
            />
          </div>
          <div className="row">
            <button
              type="submit"
              style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
              disabled={busy || !code.trim()}
            >
              {busy ? 'Turning off…' : 'Turn off two-factor'}
            </button>
            <button type="button" onClick={() => { setPhase('idle'); setCode(''); setError(null); }}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
