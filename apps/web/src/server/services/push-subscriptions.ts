import { AppError, pushSubscriptionSchema, type PushSubscriptionInput } from '@nextdoo/contracts';
import { ZodError } from 'zod';
import {
  listPushSubscriptions as dbListPushSubscriptions,
  registerPushSubscription as dbRegisterPushSubscription,
  removePushSubscription as dbRemovePushSubscription,
} from '@nextdoo/db';
import { getEnv, features } from '../env';
import { getDb } from '../db';

export type PushActor = { userId: string };

/**
 * M8-i1 (PRD §6.6/§9.3): browser push subscription lifecycle, user-scoped.
 * The feature is gated on a complete VAPID configuration; with it missing the
 * public-key endpoint answers 503 PROVIDER_UNAVAILABLE (no stub fallback), so
 * the client degrades honestly instead of collecting undeliverable
 * registrations.
 */

export function pushConfigured(): boolean {
  return features().browserPush;
}

export async function getVapidPublicKey(_actor: PushActor): Promise<{ vapidPublicKey: string }> {
  const env = getEnv();
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    throw new AppError('PROVIDER_UNAVAILABLE', 'Browser push is not configured on this deployment.');
  }
  return { vapidPublicKey: env.VAPID_PUBLIC_KEY };
}

export async function registerPushSubscription(
  actor: PushActor,
  // Deliberately untyped: every caller (route, UI, tests, future producers)
  // must pass through the schema, so malformed input is rejected here too.
  input: unknown,
): Promise<{ created: boolean; total: number }> {
  if (!pushConfigured()) {
    throw new AppError('PROVIDER_UNAVAILABLE', 'Browser push is not configured on this deployment.');
  }
  // Re-validated here (not only at the route) so direct service callers —
  // and future internal producers — cannot persist malformed keys.
  let parsed: PushSubscriptionInput;
  try {
    parsed = pushSubscriptionSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) throw new AppError('VALIDATION_FAILED', 'The push subscription payload is not valid.');
    throw error;
  }
  return dbRegisterPushSubscription(getDb(), actor, parsed);
}

export async function listPushSubscriptions(actor: PushActor): Promise<Array<{ endpoint: string; createdAt: string }>> {
  const rows = await dbListPushSubscriptions(getDb(), actor);
  return rows.map((r) => ({ endpoint: r.endpoint, createdAt: r.createdAt.toISOString() }));
}

export async function removePushSubscription(actor: PushActor, raw: { endpoint: string }): Promise<{ removed: boolean }> {
  if (typeof raw?.endpoint !== 'string' || raw.endpoint.length === 0 || raw.endpoint.length > 2048) {
    throw new AppError('VALIDATION_FAILED', 'A valid push endpoint is required.');
  }
  return dbRemovePushSubscription(getDb(), actor, raw.endpoint);
}
