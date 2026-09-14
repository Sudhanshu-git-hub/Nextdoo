import { createHash } from 'node:crypto';
import {
  CalendarAuthError,
  CalendarRateLimited,
  CALENDAR_INSTANCE_KEY_SEPARATOR,
  type CalendarAuthRequest,
  type CalendarAuthResult,
  type CalendarChangeSet,
  type CalendarEventDto,
  type CalendarEventWrite,
  type CalendarProvider,
  type CalendarSyncMode,
  type CalendarTokenSet,
} from '@nextdoo/contracts';
import { deriveExternalId } from './instance-key';

/**
 * Deterministic in-memory calendar provider — the "local Google" used by
 * every M7 test (adapter, sync engine, worker, E2E seeding). It faithfully
 * implements the CalendarProvider contract: sync tokens, deletions,
 * etags, 401/429 behaviour, channel watch — with zero network.
 *
 * Test-only: never wired into the product path. The product uses
 * createGoogleCalendar with the real (or injected-transport) HTTP layer.
 */

export interface FixtureEvent {
  externalId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  timeZone?: string | null;
  isAllDay?: boolean;
  busy?: boolean;
  deleted?: boolean;
  etag?: string;
  /** Provider last-modified time (change detection, PRD §16.4). */
  updatedAt?: string;
  /** For expanded recurring instances: the Google series id. */
  recurringEventId?: string;
}

export interface FixtureProviderOptions {
  /** Initial token set (the "connected" state). */
  tokens?: CalendarTokenSet;
  /** Seed events on the (simulated) provider. */
  events?: FixtureEvent[];
  /** When set, every token operation throws CalendarAuthError (revoked). */
  revoked?: boolean;
  /** When set, the next `n` event-list calls throw CalendarRateLimited. */
  rateLimitCalls?: number;
  /** Injectable clock. */
  now?: () => Date;
}

export interface FixtureCall {
  op: 'list' | 'get' | 'create' | 'patch' | 'delete' | 'watch' | 'refresh' | 'revoke' | 'exchange';
  externalId?: string;
}

let fixtureSeq = 0;

export class FixtureCalendarProvider implements CalendarProvider {
  readonly providerId = 'google' as const;
  readonly calls: FixtureCall[] = [];
  /** Events as the (simulated) provider holds them, incl. soft-deleted. */
  readonly store: Map<string, FixtureEvent> = new Map();
  private tokens: CalendarTokenSet | null;
  private revoked: boolean;
  private rateLimitCalls: number;
  private syncToken = 'tok-0';
  private deliveredTokens = new Set(['tok-0']);
  /** Series deleted as a whole (reported as one series-level deletion). */
  private cancelledSeries = new Set<string>();
  private clock: () => Date;
  private accountEmail = 'fixture-user@test.local';
  private refreshCount = 0;

  constructor(options: FixtureProviderOptions = {}) {
    this.tokens = options.tokens ?? null;
    this.revoked = options.revoked ?? false;
    this.rateLimitCalls = options.rateLimitCalls ?? 0;
    this.clock = options.now ?? (() => new Date());
    for (const event of options.events ?? []) this.store.set(event.externalId, { ...event });
  }

  /** Add/replace an event on the (simulated) provider side. */
  pushEvent(event: FixtureEvent): void {
    this.store.set(event.externalId, { etag: `etag-${event.externalId}`, ...event });
    this.syncToken = `tok-${this.store.size}`;
  }

  /**
   * Push a recurring series the way `events.list?singleEvents=true` would
   * return it: one item per occurrence, all sharing the series id, each
   * keyed by the per-occurrence identity (M7-i2). Returns the stored keys.
   */
  pushSeries(
    seriesId: string,
    instances: Array<{ originalStartTime: string; title?: string; startsAt: string; endsAt: string; timeZone?: string | null; isAllDay?: boolean; busy?: boolean }>,
  ): string[] {
    const keys: string[] = [];
    for (const instance of instances) {
      const key = deriveExternalId({
        id: seriesId,
        recurringEventId: seriesId,
        originalStartTime: instance.isAllDay ? { date: instance.originalStartTime } : { dateTime: instance.originalStartTime },
      });
      this.store.set(key, {
        externalId: key,
        recurringEventId: seriesId,
        title: instance.title ?? 'Recurring event',
        startsAt: instance.startsAt,
        endsAt: instance.endsAt,
        timeZone: instance.timeZone ?? null,
        isAllDay: instance.isAllDay ?? false,
        busy: instance.busy ?? true,
        etag: `etag-${key}`,
      });
      keys.push(key);
    }
    this.syncToken = `tok-${this.store.size}`;
    return keys;
  }

  /** Soft-delete on the provider side (visible to the next listChanges). */
  deleteEventExternal(externalId: string): void {
    const existing = this.store.get(externalId);
    if (existing) this.store.set(externalId, { ...existing, deleted: true });
    this.syncToken = `tok-${Date.now()}`;
  }

  /**
   * Delete a WHOLE recurring series on the provider side, the way Google
   * reports it: one cancelled series-level item (the bare series id) — the
   * individual occurrences are gone, not individually cancelled.
   */
  deleteSeriesExternal(seriesId: string): void {
    this.cancelledSeries.add(seriesId);
    const prefix = `${seriesId}${CALENDAR_INSTANCE_KEY_SEPARATOR}`;
    for (const [id, event] of this.store) {
      if (id.startsWith(prefix)) this.store.set(id, { ...event, deleted: true });
    }
    this.syncToken = `tok-${Date.now()}`;
  }

  /** Force the access token to count as expired (next ensure refreshes). */
  expireAccessToken(): void {
    if (this.tokens) this.tokens = { ...this.tokens, expiresAt: new Date(this.clock().getTime() - 1000).toISOString() };
  }

  /** Simulate a revoked credential (every token op throws CalendarAuthError). */
  markRevoked(): void {
    this.revoked = true;
  }

  /** Simulate provider rate limiting for the next n event ops. */
  setRateLimitCalls(n: number): void {
    this.rateLimitCalls = n;
  }

  private requireAuth(): string {
    if (this.revoked || !this.tokens) throw new CalendarAuthError('fixture: credentials revoked');
    if (this.rateLimitCalls > 0 && (this.calls.at(-1)?.op === 'list' || this.calls.at(-1)?.op === 'get')) {
      this.rateLimitCalls -= 1;
      throw new CalendarRateLimited(7, 'fixture rate limit');
    }
    const t = this.tokens;
    if (t.expiresAt && new Date(t.expiresAt).getTime() <= this.clock().getTime()) {
      this.calls.push({ op: 'refresh' });
      this.refreshCount += 1;
      if (this.revoked) throw new CalendarAuthError('fixture: refresh rejected');
      this.tokens = { ...t, accessToken: `fixture-access-${this.refreshCount}`, expiresAt: new Date(this.clock().getTime() + 3_600_000).toISOString() };
    }
    return this.tokens.accessToken;
  }

  async beginAuthorization(mode: CalendarSyncMode): Promise<CalendarAuthRequest> {
    const state = `state-${++fixtureSeq}`;
    return {
      authorizationUrl:
        `https://accounts.google.test/oauth2?mode=${mode}&state=${state}` +
        `&scope=${mode === 'READ_WRITE' ? 'calendar-rw' : 'calendar-ro'}&code_challenge=fixed&code_challenge_method=S256`,
      state,
      codeVerifier: `verifier-${state}`,
    };
  }

  async completeAuthorization(_code: string, _codeVerifier: string): Promise<CalendarAuthResult> {
    this.calls.push({ op: 'exchange' });
    const tokens: CalendarTokenSet = {
      accessToken: 'fixture-access-0',
      refreshToken: 'fixture-refresh-0',
      expiresAt: new Date(this.clock().getTime() + 3_600_000).toISOString(),
      scopes: 'fixture',
    };
    this.tokens = tokens;
    return { externalAccountId: this.accountEmail, tokens };
  }

  async ensureAccessToken(): Promise<string> {
    return this.requireAuth();
  }

  currentTokens(): CalendarTokenSet {
    if (!this.tokens) throw new CalendarAuthError('fixture: no tokens');
    return this.tokens;
  }

  async revoke(): Promise<void> {
    this.calls.push({ op: 'revoke' });
  }

  async listChanges(since: { syncToken: string | null; timeMin: string }): Promise<CalendarChangeSet> {
    this.calls.push({ op: 'list' });
    this.requireAuth();
    const events: CalendarEventDto[] = [];
    const deletedExternalIds: string[] = [];
    const reportedSeries = new Set<string>();
    for (const [id, event] of this.store) {
      if (event.deleted) {
        // A whole-series deletion is reported once, as the bare series id
        // (the singleEvents=true shape of a cancelled series), not as one
        // entry per occurrence.
        const series = event.recurringEventId;
        if (series && this.cancelledSeries.has(series)) {
          if (!reportedSeries.has(series)) {
            reportedSeries.add(series);
            deletedExternalIds.push(series);
          }
          continue;
        }
        deletedExternalIds.push(id);
        continue;
      }
      events.push({
        externalId: id,
        calendarId: 'primary',
        title: event.title,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        timeZone: event.timeZone ?? null,
        isAllDay: event.isAllDay ?? false,
        busy: event.busy ?? true,
        updatedAt: event.updatedAt ?? '2026-01-01T00:00:00.000Z',
        etag: event.etag ?? `etag-${id}`,
        source: 'google',
      });
    }
    events.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.externalId.localeCompare(b.externalId));
    const next = `tok-${this.store.size}-${this.deliveredTokens.size + 1}`;
    this.deliveredTokens.add(since.syncToken ?? 'tok-0');
    void since.timeMin;
    void createHash;
    return { events, deletedExternalIds, nextSyncToken: next };
  }

  async getEvent(externalId: string): Promise<CalendarEventDto | null> {
    this.calls.push({ op: 'get', externalId });
    this.requireAuth();
    const event = this.store.get(externalId);
    if (!event || event.deleted) return null;
    return {
      externalId,
      calendarId: 'primary',
      title: event.title,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      timeZone: event.timeZone ?? null,
      isAllDay: event.isAllDay ?? false,
      busy: event.busy ?? true,
      updatedAt: event.updatedAt ?? '2026-01-01T00:00:00.000Z',
      etag: event.etag ?? `etag-${externalId}`,
      source: 'google',
    };
  }

  async writeEvent(event: CalendarEventWrite): Promise<CalendarEventDto> {
    const existing = event.externalId ? this.store.get(event.externalId) : undefined;
    if (event.externalId && (existing?.deleted || !existing)) {
      // 404 on patch: the adapter recreates under a new id.
      this.calls.push({ op: 'create' });
    } else if (event.externalId) {
      this.calls.push({ op: 'patch', externalId: event.externalId });
    } else {
      this.calls.push({ op: 'create' });
    }
    this.requireAuth();
    const id = event.externalId && existing ? event.externalId : `fx-${createHash('sha1').update(event.title + event.startsAt).digest('hex').slice(0, 10)}`;
    this.store.set(id, {
      externalId: id,
      title: event.title,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      timeZone: event.timeZone,
      isAllDay: event.isAllDay,
      busy: event.busy,
    });
    return {
      externalId: id,
      calendarId: 'primary',
      title: event.title,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      timeZone: event.timeZone,
      isAllDay: event.isAllDay,
      busy: event.busy,
      updatedAt: this.clock().toISOString(),
      etag: `etag-${id}`,
      source: 'google',
    };
  }

  async deleteEvent(externalId: string): Promise<void> {
    this.calls.push({ op: 'delete', externalId });
    this.requireAuth();
    const event = this.store.get(externalId);
    if (event) this.store.set(externalId, { ...event, deleted: true });
    this.syncToken = `tok-${Date.now()}`;
  }

  async ensureChannel(connectionToken: string, target: string): Promise<{ expiresAt: string }> {
    this.calls.push({ op: 'watch' });
    this.requireAuth();
    void connectionToken;
    void target;
    return { expiresAt: new Date(this.clock().getTime() + 6 * 86_400_000).toISOString() };
  }
}
