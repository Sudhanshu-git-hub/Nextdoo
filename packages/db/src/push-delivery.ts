import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from './client';

export type PushTransport = {
  /**
   * Sends one Web Push message. `statusCode` is the push provider's HTTP
   * status: 2xx = accepted; 404/410 = subscription gone; anything else is a
   * transient failure eligible for bounded retry. Implementations must never
   * throw for a provider response (network-level errors may throw).
   */
  send(
    subscription: { endpoint: string; p256dh: string; auth: string },
    payload: string,
  ): Promise<{ statusCode: number }>;
};

export type PushDeliveryResult = {
  processed: number;
  sent: number;
  failed: number;
  gone: number;
  retrying: number;
  expired: number;
};

const MAX_ATTEMPTS = 5;
const LEASE = sql`interval '10 minutes'`;

/**
 * M8-i1 (PRD §6.6/§12.4): bounded, durable at-least-once browser push
 * delivery. Mirrors the mail-delivery lease pattern (skip-locked claim,
 * 10-minute leases, 5 attempts with exponential backoff, 24-hour payload
 * expiry with scrubbing).
 *
 * Semantics:
 * - 2xx  -> SENT (payload scrubbed).
 * - 404/410 -> the subscription is deleted (idempotent) and the delivery is
 *   terminal with last_error 'SUBSCRIPTION_GONE'. Sibling subscriptions of
 *   the same reminder are unaffected and keep delivering.
 * - 429/5xx/other -> bounded retry; terminal FAILED 'PUSH_DELIVERY_FAILED'
 *   after the fifth attempt.
 * - After each pass, reminders whose push deliveries all terminally failed
 *   expose the failure through the existing reminder history (last_error),
 *   without changing the reminder status (the delivery was recorded: SENT).
 *
 * Pass `transport` = null when push is not configured (no VAPID keys); the
 * pass is then a no-op, exactly like mail delivery without SMTP.
 */
export async function deliverPushDeliveries(
  db: Database,
  limit = 10,
  transport: PushTransport | null = null,
): Promise<PushDeliveryResult> {
  if (!transport) return { processed: 0, sent: 0, failed: 0, gone: 0, retrying: 0, expired: 0 };
  const result: PushDeliveryResult = { processed: 0, sent: 0, failed: 0, gone: 0, retrying: 0, expired: 0 };

  // Lease hygiene first: a lease that expired with exhausted attempts is
  // terminal; an expired payload is scrubbed or marked EXPIRED.
  await db.execute(sql`update push_deliveries set status='FAILED',last_error='LEASE_EXPIRED',lease_token=null,lease_until=null
    where status='PROCESSING' and lease_until < now() and attempts >= ${MAX_ATTEMPTS}`);
  await db.execute(sql`update push_deliveries set payload='' where expires_at <= now() and status in ('SENT','FAILED','EXPIRED')`);
  const expired = await db.execute<{ id: string }>(sql`update push_deliveries set status='EXPIRED',payload='',lease_token=null,lease_until=null
    where expires_at <= now() and status in ('PENDING','PROCESSING') and (lease_until is null or lease_until < now())
    returning id`);
  result.expired = expired.length;

  const safeLimit = Math.max(0, Math.min(100, Math.floor(limit)));
  const lease = randomUUID();
  const rows = await db.execute<{
    id: string;
    reminder_id: string;
    subscription_id: string;
    payload: string;
    attempts: number;
  }>(sql`with claim as (
    select id from push_deliveries where expires_at > now() and attempts < ${MAX_ATTEMPTS}
      and ((status='PENDING' and next_attempt_at <= now()) or (status='PROCESSING' and lease_until < now()))
      order by created_at,id limit ${safeLimit} for update skip locked
    ) update push_deliveries d set status='PROCESSING',lease_token=${lease},lease_until=now()+${LEASE},attempts=d.attempts+1
      from claim where d.id=claim.id returning d.id,d.reminder_id,d.subscription_id,d.payload,d.attempts`);

  for (const row of rows) {
    result.processed += 1;
    try {
      const [sub] = await db.execute<{
        endpoint: string;
        p256dh: string;
        auth: string;
        id: string;
      }>(sql`select id,endpoint,p256dh,auth from push_subscriptions where id=${row.subscription_id}`);
      if (!sub) {
        // Subscription already removed (e.g. by a 410 from a sibling pass):
        // terminal, no retry, no error surfaced beyond the delivery row.
        await terminal(row.id, lease, 'SUBSCRIPTION_GONE');
        result.gone += 1;
        continue;
      }
      let statusCode: number;
      try {
        statusCode = (await transport.send({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, row.payload)).statusCode;
      } catch {
        statusCode = 503;
      }
      if (statusCode >= 200 && statusCode < 300) {
        await db.execute(sql`update push_deliveries set status='SENT',sent_at=now(),payload='',lease_token=null,lease_until=null,last_error=null
          where id=${row.id} and lease_token=${lease}`);
        result.sent += 1;
      } else if (statusCode === 404 || statusCode === 410) {
        // Subscription gone: remove it (idempotent) and stop retrying it.
        await db.execute(sql`delete from push_subscriptions where id=${sub.id}`);
        await terminal(row.id, lease, 'SUBSCRIPTION_GONE');
        result.gone += 1;
      } else {
        const terminalFail = Number(row.attempts) >= MAX_ATTEMPTS;
        const delaySeconds = Math.min(300, 2 ** Number(row.attempts));
        await db.execute(sql`update push_deliveries set status=${terminalFail ? 'FAILED' : 'PENDING'},
          last_error=${terminalFail ? 'PUSH_DELIVERY_FAILED' : 'PUSH_DELIVERY_FAILED'},
          next_attempt_at=now()+${delaySeconds}*interval '1 second',
          payload=${terminalFail ? '' : row.payload},
          lease_token=null,lease_until=null
          where id=${row.id} and lease_token=${lease}`);
        if (terminalFail) result.failed += 1;
        else result.retrying += 1;
      }
    } catch {
      // Claim lost or storage failure: release the lease so another pass
      // can claim it; never hold a poisoned row hostage.
      await db
        .execute(sql`update push_deliveries set status='PENDING',lease_token=null,lease_until=null
          where id=${row.id} and lease_token=${lease}`)
        .catch(() => undefined);
      result.retrying += 1;
    }
  }

  if (rows.length) {
    await refreshReminderPushErrors(db, rows.map((r) => r.reminder_id));
  }
  return result;

  async function terminal(deliveryId: string, leaseToken: string, error: string) {
    await db.execute(sql`update push_deliveries set status='FAILED',last_error=${error},payload='',lease_token=null,lease_until=null
      where id=${deliveryId} and lease_token=${leaseToken}`);
  }
}

/**
 * Exposes terminal push-delivery outcomes through the existing reminder
 * history (the notification center's "delivery status" surface), without
 * mutating the reminder status (the delivery was recorded: SENT).
 *
 * - any SENT            -> last_error null
 * - all terminal, and at least one provider failure -> 'PUSH_DELIVERY_FAILED'
 * - all terminal, and all subscriptions gone        -> 'PUSH_SUBSCRIPTIONS_GONE'
 * - still in flight                       -> untouched
 */
async function refreshReminderPushErrors(db: Database, reminderIds: string[]): Promise<void> {
  if (!reminderIds.length) return;
  // UUIDs only (server-generated); build a safely-quoted array literal.
  const ids = [...new Set(reminderIds)].filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  if (!ids.length) return;
  const list = `{${ids.map((id) => `"${id}"`).join(',')}}`;
  await db.execute(sql`
    with per_reminder as (
      select d.reminder_id,
        bool_or(d.status='SENT') as any_sent,
        bool_or(d.status='FAILED' and d.last_error='PUSH_DELIVERY_FAILED') as any_push_failed,
        bool_or(d.status='FAILED' and d.last_error='SUBSCRIPTION_GONE') as any_gone,
        bool_or(d.status in ('PENDING','PROCESSING')) as in_flight
      from push_deliveries d
      where d.reminder_id = any(${list}::uuid[])
      group by d.reminder_id
    )
    update reminders r set last_error = case
      when pr.any_sent then null
      when pr.any_push_failed then 'PUSH_DELIVERY_FAILED'
      when pr.any_gone then 'PUSH_SUBSCRIPTIONS_GONE'
      else r.last_error
    end
    from per_reminder pr
    where r.id = pr.reminder_id and r.status='SENT' and not pr.in_flight`);
}
