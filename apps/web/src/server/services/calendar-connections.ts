import { createHash } from 'node:crypto';
import { and, asc, count, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { AppError, limitsFor, notFound, type CalendarProvider, type CalendarTokenSet } from '@nextdoo/contracts';
import { applyTaskDueChange, calendarConnections, calendarEvents, calendarMappings, calendarOauthStates, finalizeDisconnect, tasks, tokensChanged } from '@nextdoo/db';
import { getDb } from '../db';
import { decryptSecret, encryptSecret } from '../crypto';
import { getEnv } from '../env';
import { createGoogleCalendar } from '@nextdoo/calendar';
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

/**
 * Disconnect (PRD §16.5): revoke where supported, wipe the tokens from
 * storage, stop sync immediately. The row and its mappings are retained as
 * metadata for 30 days (purged by the worker retention sweep); imported
 * tasks remain and exported events are NOT auto-deleted.
 */
export async function disconnectConnection(userId: string, connectionId: string): Promise<CalendarConnectionView> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(calendarConnections)
    .where(and(eq(calendarConnections.id, connectionId), eq(calendarConnections.userId, userId)))
    .limit(1);
  if (!row) throw notFound('calendar connection', connectionId);
  await finalizeDisconnect(db, connectionId, buildCalendarProvider(row));
  const [updated] = await db.select().from(calendarConnections).where(eq(calendarConnections.id, connectionId)).limit(1);
  if (!updated) throw notFound('calendar connection', connectionId);
  return serialise(updated);
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

/* ------------------------------------------------------------------ */
/* M7 — Google two-way sync (PRD §16, §14.3)                          */
/* ------------------------------------------------------------------ */

/**
 * Google OAuth configuration. The feature is gated on presence (like
 * billing): an unconfigured deployment answers 503 PROVIDER_UNAVAILABLE
 * and the UI degrades honestly — there is no stub provider.
 */
export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

let googleConfigOverride: (() => GoogleConfig | null) | null = null;

/** Test seam: swap the provider configuration (each test file gets a fresh module). */
export function setGoogleConfigForTests(fn: (() => GoogleConfig | null) | null): void {
  googleConfigOverride = fn;
}

export function googleConfig(): GoogleConfig | null {
  if (googleConfigOverride) return googleConfigOverride();
  const env = getEnv();
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${env.APP_URL}/api/v1/calendar/connections/google/callback`,
  };
}

/**
 * Test seam: swap the provider factory (each test file gets a fresh
 * module registry, so the override never leaks between files). The product
 * path always builds the real Google adapter from the stored credentials.
 */
let providerFactoryForTests: ((row?: typeof calendarConnections.$inferSelect) => CalendarProvider | null) | null = null;

export function setCalendarProviderFactoryForTests(fn: ((row?: typeof calendarConnections.$inferSelect) => CalendarProvider | null) | null): void {
  providerFactoryForTests = fn;
}

/**
 * The stored (sealed) token set, opened. Throws on a malformed/tampered
 * envelope — the caller decides the failure semantics (today: the provider
 * build fails, exactly as before M8-i4).
 */
export function calendarProviderTokens(row: typeof calendarConnections.$inferSelect): CalendarTokenSet | null {
  if (!row.accessTokenEncrypted) return null;
  return {
    accessToken: decryptSecret(row.accessTokenEncrypted, CALENDAR_TOKEN_PURPOSE),
    refreshToken: row.refreshTokenEncrypted ? decryptSecret(row.refreshTokenEncrypted, CALENDAR_TOKEN_PURPOSE) : null,
    expiresAt: row.tokenExpiresAt ? row.tokenExpiresAt.toISOString() : null,
    scopes: row.scopes ?? null,
  };
}

/** Build a provider bound to a stored connection (opened, sealed tokens). */
export function buildCalendarProvider(row: typeof calendarConnections.$inferSelect): CalendarProvider | null {
  if (providerFactoryForTests) return providerFactoryForTests(row);
  const cfg = googleConfig();
  if (!cfg || !row.accessTokenEncrypted) return null;
  return createGoogleCalendar({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    redirectUri: cfg.redirectUri,
    initialTokens: calendarProviderTokens(row)!,
  });
}

/** The OAuth state row: single-use, short-lived (PRD §16.1 PKCE flow). */
const OAUTH_STATE_TTL_MS = 10 * 60_000;

async function storeOauthState(userId: string, workspaceId: string, mode: 'READ_ONLY' | 'READ_WRITE', state: string, codeVerifier: string): Promise<void> {
  await getDb().insert(calendarOauthStates).values({
    stateHash: createHash('sha256').update(state).digest('hex'),
    userId,
    workspaceId,
    mode,
    codeVerifier,
    expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
  });
}

async function takeOauthState(state: string) {
  const hash = createHash('sha256').update(state).digest('hex');
  const db = getDb();
  const [row] = await db.select().from(calendarOauthStates).where(eq(calendarOauthStates.stateHash, hash)).limit(1);
  if (!row || row.expiresAt.getTime() <= Date.now()) return null;
  await db.delete(calendarOauthStates).where(eq(calendarOauthStates.stateHash, hash)); // single-use
  return row;
}

/**
 * PRD §16.2: the sync mode is chosen BEFORE authorization. Starts the
 * Google OAuth code + PKCE flow and returns the redirect URL.
 */
export async function startGoogleAuthorization(userId: string, workspaceId: string, mode: 'READ_ONLY' | 'READ_WRITE'): Promise<{ authorizationUrl: string }> {
  const cfg = googleConfig();
  if (!cfg) {
    throw new AppError('PROVIDER_UNAVAILABLE', 'Calendar sync is not configured in this deployment.');
  }
  const provider = providerFactoryForTests
    ? providerFactoryForTests()
    : createGoogleCalendar({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri: cfg.redirectUri });
  if (!provider) throw new AppError('PROVIDER_UNAVAILABLE', 'Calendar sync is not configured in this deployment.');
  const { authorizationUrl, state, codeVerifier } = await provider.beginAuthorization(mode);
  await storeOauthState(userId, workspaceId, mode, state, codeVerifier);
  return { authorizationUrl };
}

/**
 * The OAuth callback (public; the state hash is the credential). Finishes
 * the exchange, applies the plan/entitlement rules via the verified
 * upsert, and reports the resulting connection.
 */
export async function completeGoogleCallback(state: string, code: string): Promise<CalendarConnectionView> {
  const stored = await takeOauthState(state);
  if (!stored) throw new AppError('VALIDATION_FAILED', 'The calendar sign-in state is missing or expired. Start again.');
  const cfg = googleConfig();
  if (!cfg) throw new AppError('PROVIDER_UNAVAILABLE', 'Calendar sync is not configured in this deployment.');
  if (!code || code.length > 500) throw new AppError('VALIDATION_FAILED', 'A valid authorization code is required.');
  const provider = providerFactoryForTests
    ? providerFactoryForTests()
    : createGoogleCalendar({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri: cfg.redirectUri });
  if (!provider) throw new AppError('PROVIDER_UNAVAILABLE', 'Calendar sync is not configured in this deployment.');
  const result = await provider.completeAuthorization(code, stored.codeVerifier);
  return upsertVerifiedConnection(stored.userId, stored.workspaceId, {
    provider: 'google',
    externalAccountId: result.externalAccountId,
    accessToken: result.tokens.accessToken,
    refreshToken: result.tokens.refreshToken,
    tokenExpiresAt: result.tokens.expiresAt,
    scopes: result.tokens.scopes,
    mode: stored.mode as 'READ_ONLY' | 'READ_WRITE',
  });
}

/**
 * Reconnect (PRD §16.6: the reconnect prompt). Re-runs the OAuth flow for
 * an existing connection — including a mode change, which needs a fresh
 * consent (scope change). This is the PATCH-connection semantics of
 * §14.3 for the credential-bound fields.
 */
export async function reconnectGoogleAuthorization(userId: string, connectionId: string, mode?: 'READ_ONLY' | 'READ_WRITE'): Promise<{ authorizationUrl: string; mode: 'READ_ONLY' | 'READ_WRITE' }> {
  const [row] = await getDb()
    .select()
    .from(calendarConnections)
    .where(and(eq(calendarConnections.id, connectionId), eq(calendarConnections.userId, userId)))
    .limit(1);
  if (!row) throw notFound('calendar connection', connectionId);
  if (row.provider !== 'google') throw new AppError('VALIDATION_FAILED', 'Only Google connections can be reconnected here.');
  const nextMode = mode ?? (row.mode as 'READ_ONLY' | 'READ_WRITE');
  const { authorizationUrl } = await startGoogleAuthorization(userId, row.workspaceId, nextMode);
  return { authorizationUrl, mode: nextMode };
}

/**
 * Manual sync (PRD §14.3 POST :id/sync): one import + (for READ_WRITE)
 * export pass now. Rate-limited passes are reported, not retried.
 */
export async function syncConnectionNow(userId: string, connectionId: string): Promise<{
  imported: number;
  conflicts: number;
  unscheduledTasks: number;
  exportedCreated: number;
  exportedUpdated: number;
  exportedDeleted: number;
  paused: string | null;
  rateLimitedSeconds: number | null;
}> {
  const { runCalendarImport, runCalendarExport } = await import('@nextdoo/db');
  const db = getDb();
  const [row] = await db
    .select()
    .from(calendarConnections)
    .where(and(eq(calendarConnections.id, connectionId), eq(calendarConnections.userId, userId)))
    .limit(1);
  if (!row) throw notFound('calendar connection', connectionId);
  if (row.status === 'SUSPENDED') {
    throw new AppError('RESOURCE_VERSION_CONFLICT', 'This calendar connection is paused. Reconnect to continue syncing.');
  }
  if (row.status === 'DISCONNECTED') throw new AppError('VALIDATION_FAILED', 'This calendar is disconnected.');
  const provider = buildCalendarProvider(row);
  if (!provider) throw new AppError('PROVIDER_UNAVAILABLE', 'Calendar sync is not configured in this deployment.');
  // M8-i4 (T1): the baseline the provider was opened with (null when the
  // envelope is missing/tampered — in which case there is nothing to compare
  // against and nothing to re-seal).
  let initial: CalendarTokenSet | null = null;
  try { initial = calendarProviderTokens(row); } catch { initial = null; }
  const ctx = { db, connectionId: row.id, provider, initialTokens: initial };
  const imp = await runCalendarImport(ctx);
  const exp = row.mode === 'READ_WRITE' ? await runCalendarExport(ctx) : { exportedCreated: 0, exportedUpdated: 0, exportedDeleted: 0 };
  // M8-i4 (T1): when the pass refreshed/rotated the token set, persist it
  // through the SAME sealed-envelope mechanism the OAuth callback used, so
  // the next pass runs with the new credentials (PRD §16.1 "cached until
  // expiry"). No plaintext at rest; no write when the set is unchanged.
  if (initial) {
    let current: CalendarTokenSet | null = null;
    try { current = provider.currentTokens(); } catch { current = null; }
    if (current && tokensChanged(initial, current)) {
      await db
        .update(calendarConnections)
        .set({
          accessTokenEncrypted: encryptSecret(current.accessToken, CALENDAR_TOKEN_PURPOSE),
          refreshTokenEncrypted: current.refreshToken ? encryptSecret(current.refreshToken, CALENDAR_TOKEN_PURPOSE) : null,
          tokenExpiresAt: current.expiresAt ? new Date(current.expiresAt) : null,
          scopes: current.scopes ?? sql`${calendarConnections.scopes}`,
        })
        .where(eq(calendarConnections.id, row.id));
    }
  }
  return {
    imported: imp.imported,
    conflicts: imp.conflicts,
    unscheduledTasks: imp.unscheduledTasks,
    exportedCreated: exp.exportedCreated,
    exportedUpdated: exp.exportedUpdated,
    exportedDeleted: exp.exportedDeleted,
    paused: imp.paused ?? (exp as { paused?: string | null }).paused ?? null,
    rateLimitedSeconds: imp.rateLimitedSeconds ?? (exp as { rateLimitedSeconds?: number | null }).rateLimitedSeconds ?? null,
  };
}

/** Normalized provider events for a window (read-only; PRD §14.3 GET /calendar/events). */
export interface CalendarEventView {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  timeZone: string | null;
  isAllDay: boolean;
  busy: boolean;
  source: string;
}

export async function listCalendarEvents(userId: string, fromIso: string, toIso: string): Promise<CalendarEventView[]> {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw new AppError('VALIDATION_FAILED', 'Provide a valid start/end window.');
  }
  const db = getDb();
  const conns = await db
    .select({ id: calendarConnections.id, provider: calendarConnections.provider })
    .from(calendarConnections)
    .where(and(eq(calendarConnections.userId, userId), eq(calendarConnections.status, 'ACTIVE')));
  if (conns.length === 0) return [];
  const rows = await db
    .select()
    .from(calendarEvents)
    .where(and(inArray(calendarEvents.connectionId, conns.map((c) => c.id)), lte(calendarEvents.startsAt, to), gt(calendarEvents.endsAt, from)))
    .orderBy(asc(calendarEvents.startsAt), asc(calendarEvents.id));
  return rows.map((e) => ({
    id: e.id,
    title: e.title ?? '',
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt.toISOString(),
    timeZone: e.timeZone,
    isAllDay: e.isAllDay,
    busy: e.busy,
    source: 'google',
  }));
}

/**
 * Push-channel webhook (PRD §16.1). The channel token is the connection
 * id, which Google echoes back in `channel.token`; it triggers an
 * immediate import for that connection only.
 */
export async function handleCalendarWebhook(channelToken: string): Promise<{ ok: boolean; imported: number }> {
  const db = getDb();
  const [row] = await db.select().from(calendarConnections).where(eq(calendarConnections.id, channelToken)).limit(1);
  if (!row || row.status !== 'ACTIVE') return { ok: false, imported: 0 };
  const provider = buildCalendarProvider(row);
  if (!provider) return { ok: false, imported: 0 };
  const { runCalendarImport } = await import('@nextdoo/db');
  const outcome = await runCalendarImport({ db, connectionId: row.id, provider });
  return { ok: true, imported: outcome.imported };
}

export type CalendarConflictAction = 'KEEP_TASK' | 'KEEP_CALENDAR' | 'UNLINK';

/**
 * Resolve a both-side conflict (PRD §16.4). The user sees both values and
 * chooses: keep the NEXTDOO task (patch the event), keep the calendar
 * event (reschedule the task through the task invariants), or unlink
 * (the mapping is removed; both sides stop syncing). Every decision is
 * audit-logged with the user as actor.
 */
export async function resolveCalendarConflict(
  userId: string,
  connectionId: string,
  mappingId: string,
  action: CalendarConflictAction,
): Promise<{ resolved: CalendarConflictAction; mappingId: string }> {
  const db = getDb();
  const [conn] = await db
    .select()
    .from(calendarConnections)
    .where(and(eq(calendarConnections.id, connectionId), eq(calendarConnections.userId, userId)))
    .limit(1);
  if (!conn) throw notFound('calendar connection', connectionId);
  if (conn.status !== 'ACTIVE') throw new AppError('RESOURCE_VERSION_CONFLICT', 'Reconnect the calendar before resolving conflicts.');

  const [mapping] = await db
    .select()
    .from(calendarMappings)
    .where(and(eq(calendarMappings.id, mappingId), eq(calendarMappings.connectionId, connectionId)))
    .limit(1);
  if (!mapping) throw notFound('calendar mapping', mappingId);
  if (mapping.syncState !== 'CONFLICT') throw new AppError('VALIDATION_FAILED', 'This conflict is already resolved.');
  const payload = (mapping.conflictPayload ?? {}) as { local?: { dueAt?: string | null; title?: string }; external?: { startsAt?: string; endsAt?: string; title?: string; externalId?: string } };

  await withWorkspaceTransaction(conn.workspaceId, async (tx) => {
    if (action === 'KEEP_TASK') {
      const [task] = mapping.taskId ? await tx.select().from(tasks).where(and(eq(tasks.id, mapping.taskId), eq(tasks.workspaceId, conn.workspaceId))).limit(1) : [];
      if (!task || !task.dueAt) {
        // Task vanished or was unscheduled: just drop the conflict state.
        await tx.delete(calendarMappings).where(eq(calendarMappings.id, mappingId));
        return;
      }
      const provider = buildCalendarProvider(conn);
      if (provider) {
        const written = await provider.writeEvent({
          externalId: mapping.externalId,
          calendarId: mapping.calendarId ?? 'primary',
          title: task.title,
          startsAt: task.dueAt.toISOString(),
          endsAt: new Date(task.dueAt.getTime() + 3_600_000).toISOString(),
          timeZone: null,
          isAllDay: false,
          busy: true,
        });
        await tx
          .update(calendarMappings)
          .set({
            syncState: 'SYNCED',
            conflictPayload: null,
            externalId: written.externalId,
            externalUpdatedAt: written.updatedAt ? new Date(written.updatedAt) : null,
            localUpdatedAt: task.updatedAt,
            updatedAt: new Date(),
          })
          .where(eq(calendarMappings.id, mappingId));
      } else {
        await tx.update(calendarMappings).set({ syncState: 'SYNCED', conflictPayload: null, updatedAt: new Date() }).where(eq(calendarMappings.id, mappingId));
      }
    } else if (action === 'KEEP_CALENDAR') {
      const externalStart = payload.external?.startsAt;
      if (!mapping.taskId || !externalStart) {
        await tx.delete(calendarMappings).where(eq(calendarMappings.id, mappingId));
        return;
      }
      const [task] = await tx.select().from(tasks).where(and(eq(tasks.id, mapping.taskId), eq(tasks.workspaceId, conn.workspaceId))).limit(1);
      if (!task || task.status === 'DELETED') {
        await tx.delete(calendarMappings).where(eq(calendarMappings.id, mappingId));
        return;
      }
      await applyTaskDueChange(tx, conn.workspaceId, { id: task.id, version: task.version, dueAt: task.dueAt, title: task.title }, new Date(externalStart), 'Calendar conflict: keep calendar', userId);
      await tx
        .update(calendarMappings)
        .set({ syncState: 'SYNCED', conflictPayload: null, localUpdatedAt: new Date(), externalUpdatedAt: payload.external?.endsAt ? new Date(payload.external.endsAt) : mapping.externalUpdatedAt, updatedAt: new Date() })
        .where(eq(calendarMappings.id, mappingId));
    } else {
      // UNLINK: the mapping is removed; the external event and the task
      // both stay, but they stop being the same record.
      await tx.delete(calendarMappings).where(eq(calendarMappings.id, mappingId));
    }
    const { auditLogs } = await import('@nextdoo/db');
    await tx.insert(auditLogs).values({
      id: crypto.randomUUID(),
      workspaceId: conn.workspaceId,
      actorId: userId,
      action: 'calendar.conflict_resolved',
      targetType: 'calendar_mapping',
      targetId: mappingId,
      metadata: { action, connectionId, taskId: mapping.taskId, externalId: mapping.externalId },
    });
  });
  return { resolved: action, mappingId };
}

/** Conflict view for the UI (PRD §16.4: the user must see both values). */
export interface CalendarConflictView {
  mappingId: string;
  state: 'CONFLICT';
  local: { taskId: string; title: string; dueAt: string | null };
  external: { externalId: string; title: string | null; startsAt: string | null; endsAt: string | null };
  detectedAt: string | null;
}

export async function listCalendarConflicts(userId: string, connectionId: string): Promise<CalendarConflictView[]> {
  const db = getDb();
  const [conn] = await db
    .select()
    .from(calendarConnections)
    .where(and(eq(calendarConnections.id, connectionId), eq(calendarConnections.userId, userId)))
    .limit(1);
  if (!conn) throw notFound('calendar connection', connectionId);
  const rows = await db
    .select()
    .from(calendarMappings)
    .where(and(eq(calendarMappings.connectionId, connectionId), eq(calendarMappings.syncState, 'CONFLICT')))
    .orderBy(asc(calendarMappings.updatedAt), asc(calendarMappings.id));
  const out: CalendarConflictView[] = [];
  for (const row of rows) {
    const payload = (row.conflictPayload ?? {}) as { local?: { dueAt?: string | null; title?: string }; external?: { startsAt?: string; endsAt?: string; title?: string; externalId?: string }; detectedAt?: string };
    const [task] = row.taskId ? await db.select().from(tasks).where(eq(tasks.id, row.taskId)).limit(1) : [];
    out.push({
      mappingId: row.id,
      state: 'CONFLICT',
      local: {
        taskId: row.taskId ?? '',
        title: payload.local?.title ?? task?.title ?? '',
        dueAt: payload.local?.dueAt ?? task?.dueAt?.toISOString() ?? null,
      },
      external: {
        externalId: payload.external?.externalId ?? row.externalId,
        title: payload.external?.title ?? null,
        startsAt: payload.external?.startsAt ?? null,
        endsAt: payload.external?.endsAt ?? null,
      },
      detectedAt: payload.detectedAt ?? null,
    });
  }
  return out;
}
