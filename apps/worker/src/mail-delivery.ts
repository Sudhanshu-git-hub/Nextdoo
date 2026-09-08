import { createHash, randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { sql } from 'drizzle-orm';
import { openSecret } from '@nextdoo/db';
import { db } from './runtime';

/** Bounded, durable at-least-once SMTP delivery; external exactly-once is NOT claimed. */
export async function deliverMail(limit = 10): Promise<{ processed: number; sent: number; failed: number }> {
  const smtp = process.env.SMTP_URL, secret = process.env.AUTH_SECRET;
  if (!smtp || !secret) return { processed: 0, sent: 0, failed: 0 };
  const url = new URL(smtp);
  if (!['smtp:', 'smtps:'].includes(url.protocol)) throw new Error('Unsupported SMTP protocol');
  const transport = nodemailer.createTransport({
    host: url.hostname, port: Number(url.port || (url.protocol === 'smtps:' ? 465 : 587)), secure: url.protocol === 'smtps:',
    requireTLS: process.env.NODE_ENV === 'production',
    auth: url.username ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } : undefined,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000,
    disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false,
  });
  limit = Math.max(0, Math.min(10, Math.floor(limit)));
  const lease = randomUUID();
  await db.execute(sql`update mail_deliveries set status='FAILED',last_error='LEASE_EXPIRED',lease_token=null,lease_until=null
    where status='PROCESSING' and lease_until < now() and attempts >= 5`);
  await db.execute(sql`update mail_deliveries set encrypted_message='' where expires_at <= now() and status in ('SENT','FAILED','EXPIRED')`);
  await db.execute(sql`update mail_deliveries set status='EXPIRED',encrypted_message='',lease_token=null,lease_until=null
    where expires_at <= now() and status in ('PENDING','PROCESSING') and (lease_until is null or lease_until < now())`);
  const rows = await db.execute(sql`with claim as (
    select id from mail_deliveries where expires_at > now() and attempts < 5
      and ((status='PENDING' and next_attempt_at <= now()) or (status='PROCESSING' and lease_until < now()))
      order by created_at,id limit ${limit} for update skip locked
    ) update mail_deliveries m set status='PROCESSING',lease_token=${lease},lease_until=now()+interval '10 minutes',attempts=m.attempts+1
      from claim where m.id=claim.id returning m.*`);
  let sent = 0, failed = 0;
  try {
    for (const row of rows) {
      try {
        const message = JSON.parse(openSecret(String(row.encrypted_message), secret, 'mail'));
        if (row.kind === 'reset-password' || row.kind === 'verify-email') {
          const token = new URL(message.url).searchParams.get('token');
          const hash = createHash('sha256').update(token ?? '').digest('hex');
          const active = await db.execute(sql`select id from auth_tokens where token_hash=${hash} and consumed_at is null and expires_at > now()`);
          if (!active.length) {
            await db.execute(sql`update mail_deliveries set status='EXPIRED',encrypted_message='',lease_token=null,lease_until=null where id=${row.id} and lease_token=${lease}`);
            continue;
          }
        }
        const result = await transport.sendMail({ from: message.from, to: message.to, subject: message.subject, text: message.text, messageId: `<${row.id}@nextdoo.local>` });
        if (!result.accepted?.length || result.rejected?.length) throw new Error('SMTP did not acknowledge recipient');
        await db.execute(sql`update mail_deliveries set status='SENT',sent_at=now(),encrypted_message='',lease_token=null,lease_until=null,last_error=null where id=${row.id} and lease_token=${lease}`);
        sent++;
      } catch {
        failed++;
        // Never store SMTP response strings/credentials. Payload stays encrypted
        // for bounded retries/operator inspection until expiry or account purge.
        const terminal = Number(row.attempts) >= 5;
        const delay = Math.min(300, 2 ** Number(row.attempts));
        await db.execute(sql`update mail_deliveries set status=${terminal ? 'FAILED' : 'PENDING'},last_error='SMTP_DELIVERY_FAILED',
          next_attempt_at=now()+${delay}*interval '1 second',lease_token=null,lease_until=null
          where id=${row.id} and lease_token=${lease}`);
      }
    }
  } finally { transport.close(); }
  return { processed: rows.length, sent, failed };
}
