/**
 * Calendar provider boundary (PRD §16). Google Calendar is the first
 * implementation; Outlook/CalDAV (Phase 2) implement the same interface.
 *
 * Implementations must be stateless with respect to application data: the
 * application owns connections, mappings and normalized events (the schema).
 * The provider owns authentication (OAuth) and the external event store.
 *
 * All network access goes through an injectable transport so tests are
 * deterministic — no test may depend on a live provider (see
 * packages/calendar/src/fixture.ts).
 */

export type CalendarSyncMode = 'READ_ONLY' | 'READ_WRITE';

/** Normalized external event (PRD §16.3). Instants, plus the source zone. */
export interface CalendarEventDto {
  externalId: string;
  calendarId: string;
  title: string;
  /** ISO-8601 instant. */
  startsAt: string;
  /** ISO-8601 instant. */
  endsAt: string;
  /** IANA time zone of the event, when the provider supplies one. */
  timeZone: string | null;
  isAllDay: boolean;
  busy: boolean;
  /**
   * Last-modified time reported by the provider (ISO instant); the sync
   * engine stores it as `calendar_mappings.external_updated_at` to detect
   * both-side changes (PRD §16.4).
   */
  updatedAt: string | null;
  /** Provider revision token for optimistic updates (If-Match); null when absent. */
  etag: string | null;
  source: string;
}

/** A change batch: upserts plus deletions observed since the sync token. */
export interface CalendarChangeSet {
  events: CalendarEventDto[];
  deletedExternalIds: string[];
  /** Opaque incremental token for the next import; null when unavailable. */
  nextSyncToken: string | null;
}

/** Event to create/patch on the provider (export direction). */
export interface CalendarEventWrite {
  externalId: string | null;
  calendarId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  timeZone: string | null;
  isAllDay: boolean;
  busy: boolean;
  /** ETag/If-Match for optimistic concurrency, when the engine has one. */
  etag?: string | null;
}

export interface CalendarTokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** ISO instant the access token expires; null when unknown. */
  expiresAt: string | null;
  scopes?: string | null;
}

/** Auth state produced by `beginAuthorization`, consumed by the callback. */
export interface CalendarAuthRequest {
  authorizationUrl: string;
  /** Opaque state the application persists; returned verbatim on callback. */
  state: string;
  /** PKCE verifier — stored with the state, passed to completeAuthorization. */
  codeVerifier: string;
}

export interface CalendarAuthResult {
  externalAccountId: string | null;
  tokens: CalendarTokenSet;
}

/**
 * Raised when the provider rejects credentials (401 on token use/refresh):
 * the engine pauses the connection and surfaces a reconnect prompt
 * (PRD §16.6). Distinct from transient 403/429 rate limiting.
 */
export class CalendarAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarAuthError';
  }
}

/**
 * Raised on 403/429 with a Retry-After. The engine skips the connection for
 * this pass instead of hammering (PRD §16.1 rate-limit handling).
 */
export class CalendarRateLimited extends Error {
  constructor(
    public readonly retryAfterSeconds: number,
    message = 'Calendar provider rate limit',
  ) {
    super(message);
    this.name = 'CalendarRateLimited';
  }
}

/** Minimal fetch-shaped transport for deterministic tests. */
export type CalendarTransport = (url: string, init: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{ status: number; headers: Record<string, string>; body: string }>;

export interface CalendarProvider {
  readonly providerId: 'google';

  /** OAuth authorization URL for the chosen mode (mode picked first, PRD §16.2). */
  beginAuthorization(mode: CalendarSyncMode): Promise<CalendarAuthRequest>;

  /**
   * Complete the OAuth exchange. `state` is verified application-side
   * (stored with the PKCE verifier at start); the adapter receives the
   * verifier and performs the token exchange.
   */
  completeAuthorization(code: string, codeVerifier: string): Promise<CalendarAuthResult>;

  /**
   * Ensure a usable access token, refreshing on demand and caching until
   * expiry (PRD §16.1 token rotation). Throws CalendarAuthError when the
   * refresh is rejected.
   */
  ensureAccessToken(): Promise<string>;

  /** The current (possibly refreshed) token set, for the app to re-seal. */
  currentTokens(): CalendarTokenSet;

  /** Revoke the provider-held credentials; best-effort (PRD §16.5). */
  revoke(): Promise<void>;

  /** Incremental import since `syncToken` (or the full window if null). */
  listChanges(since: { syncToken: string | null; timeMin: string }): Promise<CalendarChangeSet>;

  /** Fetch one event (conflict detail / verification); null when gone. */
  getEvent(externalId: string): Promise<CalendarEventDto | null>;

  /** Create or patch (when externalId is set). Returns the written event. */
  writeEvent(event: CalendarEventWrite): Promise<CalendarEventDto>;

  /** Delete a mapped event; idempotent (a 404 is success). */
  deleteEvent(externalId: string): Promise<void>;

  /**
   * Subscribe the push channel or renew it before expiry (PRD §16.1).
   * Returns the expiry instant; the engine renews proactively.
   */
  ensureChannel(connectionToken: string, target: string): Promise<{ expiresAt: string }>;
}
