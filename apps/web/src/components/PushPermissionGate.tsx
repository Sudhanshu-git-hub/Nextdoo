'use client';

import { useState } from 'react';
import { pushSupport } from '@/lib/push-client';

/**
 * Phase 3: Two-step push permission flow.
 *
 * Instead of firing Notification.requestPermission() immediately on click
 * (which browsers reject as insufficient user engagement), this component
 * first shows an explanation screen describing what browser push does and
 * how it respects privacy. Only the explicit "Enable notifications" button
 * on the second step triggers the actual permission request.
 */

type GateProps = {
  onRequestPermission: () => Promise<void>;
  disabled?: boolean;
};

export function PushPermissionGate({ onRequestPermission, disabled }: GateProps) {
  const [step, setStep] = useState<'explain' | 'enabled' | 'denied'>('explain');
  const support = pushSupport();

  if (support.kind !== 'supported') {
    return (
      <div className="push-gate">
        <p className="push-gate-text">
          Browser push is not supported in this browser. Reminders continue to
          appear in the notification center.
        </p>
      </div>
    );
  }

  if (step === 'enabled') {
    return (
      <div className="push-gate push-gate-success">
        <span className="push-gate-dot" aria-hidden="true" />
        <span>Notifications enabled — you'll receive reminders as browser notifications.</span>
      </div>
    );
  }

  if (step === 'denied') {
    return (
      <div className="push-gate push-gate-denied">
        <span className="push-gate-dot push-gate-dot-warn" aria-hidden="true" />
        <span>Notifications are blocked in your browser settings.</span>
        <button
          type="button"
          className="btn-sm"
          onClick={() => setStep('explain')}
          disabled={disabled}
        >
          Learn how to enable
        </button>
      </div>
    );
  }

  // Step 1: explanation screen
  return (
    <div className="push-gate push-gate-explain">
      <div className="push-gate-icon" aria-hidden="true">🔔</div>
      <div className="push-gate-body">
        <h3 className="push-gate-title">Enable browser push?</h3>
        <p className="push-gate-text">
          Browser push sends reminder notifications directly to your device —
          even when NEXTDOO isn't open. This helps you stay on top of deadlines
          and planned work.
        </p>
        <ul className="push-gate-list">
          <li>Reminders appear as system notifications on this device</li>
          <li>Your data stays on this device — only reminder content is sent</li>
          <li>You can disable anytime from this settings panel</li>
          <li>Works alongside the in-app notification center</li>
        </ul>
      </div>
      <button
        type="button"
        className="btn-primary"
        onClick={async () => {
          await onRequestPermission();
          const permission = typeof Notification !== 'undefined' ? Notification.permission : 'denied';
          setStep(permission === 'granted' ? 'enabled' : 'denied');
        }}
        disabled={disabled}
      >
        Enable notifications
      </button>
    </div>
  );
}
