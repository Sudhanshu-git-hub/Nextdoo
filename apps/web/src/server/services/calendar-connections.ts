import { and, asc, count, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { AppError, limitsFor, notFound } from '@nextdoo/contracts';
import { calendarConnections, calendarEvents } from '@nextdoo/db';
import { getDb } from '../db';
import { encryptSecret } from '../crypto';
import { getPlan } from './accounts';
import { withWorkspaceTransaction } from './transactions';

/**
 * Calendar connections (PRD §13.2, §14.3) — the provider-aware half of
 * capacity planning.
 *
 * Rows are created only by a verified provider exchange (the Google OAuth
 * callback, M6 integration); this module is that seam. Tokens are
 * envelope-encrypted and never leave the server. Connection state drives the
 * daily capacity rule in `capacity.ts`:
 *
 *  - no ACTIVE connections  → capacity is known from workspace settings;
 *  - ACTIVE connections that have synced through the planned day → capacity
 *    is known from workday window minus provider busy time;
 *  - an ACTIVE connection that has not synced through the day → capacity is
 *    UNKNOWN and no feasibility claim is made (PRD §5.2).
 *
 * Plan entitlements (PRD §18.1) cap ACTIVE connections per plan; on a
 * downgrade the over-limit rows are SUSPENDED (never deleted), and on an
 * upgrade suspended rows are re-activated up to the limit.
 */

const CALENDAR_TOKEN_PURPOSE = 'calendar_token';
/** Providers with a defined verified exchange; Outlook/CalDAV are deferred (PRD M6). */
const CONNECTABLE_PROVIDERS = new Set(['google']);

export type ConnectionState = 'ACTIVE' | 'SUSPENDED' | 'DISCONNECTED';

export interface CalendarConnectionView {
  id: string;
  provider: string;
  mode: string;
  status: ConnectionState;
  externalAccountId: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
}

export interface VerifiedConnectionInput {
  /** Only 'google' today; the provider's verified account identifier. */
  provider: string;
  externalAccountId?: string | null;
  accessToken: string;
  refreshToken?: string | null;
  tokenExpiresAt?: string | null;
  scopes?: string | null;
  mode?: 'READ_ONLY' | 'READ_WRITE';
}

function serialise(row: typeof calendarConnections.$inferSelect): CalendarConnectionView {
  return {
    id: row.id,
    provider: row.provider,
    mode: row.mode,
    status: row.status as ConnectionState,
    externalAccountId: row.externalAccountId,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function seal(input: Pick<VerifiedConnectionInput, 'accessToken' | 'refreshToken' | 'tokenExpiresAt' | 'scopes'>) {
  return {
    accessTokenEncrypted: encryptSecret(input.accessToken, CALENDAR_TOKEN_PURPOSE),
    refreshTokenEncrypted: input.refreshToken ? encryptSecret(input.refreshToken, CALENDAR_TOKEN_PURPOSE) : null,
    tokenExpiresAt: input.tokenExpiresAt ? new Date(input.tokenExpiresAt) : null,
    scopes: input.scopes ?? null,
  };
}

/** The user's connections — provider/metadata only, never tokens. */
export async function listConnections(userId: string): Promise<CalendarConnectionView[]> {
  const rows = await getDb()
    .select()
    .from(calendarConnections)
    .where(eq(calendarConnections.userId, userId))
    .orderBy(asc(calendarConnections.createdAt), asc(calendarConnections.id));
  return rows.map(serialise);
}

/**
 * Records a connection produced by a verified provider exchange. One
 * connection per (user, provider): re-exchanging replaces the tokens. A
 * re-connect after a full disconnect counts against the plan limit again.
 */
export async function upsertVerifiedConnection(
  userId: string,
  workspaceId: string,
  input: VerifiedConnectionInput,
): Promise<CalendarConnectionView> {
  if (!CONNECTABLE_PROVIDERS.has(input.provider)) {
    throw new AppError('VALIDATION_FAILED', `Unsupported calendar provider: ${input.provider}.`);
  }
  if (!input.accessToken || !input.accessToken.trim()) {
    throw new AppError('VALIDATION_FAILED', 'A verified access token is required.');
  }

  const plan = await getPlan(userId);
  const limit = limitsFor(plan).calendarConnections;

  return withWorkspaceTransaction(workspaceId, async (db) => {
    const [existing] = await db
      .select()
      .from(calendarConnections)
      .where(and(eq(calendarConnections.userId, userId), eq(calendarConnections.provider, input.provider)))
      .limit(1);

    if (existing && existing.status !== 'DISCONNECTED') {
      // Slot already counted: replace the credentials and reactivate.
      const [row] = await db
        .update(calendarConnections)
        .set({
          ...seal(input),
          externalAccountId: input.externalAccountId ?? existing.externalAccountId,
          workspaceId,
          mode: input.mode ?? existing.mode,
          status: 'ACTIVE',
          version: sql`${calendarConnections.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(calendarConnections.id, existing.id))
        .returning();
      if (!row) throw notFound('calendar connection', existing.id);
      return serialise(row);
    }

    // New connection, or a re-connect after disconnect: it must fit the plan.
    const [countRow] = await db
      .select({ n: count() })
      .from(calendarConnections)
      .where(and(eq(calendarConnections.userId, userId), eq(calendarConnections.status, 'ACTIVE')));
    if ((countRow?.n ?? 0) >= limit) {
      throw new AppError('ENTITLEMENT_LIMIT_REACHED', `Your plan allows ${limit} calendar connection${limit === 1 ? '' : 's'}. Disconnect one to add another.`);
    }

    const credentialValues = {
      ...seal(input),
      provider: input.provider,
      externalAccountId: input.externalAccountId ?? null,
      mode: input.mode ?? 'READ_ONLY',
      status: 'ACTIVE' as const,
      updatedAt: new Date(),
    };
    if (existing) {
      const [row] = await db
        .update(calendarConnections)
        .set({
          ...credentialValues,
          mode: input.mode ?? existing.mode,
          version: sql`${calendarConnections.version} + 1`,
          userId,
          workspaceId,
          disconnectedAt: null,
        })
        .where(eq(calendarConnections.id, existing.id))
        .returning();
      if (!row) throw notFound('calendar connection', existing.id);
      return serialise(row);
    }
    const [row] = await db
      .insert(calendarConnections)
      .values({
        id: crypto.randomUUID(),
        userId,
        workspaceId,
        ...credentialValues,
      })
      .returning();
    if (!row) throw new AppError('INTERNAL_ERROR', 'Connection insert returned no row.');
    return serialise(row);
  });
}

/** Disconnect: soft state change; the row (and sealed tokens) is retained. */
export async function disconnectConnection(userId: string, connectionId: string): Promise<CalendarConnectionView> {
  const db = getDb();
  const [row] = await db
    .update(calendarConnections)
    .set({
      status: 'DISCONNECTED',
      disconnectedAt: new Date(),
      version: sql`${calendarConnections.version} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(calendarConnections.id, connectionId), eq(calendarConnections.userId, userId)))
    .returning();
  if (!row) throw notFound('calendar connection', connectionId);
  return serialise(row);
}

export interface PlanChangeResult {
  suspended: number;
  reactivated: number;
}

/**
 * Applies an entitlement change (the webhook/reconciliation seam; PRD §16.15,
 * SD-04). Never deletes user data: over-limit ACTIVE connections are
 * SUSPENDED (newest first, deterministic), and previously suspended ones are
 * re-activated oldest-first when the plan grows.
 */
export async function applyCalendarPlanChange(userId: string, plan: 'FREE' | 'PRO' | 'TEAM' | 'ENTERPRISE'): Promise<PlanChangeResult> {
  const limit = limitsFor(plan).calendarConnections;
  const db = getDb();

  const active = await db
    .select()
    .from(calendarConnections)
    .where(and(eq(calendarConnections.userId, userId), eq(calendarConnections.status, 'ACTIVE')))
    .orderBy(asc(calendarConnections.createdAt), asc(calendarConnections.id));

  const excess = active.length - limit;
  if (excess > 0) {
    const toSuspend = active.slice(-excess).map((row) => row.id);
    await db
      .update(calendarConnections)
      .set({ status: 'SUSPENDED', version: sql`${calendarConnections.version} + 1`, updatedAt: new Date() })
      .where(and(eq(calendarConnections.userId, userId), inArray(calendarConnections.id, toSuspend)));
    return { suspended: toSuspend.length, reactivated: 0 };
  }

  const slots = -excess;
  if (slots > 0) {
    const suspended = await db
      .select()
      .from(calendarConnections)
      .where(and(eq(calendarConnections.userId, userId), eq(calendarConnections.status, 'SUSPENDED')))
      .orderBy(asc(calendarConnections.createdAt), asc(calendarConnections.id))
      .limit(slots);
    if (suspended.length) {
      await db
        .update(calendarConnections)
        .set({ status: 'ACTIVE', version: sql`${calendarConnections.version} + 1`, updatedAt: new Date() })
        .where(and(eq(calendarConnections.userId, userId), inArray(calendarConnections.id, suspended.map((r) => r.id))));
    }
    return { suspended: 0, reactivated: suspended.length };
  }
  return { suspended: 0, reactivated: 0 };
}

export interface CapacityConnectionState {
  /** At least one ACTIVE connection for (user, workspace). */
  connected: boolean;
  /**
   * The minimum lastSyncedAt across the workspace's ACTIVE connections, when
   * every one of them has synced; null while any connection is behind.
   */
  syncedThrough: Date | null;
}

/** Connection state that drives the capacity rule for one workspace. */
export async function capacityConnectionState(userId: string, workspaceId: string): Promise<CapacityConnectionState> {
  const rows = await getDb()
    .select({ lastSyncedAt: calendarConnections.lastSyncedAt })
    .from(calendarConnections)
    .where(and(eq(calendarConnections.userId, userId), eq(calendarConnections.workspaceId, workspaceId), eq(calendarConnections.status, 'ACTIVE')));
  if (rows.length === 0) return { connected: false, syncedThrough: null };
  const syncedThrough = rows.reduce<Date | null>((min, row) => {
    if (!row.lastSyncedAt) return null;
    return min === null || row.lastSyncedAt < min ? row.lastSyncedAt : min;
  }, null);
  return { connected: true, syncedThrough };
}

/**
 * Busy intervals (UTC ms) for the workspace's ACTIVE connections overlapping
 * [dayStartUtc, dayEndUtc). All-day events expand to the whole day.
 */
export async function busyIntervalsForDay(
  userId: string,
  workspaceId: string,
  dayStartUtc: Date,
  dayEndUtc: Date,
): Promise<Array<{ startMs: number; endMs: number }>> {
  const conns = await getDb()
    .select({ id: calendarConnections.id })
    .from(calendarConnections)
    .where(and(eq(calendarConnections.userId, userId), eq(calendarConnections.workspaceId, workspaceId), eq(calendarConnections.status, 'ACTIVE')));
  if (conns.length === 0) return [];

  const events = await getDb()
    .select({ startsAt: calendarEvents.startsAt, endsAt: calendarEvents.endsAt, isAllDay: calendarEvents.isAllDay })
    .from(calendarEvents)
    .where(
      and(
        inArray(calendarEvents.connectionId, conns.map((c) => c.id)),
        eq(calendarEvents.busy, true),
        lte(calendarEvents.startsAt, dayEndUtc),
        gt(calendarEvents.endsAt, dayStartUtc),
      ),
    );
  return events.map((e) =>
    e.isAllDay
      ? { startMs: dayStartUtc.getTime(), endMs: dayEndUtc.getTime() }
      : { startMs: e.startsAt.getTime(), endMs: e.endsAt.getTime() },
  );
}
