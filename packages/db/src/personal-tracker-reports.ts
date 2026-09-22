import { randomUUID } from 'node:crypto';
import { and, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { personalTrackerReport, trackerDate } from '@nextdoo/core';
import { type Database } from './client';
import { personalTrackers, personalTrackerEntries, personalTrackerReports, users } from './schema';
import { sealSecret } from './secrets';

export interface TrackerReportDelivery { smtpConfigured: boolean; authSecret: string; mailFrom: string; appUrl: string; }
export function previousTrackerMonth(at: Date, timeZone: string) {
  const today = trackerDate(at, timeZone), first = new Date(today.slice(0, 7) + '-01T00:00:00Z');
  const end = new Date(first.getTime() - 86400000).toISOString().slice(0, 10);
  return { period: end.slice(0, 7), from: end.slice(0, 7) + '-01', to: end };
}
/** Report scheduling is independent per tracker; missing providers never become SENT. */
export async function schedulePersonalTrackerReports(db: Database, config: TrackerReportDelivery, now = new Date(), workspaceId?: string) {
  await db.execute(sql`update personal_tracker_reports r set status=m.status,reason=m.last_error,updated_at=now() from mail_deliveries m
    where r.mail_delivery_id=m.id and r.status='QUEUED' and m.status in ('SENT','FAILED','EXPIRED')`);
  const candidates = await db.execute<{ id: string; workspace_id: string; owner_id: string }>(sql`
    select tr.id,tr.workspace_id,w.owner_id from personal_trackers tr join workspaces w on w.id=tr.workspace_id join users u on u.id=w.owner_id
    where tr.state='ACTIVE' and tr.delivery->>'enabled'='true'
      and u.status='ACTIVE' and u.deleted_at is null and u.deletion_requested_at is null and w.deleted_at is null
      and (${workspaceId ? sql`tr.workspace_id=${workspaceId}` : sql`true`})
      and (extract(day from ${now.toISOString()}::timestamptz at time zone tr.time_zone) > (tr.delivery->>'dayOfMonth')::int
        or (extract(day from ${now.toISOString()}::timestamptz at time zone tr.time_zone) = (tr.delivery->>'dayOfMonth')::int
          and extract(hour from ${now.toISOString()}::timestamptz at time zone tr.time_zone)*60+extract(minute from ${now.toISOString()}::timestamptz at time zone tr.time_zone) >= (tr.delivery->>'hour')::int*60+(tr.delivery->>'minute')::int))
      and tr.start_date < date_trunc('month',${now.toISOString()}::timestamptz at time zone tr.time_zone)::date
      and not exists(select 1 from personal_tracker_reports r where r.tracker_id=tr.id
        and r.period=to_char((${now.toISOString()}::timestamptz at time zone tr.time_zone)-interval '1 month','YYYY-MM')
        and (r.status<>'BLOCKED' or (r.channel=tr.delivery->>'channel' and (r.channel<>'EMAIL' or ${!config.smtpConfigured || !config.authSecret}))))
    order by tr.id limit 50`);
  let queued = 0, blocked = 0, deferred = 0;
  const started = performance.now();
  for (const candidate of candidates) {
    if (performance.now() - started > 20000) break;
    try {
      const result = await db.transaction(async (tx) => {
        const work = tx as unknown as Database;
        await work.execute(sql`set local lock_timeout='500ms'`); await work.execute(sql`set local statement_timeout='8s'`);
        await work.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'workspace:' + candidate.workspace_id},0))`);
        const [owner] = await work.select().from(users).where(and(eq(users.id, candidate.owner_id), eq(users.status, 'ACTIVE'), isNull(users.deletedAt), isNull(users.deletionRequestedAt))).for('share');
        const [tracker] = await work.select().from(personalTrackers).where(eq(personalTrackers.id, candidate.id));
        if (!owner || !tracker || tracker.state !== 'ACTIVE' || !tracker.delivery.enabled) return 'ignored';
        const range = previousTrackerMonth(now, tracker.timeZone);
        const localDay = Number(trackerDate(now, tracker.timeZone).slice(-2));
        const localClock = new Intl.DateTimeFormat('en-GB', { timeZone: tracker.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now).split(':').map(Number);
        if (tracker.startDate > range.to || localDay < tracker.delivery.dayOfMonth || (localDay === tracker.delivery.dayOfMonth && localClock[0]! * 60 + localClock[1]! < tracker.delivery.hour * 60 + tracker.delivery.minute)) return 'ignored';
        const [existing] = await work.select().from(personalTrackerReports).where(and(eq(personalTrackerReports.trackerId, tracker.id), eq(personalTrackerReports.period, range.period)));
        if (existing && existing.status !== 'BLOCKED') return 'ignored';
        const rows = await work.select({ day: personalTrackerEntries.day, stars: personalTrackerEntries.stars, statusName: personalTrackerEntries.statusName,
          sourceCount: sql<number>`(select count(distinct s.task_identity)::int from personal_tracker_sources s where s.entry_id=personal_tracker_entries.id)` }).from(personalTrackerEntries)
          .where(and(eq(personalTrackerEntries.trackerId, tracker.id), eq(personalTrackerEntries.workspaceId, tracker.workspaceId), isNull(personalTrackerEntries.deletedAt), gte(personalTrackerEntries.day, range.from), lte(personalTrackerEntries.day, range.to)));
        const summary = personalTrackerReport(tracker.startDate, range.from, range.to, rows);
        const supported = tracker.delivery.channel === 'EMAIL' && config.smtpConfigured && Boolean(config.authSecret);
        const reason = supported ? null : tracker.delivery.channel === 'EMAIL' ? 'SMTP_NOT_CONFIGURED' : 'PROVIDER_NOT_IMPLEMENTED';
        const id = existing?.id ?? randomUUID();
        if (!existing) await work.insert(personalTrackerReports).values({ id, workspaceId: tracker.workspaceId, trackerId: tracker.id, period: range.period, channel: tracker.delivery.channel, status: 'BLOCKED', summary, reason });
        if (!supported) {
          await work.update(personalTrackerReports).set({ reason, channel: tracker.delivery.channel, summary, updatedAt: new Date() }).where(eq(personalTrackerReports.id, id));
          return 'blocked';
        }
        const format = (value: number | null) => value === null ? 'Not measured' : value.toFixed(2);
        const message = { to: owner.email, from: config.mailFrom, subject: `NEXTDOO tracker report — ${range.period}`, text:
          `${tracker.name}\n${range.from} through ${range.to}\n\nTotal stars: ${summary.totalStars}\nAverage stars (calendar days): ${format(summary.averageStars)}\nRelative stars (tracked days): ${format(summary.relativeStars)}\nCalendar days: ${summary.calendarDays}\nTracked days: ${summary.trackedDays}\nNon-tracking days: ${summary.nonTrackingDays}\nUnscored days: ${summary.unscoredDays}\n\n${new URL('/trackers/' + tracker.id, config.appUrl).toString()}` };
        const mailId = randomUUID(), encrypted = sealSecret(JSON.stringify(message), config.authSecret, 'mail');
        await work.execute(sql`insert into mail_deliveries(id,user_id,kind,encrypted_message,expires_at)
          values(${mailId},${owner.id},'tracker-monthly-report',${encrypted},${new Date(now.getTime() + 7 * 86400000).toISOString()}::timestamptz)`);
        await work.update(personalTrackerReports).set({ status: 'QUEUED', reason: null, channel: 'EMAIL', summary, mailDeliveryId: mailId, updatedAt: new Date() }).where(eq(personalTrackerReports.id, id));
        return 'queued';
      });
      if (result === 'queued') queued++; if (result === 'blocked') blocked++;
    } catch { deferred++; }
  }
  return { queued, blocked, deferred };
}
