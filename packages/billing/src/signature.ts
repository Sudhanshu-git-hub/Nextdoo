import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signature verification (PRD §18.3, threat model line "Webhooks:
 * Forged or replayed events -> Signature verification, timestamp window,
 * event-ID dedupe"). Webhooks are untrusted input: ANY verification failure
 * rejects the event; the raw body is only ever parsed AFTER verification.
 *
 * Both verifiers are pure functions of (secret, payload, time) so the whole
 * security surface is testable hermetically with generated secrets — no live
 * provider configuration is needed to prove the checks work.
 */

/** Stripe allows up to 5 minutes of clock skew between event time and receiver. */
export const STRIPE_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;
/** Razorpay stamps events with created_at; allow 15 minutes old + 5 minutes of clock skew. */
export const RAZORPAY_EVENT_MAX_AGE_MS = 15 * 60 * 1000;
export const RAZORPAY_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface SignatureVerdict {
  valid: boolean;
  /** Provider-stamped event time (unix seconds) when the payload carried one. */
  timestampSeconds: number | null;
  reason: string | null;
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Stripe `Stripe-Signature` header: `t=<unix>,v1=<hmac-sha256 of "t.payload">`.
 * Multiple `t`/`v1` pairs may appear (rotated secrets); any valid, in-window
 * pair accepts. A pair whose timestamp is outside the 5-minute window poisons
 * the whole header (replay protection), per Stripe's documented scheme.
 */
export function verifyStripeSignature(
  header: string,
  secret: string,
  rawBody: string,
  nowMs: number = Date.now(),
  toleranceMs: number = STRIPE_TIMESTAMP_TOLERANCE_MS,
): SignatureVerdict {
  const pairs: Array<{ t: number; v1: string }> = [];
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't' && value) {
      const t = Number(value);
      if (Number.isFinite(t) && t > 0) pairs.push({ t, v1: '' });
    } else if (key === 'v1' && value) {
      if (pairs.length === 0) return { valid: false, timestampSeconds: null, reason: 'signature pair without timestamp' };
      pairs[pairs.length - 1]!.v1 = value;
    }
  }
  if (pairs.length === 0) return { valid: false, timestampSeconds: null, reason: 'missing timestamp/signature pairs' };

  let lastTimestamp: number | null = null;
  for (const pair of pairs) {
    lastTimestamp = pair.t;
    if (Math.abs(nowMs - pair.t * 1000) > toleranceMs) {
      return { valid: false, timestampSeconds: pair.t, reason: 'timestamp outside replay window' };
    }
    const expected = createHmac('sha256', secret).update(`${pair.t}.${rawBody}`).digest('hex');
    if (constantTimeEqualHex(expected, pair.v1)) {
      return { valid: true, timestampSeconds: pair.t, reason: null };
    }
  }
  return { valid: false, timestampSeconds: lastTimestamp, reason: 'no signature matched' };
}

/**
 * Razorpay `x-razorpay-signature`: hmac-sha256(raw body, webhook secret).
 * Razorpay stamps no header timestamp, so the window check runs on the
 * event's own `created_at` field — an event must be present and fresh.
 */
export function verifyRazorpaySignature(
  signature: string,
  secret: string,
  rawBody: string,
  eventCreatedAtSeconds: number | null,
  nowMs: number = Date.now(),
): SignatureVerdict {
  if (!signature) return { valid: false, timestampSeconds: null, reason: 'missing signature header' };
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (!constantTimeEqualHex(expected, signature)) {
    return { valid: false, timestampSeconds: eventCreatedAtSeconds, reason: 'signature mismatch' };
  }
  if (eventCreatedAtSeconds == null || !Number.isFinite(eventCreatedAtSeconds) || eventCreatedAtSeconds <= 0) {
    return { valid: false, timestampSeconds: null, reason: 'missing event timestamp' };
  }
  const age = nowMs - eventCreatedAtSeconds * 1000;
  if (age > RAZORPAY_EVENT_MAX_AGE_MS) return { valid: false, timestampSeconds: eventCreatedAtSeconds, reason: 'event older than replay window' };
  if (age < -RAZORPAY_CLOCK_SKEW_MS) return { valid: false, timestampSeconds: eventCreatedAtSeconds, reason: 'event timestamp in the future' };
  return { valid: true, timestampSeconds: eventCreatedAtSeconds, reason: null };
}
