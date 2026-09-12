import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from './client';
import { trackingBackfills, users, workspaces } from './schema';

const BATCH = 5;
/** Full precision, explicit UTC: JavaScript millisecond truncation must not gate PG claims. */
const clock = sql`clock_timestamp()`;

/**
 * Bounded date-range recalculation (PRD §7.6): "enqueue a bounded backfill
 * (default: last 90 days, chunked by workspace and day, rate-limited).
 * Historical results are superseded, never mutated, and remain queryable."
 *
 * One `tracking_backfills` row per requested range. Each run processes at most
 * `BATCH` ranges and exactly one day per range, atomically: the day's tasks
 * get their `tracking_jobs` revision bumped (the existing CAS + lease
 * machinery, consumed by `tracking.evaluate`) and only then does the cursor
 * advance. A crash between the two cannot happen — they commit together — and
 * a day is never processed twice.
 *
 * Day mapping is UTC instants, the same partitioning the day summary uses, so
 * every due/completed instant belongs to exactly one chunk.
 */
export async function runTrackingBackfill(db: Database, workspaceId?: string): Promise<{ days: number; bumps: number; completed: number }> {
  const pending = await db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout='8s'`);
    return tx
      .select({ backfill: trackingBackfills })
      .from(trackingBackfills)
      .innerJoin(workspaces, eq(trackingBackfills.workspaceId, workspaces.id))
      .innerJoin(users, eq(workspaces.ownerId, users.id))
      .where(
        and(
          eq(trackingBackfills.status, 'PENDING'),
          isNull(workspaces.deletedAt),
          isNull(users.deletedAt),
          isNull(users.deletionRequestedAt),
          eq(users.status, 'ACTIVE'),
          workspaceId ? eq(trackingBackfills.workspaceId, workspaceId) : undefined,
        ),
      )
      .orderBy(asc(trackingBackfills.createdAt), asc(trackingBackfills.id))
      .limit(BATCH);
  });

  const result = { days: 0, bumps: 0, completed: 0 };
  for (const { backfill } of pending) {
    const day = await processOneDay(db, backfill);
    if (!day) continue; // lost the race to another run
    result.days += 1;
    result.bumps += day.bumps;
    if (day.finished) result.completed += 1;
  }
  return result;
}

async function processOneDay(
  db: Database,
  backfill: typeof trackingBackfills.$inferSelect,
): Promise<{ bumps: number; finished: boolean } | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout='8s'`);
    await tx.execute(sql`set local lock_timeout='500ms'`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'workspace:' + backfill.workspaceId}, 0))`);
    const owner = await tx.execute(
      sql`select u.id from users u join workspaces w on w.owner_id=u.id
      where w.id=${backfill.workspaceId} and w.deleted_at is null and u.deleted_at is null and u.deletion_requested_at is null and u.status='ACTIVE' for share of u`,
    );
    if (!owner.length) return;

    // Claim the chunk: exactly one run can advance this cursor_date.
    const [claimed] = await tx
      .select()
      .from(trackingBackfills)
      .where(and(eq(trackingBackfills.id, backfill.id), eq(trackingBackfills.status, 'PENDING'), eq(trackingBackfills.cursorDate, backfill.cursorDate)))
      .for('update');
    if (!claimed) return;

    // Force re-evaluation of every task whose due or completed instant falls
    // on this UTC day. Bumping the revision reuses the existing fenced,
    // retried evaluation path; unchanged inputs remain idempotent no-ops.
    const bumped = await tx.execute(
      sql`update tracking_jobs j set revision=j.revision+1, queued_revision=j.revision+1,
        next_evaluation_at=null, next_attempt_at=${clock}, claim_token=null, lease_expires_at=null,
        attempts=0, last_error=null, last_error_at=null
       from tasks t
      where j.task_id=t.id and j.workspace_id=t.workspace_id and t.workspace_id=${claimed.workspaceId}
        and t.deleted_at is null and t.status<>'DELETED'
        and ((t.due_at is not null and (t.due_at at time zone 'UTC') = ${claimed.cursorDate})
          or (t.completed_at is not null and (t.completed_at at time zone 'UTC') = ${claimed.cursorDate}))
      returning j.task_id`,
    );

    const finished = claimed.cursorDate >= claimed.toDate;
    const [updated] = await tx
      .update(trackingBackfills)
      .set({
        updatedAt: new Date(),
        cursorDate: finished ? claimed.cursorDate : sql`${trackingBackfills.cursorDate} + interval '1 day'`,
        status: finished ? 'COMPLETED' : 'PENDING',
      })
      .where(and(eq(trackingBackfills.id, claimed.id), eq(trackingBackfills.status, 'PENDING'), eq(trackingBackfills.cursorDate, claimed.cursorDate)))
      .returning();
    if (!updated) return;
    return { bumps: bumped.length, finished };
  });
}
