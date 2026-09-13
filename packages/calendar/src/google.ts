import { createHash, randomBytes } from 'node:crypto';
import {
  CalendarAuthError,
  CalendarRateLimited,
  type CalendarAuthRequest,
  type CalendarAuthResult,
  type CalendarChangeSet,
  type CalendarEventDto,
  type CalendarEventWrite,
  type CalendarProvider,
  type CalendarSyncMode,
  type CalendarTokenSet,
  type CalendarTransport,
} from '@nextdoo/contracts';

/**
 * Google Calendar adapter (PRD §16). Pure: no application data, no global
 * fetch — all I/O goes through the injected transport, so tests are
 * deterministic and live verification stays separate (see the milestone
 * doc for the external blocker).
 *
 * - OAuth 2.0 authorization code + PKCE (S256); `access_type=offline` so
 *   the first grant yields a refresh token.
 * - Minimum scopes per mode (PRD §16.2): readonly scope for READ_ONLY,
 *   the calendar read-write scope only when task-to-event export is
 *   enabled. No Drive/contacts/mail scopes, ever.
 * - Access tokens are refreshed on demand and cached until expiry
 *   (PRD §16.1); refresh failures surface as CalendarAuthError so the
 *   engine can pause the connection (reconnect prompt).
 * - 403/429 surface as CalendarRateLimited with Retry-After; the engine
 *   skips the connection for the pass (PRD §16.1 rate-limit handling).
 * - Recurring events are imported as instances inside the requested
 *   window (`singleEvents=true`); the normalized shape (PRD §16.3) carries
 *   no recurrence field, so per-instance storage is the MVP contract.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const SCOPE_READ_ONLY = 'https://www.googleapis.com/auth/calendar.readonly';
const SCOPE_READ_WRITE = 'https://www.googleapis.com/auth/calendar';
/** Google allows 7-day push channels; renew with an hour of margin. */
const CHANNEL_LIFETIME_MS = 7 * 86_400_000 - 3_600_000;

interface GoogleOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Injectable for deterministic tests; defaults to global fetch. */
  transport?: CalendarTransport;
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Pre-existing tokens for a reconnected/disconnecting connection. */
  initialTokens?: CalendarTokenSet | null;
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function defaultTransport(url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body,
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: res.status, headers, body: await res.text() };
}

export function createGoogleCalendar(options: GoogleOptions): CalendarProvider {
  const transport = options.transport ?? defaultTransport;
  const clock = options.now ?? (() => new Date());

  let tokens: CalendarTokenSet | null = options.initialTokens ?? null;

  function setTokens(next: CalendarTokenSet): void {
    tokens = next;
  }

  function current(): CalendarTokenSet {
    if (!tokens) throw new CalendarAuthError('Calendar provider has no tokens.');
    return tokens;
  }

  /** Paced request with 401 → auth error, 403/429 → rate-limited. */
  async function request(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const res = await transport(url, init);
    if (res.status === 401) throw new CalendarAuthError('Calendar provider rejected the credentials.');
    if (res.status === 403 || res.status === 429) {
      const retryAfter = Number(res.headers['retry-after'] ?? '') || 60;
      throw new CalendarRateLimited(Number.isFinite(retryAfter) ? retryAfter : 60);
    }
    if (res.status === 424) throw new CalendarRateLimited(60);
    return res;
  }

  async function requestJson<T>(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<T> {
    const res = await request(url, init);
    if (res.status >= 400) throw new Error(`Calendar provider error ${res.status}: ${res.body.slice(0, 300)}`);
    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw new Error(`Calendar provider returned non-JSON ${res.status} response.`);
    }
  }

  function authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${current().accessToken}` };
  }

  async function refreshAccessToken(): Promise<void> {
    const t = current();
    if (!t.refreshToken) throw new CalendarAuthError('Calendar connection has no refresh token; reconnect required.');
    const body = new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      refresh_token: t.refreshToken,
      grant_type: 'refresh_token',
    }).toString();
    const res = await transport(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (res.status >= 400) throw new CalendarAuthError('Calendar token refresh was rejected; reconnect required.');
    const payload = JSON.parse(res.body) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    setTokens({
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? t.refreshToken,
      expiresAt: payload.expires_in ? new Date(clock().getTime() + payload.expires_in * 1000).toISOString() : t.expiresAt,
      scopes: payload.scope ?? t.scopes ?? null,
    });
  }

  return {
    providerId: 'google',

    async beginAuthorization(mode: CalendarSyncMode): Promise<CalendarAuthRequest> {
      const verifierBuffer = randomBytes(64);
      const verifier = base64Url(verifierBuffer).slice(0, 128);
      const challenge = base64Url(createHash('sha256').update(verifier).digest());
      const state = base64Url(randomBytes(32));
      const scope = mode === 'READ_WRITE' ? SCOPE_READ_WRITE : SCOPE_READ_ONLY;
      const params = new URLSearchParams({
        client_id: options.clientId,
        redirect_uri: options.redirectUri,
        response_type: 'code',
        scope,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
      });
      return { authorizationUrl: `${AUTH_URL}?${params.toString()}`, state, codeVerifier: verifier };
    },

    async completeAuthorization(code: string, codeVerifier: string): Promise<CalendarAuthResult> {
      const body = new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        code,
        code_verifier: codeVerifier,
        redirect_uri: options.redirectUri,
        grant_type: 'authorization_code',
      }).toString();
      const res = await transport(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (res.status >= 400) throw new CalendarAuthError('Google authorization code exchange failed.');
      const payload = JSON.parse(res.body) as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
      };
      const tokens: CalendarTokenSet = {
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token ?? null,
        expiresAt: payload.expires_in ? new Date(clock().getTime() + payload.expires_in * 1000).toISOString() : null,
        scopes: payload.scope ?? null,
      };
      setTokens(tokens);
      // The verified account identifier: the primary calendar's owner.
      const me = await requestJson<{ id: string; primaryEmail?: string }>(`${CALENDAR_API}/users/me`, { headers: authHeaders() });
      return { externalAccountId: me.primaryEmail ?? me.id, tokens };
    },

    async ensureAccessToken(): Promise<string> {
      const t = current();
      // No expiry reported: there is no signal to refresh on, use as-is.
      if (!t.expiresAt) return t.accessToken;
      const expiresMs = new Date(t.expiresAt).getTime();
      if (expiresMs - clock().getTime() > 60_000) return t.accessToken;
      await refreshAccessToken();
      return current().accessToken;
    },

    currentTokens(): CalendarTokenSet {
      return current();
    },

    async revoke(): Promise<void> {
      // Best effort (PRD §16.5): a failed revocation must not block
      // disconnect; the tokens are wiped from application storage either way.
      const t = tokens;
      if (!t) return;
      try {
        await transport(`${REVOKE_URL}?token=${encodeURIComponent(t.accessToken)}`, { method: 'DELETE' });
      } catch {
        /* ignored by design */
      }
    },

    async listChanges(since: { syncToken: string | null; timeMin: string }): Promise<CalendarChangeSet> {
      const events: CalendarEventDto[] = [];
      const deletedExternalIds: string[] = [];
      let pageToken: string | null = null;
      let nextSyncToken: string | null = null;
      do {
        const params = new URLSearchParams({
          timeMin: since.timeMin,
          maxResults: '500',
          orderBy: 'startTime',
          // MVP: expand recurring series to instances inside the window
          // (the normalized shape has no recurrence field, PRD §16.3).
          singleEvents: 'true',
        });
        if (since.syncToken) params.set('syncToken', since.syncToken);
        if (pageToken) params.set('pageToken', pageToken);
        const res = await requestJson<{ items?: GoogleEvent[]; nextPageToken?: string; syncToken?: string }>(
          `${CALENDAR_API}/calendars/primary/events?${params.toString()}`,
          { headers: authHeaders() },
        );
        for (const item of res.items ?? []) {
          if (item.status === 'cancelled') {
            deletedExternalIds.push(item.id!);
            continue;
          }
          events.push(toDto(item));
        }
        if (res.syncToken) nextSyncToken = res.syncToken; // last page's token wins
        pageToken = res.nextPageToken ?? null;
      } while (pageToken);
      return { events, deletedExternalIds, nextSyncToken };
    },

    async getEvent(externalId: string): Promise<CalendarEventDto | null> {
      const res = await request(`${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(externalId)}`, { headers: authHeaders() });
      if (res.status === 404) return null;
      return toDto(JSON.parse(res.body) as GoogleEvent);
    },

    async writeEvent(event: CalendarEventWrite): Promise<CalendarEventDto> {
      const body = JSON.stringify(toEventBody(event));
      if (!event.externalId) {
        const res = await requestJson<GoogleEvent>(`${CALENDAR_API}/calendars/primary/events`, {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body,
        });
        return toDto(res);
      }
      const headers: Record<string, string> = { ...authHeaders(), 'Content-Type': 'application/json' };
      if (event.etag) headers['If-Match'] = event.etag;
      const res = await request(
        `${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(event.externalId)}`,
        { method: 'PATCH', headers, body },
      );
      if (res.status === 404 || res.status === 412) {
        // The external event vanished (or its etag rotated): recreate it so
        // the mapping converges, then let the engine re-link the new id.
        const created = await requestJson<GoogleEvent>(`${CALENDAR_API}/calendars/primary/events`, {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body,
        });
        return toDto(created);
      }
      return toDto(JSON.parse(res.body) as GoogleEvent);
    },

    async deleteEvent(externalId: string): Promise<void> {
      const res = await request(`${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(externalId)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (res.status !== 404 && res.status >= 400) {
        throw new Error(`Calendar provider delete failed ${res.status}: ${res.body.slice(0, 300)}`);
      }
    },

    async ensureChannel(connectionToken: string, target: string): Promise<{ expiresAt: string }> {
      const expiresAt = new Date(clock().getTime() + CHANNEL_LIFETIME_MS).toISOString();
      const res = await requestJson<{ expiration?: number }>(`${CALENDAR_API}/calendars/primary/events/watch`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `nextdoo-${connectionToken.slice(0, 12)}`,
          token: connectionToken,
          address: target,
          type: 'web_hook',
          expiration: Math.floor(new Date(expiresAt).getTime() / 1000),
        }),
      });
      return {
        expiresAt: res.expiration ? new Date(res.expiration * 1000).toISOString() : expiresAt,
      };
    },
  };
}

interface GoogleEvent {
  id?: string;
  etag?: string;
  status?: string;
  summary?: string;
  description?: string;
  updated?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  [key: string]: unknown;
}

/** Google item → normalized DTO (PRD §16.3). */
export function toDto(item: GoogleEvent): CalendarEventDto {
  const id = item.id;
  if (!id) throw new Error('Google event item has no id.');
  const start = item.start ?? {};
  const end = item.end ?? {};
  const isAllDay = Boolean(start.date && !start.dateTime);
  // All-day events carry local dates; normalize to instants at UTC midnight
  // (the storage contract), keeping the source zone for display fidelity.
  const startsAt = start.dateTime ?? (start.date ? `${start.date}T00:00:00.000Z` : '');
  const endsAt = end.dateTime ?? (end.date ? `${end.date}T00:00:00.000Z` : '');
  if (!startsAt || !endsAt) throw new Error('Google event item has no usable start/end.');
  return {
    externalId: id,
    calendarId: 'primary',
    title: item.summary ?? '',
    startsAt,
    endsAt,
    timeZone: start.timeZone ?? null,
    isAllDay,
    busy: item.status !== 'transparent',
    updatedAt: item.updated ?? null,
    etag: item.etag ?? null,
    source: 'google',
  };
}

function toEventBody(event: CalendarEventWrite): Record<string, unknown> {
  const start = event.isAllDay
    ? { date: event.startsAt.slice(0, 10) }
    : { dateTime: event.startsAt, ...(event.timeZone ? { timeZone: event.timeZone } : {}) };
  const end = event.isAllDay
    ? { date: event.endsAt.slice(0, 10) }
    : { dateTime: event.endsAt, ...(event.timeZone ? { timeZone: event.timeZone } : {}) };
  return {
    summary: event.title,
    start,
    end,
    ...(event.isAllDay ? {} : { transparency: event.busy ? 'opaque' : 'transparent' }),
  };
}
