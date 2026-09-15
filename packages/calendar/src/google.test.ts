import { afterEach, describe, expect, it, vi } from 'vitest';
import { CalendarAuthError, CalendarRateLimited } from '@nextdoo/contracts';
import { createGoogleCalendar, toDto } from './google';
import { FixtureCalendarProvider } from './fixture';

interface Wire {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function wire() {
  const calls: Wire[] = [];
  let responder: (call: Wire) => { status: number; headers?: Record<string, string>; body: string };
  return {
    calls,
    setResponder(next: typeof responder) {
      responder = next;
    },
    transport: async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const call: Wire = {
        url,
        method: init.method ?? 'GET',
        headers: init.headers ?? {},
        body: init.body ?? '',
      };
      calls.push(call);
      const r = await responder(call);
      return { status: r.status, headers: r.headers ?? {}, body: r.body };
    },
  };
}

const now = () => new Date('2026-09-12T00:00:00.000Z');

describe('createGoogleCalendar — PKCE authorization (PRD §16.1/§16.2)', () => {
  it('builds the auth URL with the minimum scope for the chosen mode', async () => {
    const w = wire();
    const provider = createGoogleCalendar({ clientId: 'cid', clientSecret: 'cs', redirectUri: 'https://app/cb', transport: w.transport, now });
    const ro = await provider.beginAuthorization('READ_ONLY');
    const rw = await provider.beginAuthorization('READ_WRITE');
    expect(ro.authorizationUrl).toContain('https://accounts.google.com/o/oauth2/v2/auth?');
    expect(ro.authorizationUrl).toContain('scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.readonly');
    expect(ro.authorizationUrl).not.toContain('auth/calendar&');
    expect(rw.authorizationUrl).toContain('scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar');
    // PKCE + offline access for the refresh token.
    expect(ro.authorizationUrl).toContain('code_challenge_method=S256');
    expect(ro.authorizationUrl).toContain('access_type=offline');
    expect(ro.authorizationUrl).toContain(`state=${ro.state}`);
    // No forbidden scopes, ever.
    for (const url of [ro.authorizationUrl, rw.authorizationUrl]) {
      expect(url).not.toContain('auth/drive');
      expect(url).not.toContain('auth/contacts');
      expect(url).not.toContain('auth/userinfo.email');
    }
    expect(ro.state.length).toBeGreaterThan(20);
    expect(ro.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(ro.codeVerifier.length).toBeLessThanOrEqual(128);
    expect(ro.codeVerifier).not.toMatch(/[^A-Za-z0-9\-._~]/);
  });

  it('exchanges the code with the verifier and stores the refresh token', async () => {
    const w = wire();
    w.setResponder((call) => {
      if (call.url.startsWith('https://oauth2.googleapis.com/token')) {
        expect(call.body).toContain('grant_type=authorization_code');
        expect(call.body).toContain('code_verifier=');
        return {
          status: 200,
          body: JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'cal' }),
        };
      }
      return { status: 200, body: JSON.stringify({ id: 'primary', primaryEmail: 'user@example.com' }) };
    });
    const provider = createGoogleCalendar({ clientId: 'cid', clientSecret: 'cs', redirectUri: 'https://app/cb', transport: w.transport, now });
    const result = await provider.completeAuthorization('auth-code', 'verifier-1');
    expect(result.externalAccountId).toBe('user@example.com');
    expect(result.tokens.refreshToken).toBe('rt-1');
    expect(result.tokens.expiresAt).toBe('2026-09-12T01:00:00.000Z');
  });

  it('fails the exchange with CalendarAuthError on a rejected code', async () => {
    const w = wire();
    w.setResponder(() => ({ status: 400, body: '{"error":"invalid_grant"}' }));
    const provider = createGoogleCalendar({ clientId: 'cid', clientSecret: 'cs', redirectUri: 'https://app/cb', transport: w.transport, now });
    await expect(provider.completeAuthorization('bad', 'v')).rejects.toBeInstanceOf(CalendarAuthError);
  });
});

describe('createGoogleCalendar — token lifecycle (PRD §16.1 refresh on demand)', () => {
  function withTokens() {
    const w = wire();
    w.setResponder((call) => {
      if (call.url.startsWith('https://oauth2.googleapis.com/token')) {
        expect(call.body).toContain('grant_type=refresh_token');
        expect(call.body).toContain('refresh_token=rt-1');
        return { status: 200, body: JSON.stringify({ access_token: 'at-fresh', refresh_token: 'rt-rotated', expires_in: 3599 }) };
      }
      return { status: 401, body: 'unauthorized' };
    });
    const provider = createGoogleCalendar({
      clientId: 'cid',
      clientSecret: 'cs',
      redirectUri: 'https://app/cb',
      transport: w.transport,
      now,
      initialTokens: { accessToken: 'at-expired', refreshToken: 'rt-1', expiresAt: '2026-09-11T00:00:00.000Z', scopes: null },
    });
    return { provider, w };
  }

  it('refreshes an expired token before use and rotates the refresh token', async () => {
    const { provider } = withTokens();
    const access = await provider.ensureAccessToken();
    expect(access).toBe('at-fresh');
    expect(provider.currentTokens().refreshToken).toBe('rt-rotated');
    // Still fresh now — no second refresh.
    expect(await provider.ensureAccessToken()).toBe('at-fresh');
  });

  it('throws CalendarAuthError when the refresh is rejected', async () => {
    const w = wire();
    w.setResponder(() => ({ status: 400, body: '{"error":"invalid_grant"}' }));
    const provider = createGoogleCalendar({
      clientId: 'cid',
      clientSecret: 'cs',
      redirectUri: 'https://app/cb',
      transport: w.transport,
      now,
      initialTokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: '2026-09-11T00:00:00.000Z', scopes: null },
    });
    await expect(provider.ensureAccessToken()).rejects.toBeInstanceOf(CalendarAuthError);
  });
});

describe('createGoogleCalendar — listChanges (sync tokens, paging, deletions)', () => {
  function listProvider(pages: Array<{ items: Array<Record<string, unknown>>; nextPageToken?: string; syncToken?: string }>) {
    const w = wire();
    let listCall = 0;
    w.setResponder((call) => {
      const url = new URL(call.url);
      if (call.url.includes('/events?') || call.url.includes('/events&')) {
        const page = pages[listCall];
        listCall += 1;
        if (!page) throw new Error('no page ' + (listCall - 1) + ' for token ' + url.searchParams.get('pageToken'));
        return { status: 200, body: JSON.stringify({ ...page, nextPageToken: page.nextPageToken, syncToken: page.syncToken }) };
      }
      return { status: 200, body: '{}' };
    });
    return { provider: createGoogleCalendar({ clientId: 'c', clientSecret: 's', redirectUri: 'r', transport: w.transport, now, initialTokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: '2026-09-13T00:00:00.000Z', scopes: null } }), w };
  }

  it('paginates, collects cancelled events as deletions, and returns the final sync token', async () => {
    const { provider, w } = listProvider([
      {
        items: [
          { id: 'e1', summary: 'Standup', status: 'confirmed', start: { dateTime: '2026-09-13T09:00:00.000Z' }, end: { dateTime: '2026-09-13T09:30:00.000Z' }, updated: '2026-09-10T00:00:00Z' },
          { id: 'gone', status: 'cancelled' },
        ],
        nextPageToken: 'p1',
        syncToken: 'tok-final',
      },
      { items: [{ id: 'e2', summary: 'All-day', status: 'confirmed', start: { date: '2026-09-15' }, end: { date: '2026-09-16' } }] },
    ]);
    const changes = await provider.listChanges({ syncToken: 'tok-0', timeMin: '2026-09-11T00:00:00.000Z' });
    expect(changes.events.map((e) => e.externalId)).toEqual(['e1', 'e2']);
    expect(changes.deletedExternalIds).toEqual(['gone']);
    expect(changes.nextSyncToken).toBe('tok-final');
    const [first, second] = changes.events;
    expect(first).toMatchObject({ title: 'Standup', isAllDay: false, busy: true, source: 'google' });
    expect(second).toMatchObject({ isAllDay: true, startsAt: '2026-09-15T00:00:00.000Z', endsAt: '2026-09-16T00:00:00.000Z' });
    // The first page asked for the sync token and singleEvents (instances, MVP contract).
    const firstCall = w.calls[0];
    if (!firstCall) throw new Error('no call recorded');
    expect(firstCall.url).toContain('syncToken=tok-0');
    expect(firstCall.url).toContain('singleEvents=true');
  });

  it('maps 429 with Retry-After to CalendarRateLimited', async () => {
    const w = wire();
    w.setResponder(() => ({ status: 429, headers: { 'retry-after': '17' }, body: '{}' }));
    const provider = createGoogleCalendar({ clientId: 'c', clientSecret: 's', redirectUri: 'r', transport: w.transport, now, initialTokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: '2026-09-13T00:00:00.000Z', scopes: null } });
    const err = await provider.listChanges({ syncToken: null, timeMin: '2026-09-11T00:00:00.000Z' }).catch((e) => e);
    expect(err).toBeInstanceOf(CalendarRateLimited);
    expect((err as CalendarRateLimited).retryAfterSeconds).toBe(17);
  });

  it('maps 401 to CalendarAuthError', async () => {
    const w = wire();
    w.setResponder(() => ({ status: 401, body: '{}' }));
    const provider = createGoogleCalendar({ clientId: 'c', clientSecret: 's', redirectUri: 'r', transport: w.transport, now, initialTokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: '2026-09-13T00:00:00.000Z', scopes: null } });
    await expect(provider.listChanges({ syncToken: null, timeMin: '2026-09-11T00:00:00.000Z' })).rejects.toBeInstanceOf(CalendarAuthError);
  });
});

describe('createGoogleCalendar — event writes (PRD §16.6 AC-1/AC-2 mechanics)', () => {
  function writeProvider(responder: (call: Wire) => { status: number; body: string }) {
    const w = wire();
    w.setResponder(responder);
    return createGoogleCalendar({ clientId: 'c', clientSecret: 's', redirectUri: 'r', transport: w.transport, now, initialTokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: '2026-09-13T00:00:00.000Z', scopes: null } });
  }

  it('creates a timed event for a new export', async () => {
    const provider = writeProvider((call) => {
      expect(call.method).toBe('POST');
      const body = JSON.parse(call.body);
      expect(body.summary).toBe('Ship the report');
      expect(body.start.dateTime).toBe('2026-09-13T10:00:00.000Z');
      return { status: 200, body: JSON.stringify({ id: 'ext-new', etag: 'e1', summary: 'Ship the report', start: { dateTime: '2026-09-13T10:00:00.000Z' }, end: { dateTime: '2026-09-13T11:00:00.000Z' }, updated: '2026-09-12T00:00:01Z' }) };
    });
    const written = await provider.writeEvent({ externalId: null, calendarId: 'primary', title: 'Ship the report', startsAt: '2026-09-13T10:00:00.000Z', endsAt: '2026-09-13T11:00:00.000Z', timeZone: null, isAllDay: false, busy: true });
    expect(written.externalId).toBe('ext-new');
    expect(written.etag).toBe('e1');
  });

  it('patches with If-Match when an etag is present and recreates on 404', async () => {
    const provider = writeProvider((call) => {
      if (call.method === 'PATCH') {
        expect(call.headers['If-Match']).toBe('e-old');
        return { status: 404, body: '{"error":"not found"}' };
      }
      expect(call.method).toBe('POST');
      return { status: 200, body: JSON.stringify({ id: 'ext-recreated', etag: 'e2', summary: 'Ship', start: { dateTime: '2026-09-13T11:00:00.000Z' }, end: { dateTime: '2026-09-13T12:00:00.000Z' }, updated: '2026-09-12T00:00:02Z' }) };
    });
    const written = await provider.writeEvent({ externalId: 'ext-gone', calendarId: 'primary', title: 'Ship', startsAt: '2026-09-13T11:00:00.000Z', endsAt: '2026-09-13T12:00:00.000Z', timeZone: null, isAllDay: false, busy: true, etag: 'e-old' });
    expect(written.externalId).toBe('ext-recreated');
  });

  it('treats a 404 delete as success (AC-2 idempotency)', async () => {
    const provider = writeProvider(() => ({ status: 404, body: '{}' }));
    await expect(provider.deleteEvent('ext-gone')).resolves.toBeUndefined();
  });

  it('subscribes the push channel with the connection token and a sub-7d expiry', async () => {
    const w = wire();
    w.setResponder((call) => {
      const body = JSON.parse(call.body);
      expect(call.url).toContain('/calendars/primary/events/watch');
      expect(body.token).toBe('conn-token');
      expect(body.type).toBe('web_hook');
      return { status: 200, body: JSON.stringify({ id: 'ch', expiration: 2000000000 }) };
    });
    const provider = createGoogleCalendar({ clientId: 'c', clientSecret: 's', redirectUri: 'r', transport: w.transport, now, initialTokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: '2026-09-13T00:00:00.000Z', scopes: null } });
    const channel = await provider.ensureChannel('conn-token', 'https://app/api/v1/calendar/webhook');
    expect(channel.expiresAt).toBe(new Date(2000000000 * 1000).toISOString());
  });
});

describe('toDto — PRD §16.3 normalization', () => {
  it('normalizes timed events with a source zone', () => {
    const dto = toDto({ id: 'x', summary: 'Demo', status: 'confirmed', start: { dateTime: '2026-09-13T15:30:00+05:30', timeZone: 'Asia/Kolkata' }, end: { dateTime: '2026-09-13T16:00:00+05:30' }, updated: '2026-09-12T00:00:00Z' });
    expect(dto).toMatchObject({ externalId: 'x', title: 'Demo', startsAt: '2026-09-13T15:30:00+05:30', timeZone: 'Asia/Kolkata', isAllDay: false, busy: true, source: 'google', calendarId: 'primary' });
  });
  it('rejects items without ids or times', () => {
    expect(() => toDto({ summary: 'no id' })).toThrow();
    expect(() => toDto({ id: 'x', start: {}, end: {} })).toThrow();
  });
});

describe('createGoogleCalendar — default transport (real fetch wiring)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(responder: (url: string, init: RequestInit) => { status: number; headers?: Record<string, string>; body: string }) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = responder(url, init);
      return {
        status: r.status,
        headers: new Headers(r.headers ?? {}),
        text: async () => r.body,
      } as unknown as Response;
    }) as typeof fetch);
    return calls;
  }

  it('uses global fetch with the injected credentials and maps status codes', async () => {
    const calls = stubFetch((url) => {
      if (url.includes('/users/me')) return { status: 200, body: JSON.stringify({ id: 'primary' }) };
      return { status: 200, body: JSON.stringify({ access_token: 'at', expires_in: 3600 }) };
    });
    const provider = createGoogleCalendar({ clientId: 'c', clientSecret: 's', redirectUri: 'r', now });
    const result = await provider.completeAuthorization('code', 'verifier');
    expect(result.externalAccountId).toBe('primary');
    expect(calls.some((c) => c.url === 'https://oauth2.googleapis.com/token')).toBe(true);
    const me = calls.find((c) => c.url === 'https://www.googleapis.com/calendar/v3/users/me');
    expect(me).toBeTruthy();
    expect((me!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer at');
  });

  it('maps 424 (failed dependency) to a rate-limited skip', async () => {
    stubFetch(() => ({ status: 424, body: '{}' }));
    const provider = createGoogleCalendar({
      clientId: 'c', clientSecret: 's', redirectUri: 'r', now,
      initialTokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: '2026-09-13T00:00:00.000Z', scopes: null },
    });
    const err = await provider.listChanges({ syncToken: null, timeMin: '2026-09-11T00:00:00.000Z' }).catch((e) => e);
    expect(err).toBeInstanceOf(CalendarRateLimited);
  });
});

describe('createGoogleCalendar — edge branches', () => {
  it('revoke without tokens is a silent no-op', async () => {
    const w = wire();
    const provider = createGoogleCalendar({ clientId: 'c', clientSecret: 's', redirectUri: 'r', transport: w.transport, now });
    await expect(provider.revoke()).resolves.toBeUndefined();
    expect(w.calls).toHaveLength(0);
  });

  it('a token without an expiry is used as-is (no refresh)', async () => {
    const provider = createGoogleCalendar({
      clientId: 'c', clientSecret: 's', redirectUri: 'r', now,
      initialTokens: { accessToken: 'at-fresh', refreshToken: 'rt', expiresAt: null, scopes: null },
    });
    expect(await provider.ensureAccessToken()).toBe('at-fresh');
  });

  it('completeAuthorization stores a null refresh token when Google omits it', async () => {
    const w = wire();
    w.setResponder((call) =>
      call.url.startsWith('https://oauth2.googleapis.com/token')
        ? { status: 200, body: JSON.stringify({ access_token: 'at', expires_in: 3600 }) }
        : { status: 200, body: JSON.stringify({ id: 'primary' }) },
    );
    const provider = createGoogleCalendar({ clientId: 'c', clientSecret: 's', redirectUri: 'r', transport: w.transport, now });
    const result = await provider.completeAuthorization('code', 'verifier');
    expect(result.tokens.refreshToken).toBeNull();
  });

  it('creates all-day events with date fields and no transparency', async () => {
    const w = wire();
    w.setResponder((call) => {
      const body = JSON.parse(call.body);
      expect(body.start.date).toBe('2026-09-15');
      expect(body.end.date).toBe('2026-09-16');
      expect(body).not.toHaveProperty('transparency');
      return { status: 200, body: JSON.stringify({ id: 'ext-all', etag: 'e', summary: 'Holiday', start: { date: '2026-09-15' }, end: { date: '2026-09-16' }, updated: '2026-09-12T00:00:03Z' }) };
    });
    const provider = createGoogleCalendar({
      clientId: 'c', clientSecret: 's', redirectUri: 'r', transport: w.transport, now,
      initialTokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: '2026-09-13T00:00:00.000Z', scopes: null },
    });
    const written = await provider.writeEvent({ externalId: null, calendarId: 'primary', title: 'Holiday', startsAt: '2026-09-15T00:00:00.000Z', endsAt: '2026-09-16T00:00:00.000Z', timeZone: null, isAllDay: true, busy: true });
    expect(written.isAllDay).toBe(true);
  });
});

describe('FixtureCalendarProvider — edge branches', () => {
  const withTokens = { tokens: { accessToken: 'fx-at', refreshToken: 'fx-rt', expiresAt: '2027-01-01T00:00:00.000Z', scopes: null } };

  it('expireAccessToken without tokens is a no-op; ops without tokens fail with CalendarAuthError', async () => {
    const provider = new FixtureCalendarProvider();
    provider.expireAccessToken(); // no tokens: nothing to expire
    await expect(provider.getEvent('nope')).rejects.toBeInstanceOf(CalendarAuthError);
    expect(() => provider.currentTokens()).toThrow();
  });

  it('getEvent of a missing id returns null; deleteEventExternal of an unknown id is a no-op', async () => {
    const provider = new FixtureCalendarProvider(withTokens);
    expect(await provider.getEvent('nope')).toBeNull();
    provider.deleteEventExternal('unknown');
    expect(provider.store.size).toBe(0);
  });

  it('writeEvent patches an existing event and preserves its id', async () => {
    const provider = new FixtureCalendarProvider({
      ...withTokens,
      events: [{ externalId: 'ext-p', title: 'Old', startsAt: '2026-09-13T10:00:00.000Z', endsAt: '2026-09-13T11:00:00.000Z' }],
    });
    const written = await provider.writeEvent({ externalId: 'ext-p', calendarId: 'primary', title: 'New', startsAt: '2026-09-13T11:00:00.000Z', endsAt: '2026-09-13T12:00:00.000Z', timeZone: null, isAllDay: false, busy: true, etag: 'etag-ext-p' });
    expect(written.externalId).toBe('ext-p');
    expect(provider.calls.some((c) => c.op === 'patch')).toBe(true);
  });
});

describe('recurring instance identity (M7-i2, PRD §16.3 per-occurrence keys)', () => {
  function seriesItem(seriesId: string, original: string | null, at: { start: string; end: string }, status: string = 'confirmed') {
    return {
      id: seriesId,
      recurringEventId: seriesId,
      ...(original ? { originalStartTime: { dateTime: original } } : {}),
      status,
      summary: 'Standup',
      start: { dateTime: at.start },
      end: { dateTime: at.end },
      updated: '2026-09-10T00:00:00Z',
    };
  }

  it('derives a distinct per-occurrence key for every instance of one series', () => {
    const a = toDto(seriesItem('series-1', '2026-09-13T09:00:00.000Z', { start: '2026-09-13T09:00:00.000Z', end: '2026-09-13T09:30:00.000Z' }));
    const b = toDto(seriesItem('series-1', '2026-09-14T09:00:00.000Z', { start: '2026-09-14T09:00:00.000Z', end: '2026-09-14T09:30:00.000Z' }));
    expect(a.externalId).toBe('series-1!2026-09-13T09:00:00.000Z');
    expect(b.externalId).toBe('series-1!2026-09-14T09:00:00.000Z');
    expect(a.externalId).not.toBe(b.externalId);
    // Each instance's own start/end drives the DTO (display), never the key.
    expect(b.startsAt).toBe('2026-09-14T09:00:00.000Z');
    expect(b.endsAt).toBe('2026-09-14T09:30:00.000Z');
  });

  it('keys all-day instances off the original date', () => {
    const dto = toDto({ id: 'series-2', recurringEventId: 'series-2', originalStartTime: { date: '2026-09-13' }, status: 'confirmed', summary: 'Lunch', start: { date: '2026-09-13' }, end: { date: '2026-09-14' } });
    expect(dto.externalId).toBe('series-2!2026-09-13');
    expect(dto.isAllDay).toBe(true);
  });

  it('keeps the bare id for non-recurring and series-level items', () => {
    const plain = toDto({ id: 'plain-1', status: 'confirmed', summary: 'One-off', start: { dateTime: '2026-09-13T10:00:00.000Z' }, end: { dateTime: '2026-09-13T11:00:00.000Z' } });
    expect(plain.externalId).toBe('plain-1');
    // A cancelled whole series arrives as ONE series-level item (no originalStartTime).
    const series = toDto({ id: 'series-9', recurringEventId: 'series-9', status: 'cancelled', summary: 'Standup', start: { dateTime: '2026-09-10T09:00:00.000Z' }, end: { dateTime: '2026-09-10T09:30:00.000Z' } });
    expect(series.externalId).toBe('series-9');
  });

  it('keeps the key stable when an occurrence is rescheduled (originalStartTime, not start)', () => {
    const before = toDto(seriesItem('series-3', '2026-09-13T09:00:00.000Z', { start: '2026-09-13T09:00:00.000Z', end: '2026-09-13T09:30:00.000Z' }));
    const after = toDto(seriesItem('series-3', '2026-09-13T09:00:00.000Z', { start: '2026-09-13T15:00:00.000Z', end: '2026-09-13T15:30:00.000Z' }));
    expect(after.externalId).toBe(before.externalId);
    expect(after.startsAt).toBe('2026-09-13T15:00:00.000Z');
  });

  it('listChanges reports occurrence cancels with the composite key and series cancels with the bare id', async () => {
    const w = wire();
    w.setResponder((call) => {
      if (call.url.includes('/events?') || call.url.includes('/events&')) {
        return {
          status: 200,
          body: JSON.stringify({
            items: [
              { id: 's1', recurringEventId: 's1', originalStartTime: { dateTime: '2026-09-14T09:00:00.000Z' }, status: 'confirmed', summary: 'Standup', start: { dateTime: '2026-09-14T09:00:00.000Z' }, end: { dateTime: '2026-09-14T09:30:00.000Z' } },
              { id: 's1', recurringEventId: 's1', originalStartTime: { dateTime: '2026-09-13T09:00:00.000Z' }, status: 'cancelled', summary: 'Standup', start: { dateTime: '2026-09-13T09:00:00.000Z' }, end: { dateTime: '2026-09-13T09:30:00.000Z' } },
              { id: 's2', recurringEventId: 's2', status: 'cancelled', summary: 'Old series', start: { dateTime: '2026-09-10T09:00:00.000Z' }, end: { dateTime: '2026-09-10T09:30:00.000Z' } },
              { id: 'gone', status: 'cancelled' },
            ],
            syncToken: 'tok-next',
          }),
        };
      }
      return { status: 200, body: '{}' };
    });
    const provider = createGoogleCalendar({ clientId: 'c', clientSecret: 's', redirectUri: 'r', transport: w.transport, now, initialTokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: '2026-09-13T00:00:00.000Z', scopes: null } });
    const changes = await provider.listChanges({ syncToken: null, timeMin: '2026-09-01T00:00:00.000Z' });
    expect(changes.events.map((e) => e.externalId)).toEqual(['s1!2026-09-14T09:00:00.000Z']);
    expect(changes.deletedExternalIds).toEqual(['s1!2026-09-13T09:00:00.000Z', 's2', 'gone']);
    expect(changes.nextSyncToken).toBe('tok-next');
  });
});

describe('FixtureCalendarProvider — recurring series (M7-i2)', () => {
  const withTokens = { tokens: { accessToken: 'fx-at', refreshToken: 'fx-rt', expiresAt: '2027-01-01T00:00:00.000Z', scopes: null } };
  const instances = [
    { originalStartTime: '2026-09-13T09:00:00.000Z', title: 'Standup A', startsAt: '2026-09-13T09:00:00.000Z', endsAt: '2026-09-13T09:30:00.000Z' },
    { originalStartTime: '2026-09-14T09:00:00.000Z', title: 'Standup B', startsAt: '2026-09-14T09:00:00.000Z', endsAt: '2026-09-14T09:30:00.000Z' },
  ];

  it('pushSeries stores one entry per occurrence under per-occurrence keys', async () => {
    const provider = new FixtureCalendarProvider(withTokens);
    const keys = provider.pushSeries('series-1', instances);
    expect(keys).toEqual(['series-1!2026-09-13T09:00:00.000Z', 'series-1!2026-09-14T09:00:00.000Z']);
    const changes = await provider.listChanges({ syncToken: 'tok-0', timeMin: '2026-09-01T00:00:00.000Z' });
    expect(changes.events.map((e) => e.externalId)).toEqual(keys);
    expect(changes.events.find((e) => e.externalId === keys[0])!.title).toBe('Standup A');
    // getEvent resolves an occurrence by its composite key.
    expect((await provider.getEvent(keys[1]!))!.title).toBe('Standup B');
    expect(await provider.getEvent('series-1')).toBeNull(); // the bare series id is not a stored event
  });

  it('deleteEventExternal of one occurrence reports only that occurrence', async () => {
    const provider = new FixtureCalendarProvider(withTokens);
    const [k1, k2] = provider.pushSeries('series-1', instances);
    provider.deleteEventExternal(k1!);
    const changes = await provider.listChanges({ syncToken: 'tok-0', timeMin: '2026-09-01T00:00:00.000Z' });
    expect(changes.deletedExternalIds).toEqual([k1]);
    expect(changes.events.map((e) => e.externalId)).toEqual([k2]);
  });

  it('deleteSeriesExternal reports ONE bare series-level deletion (the singleEvents shape), idempotently', async () => {
    const provider = new FixtureCalendarProvider(withTokens);
    provider.pushSeries('series-1', instances);
    provider.pushSeries('series-2', [instances[0]!]);
    provider.deleteSeriesExternal('series-1');
    const changes = await provider.listChanges({ syncToken: 'tok-0', timeMin: '2026-09-01T00:00:00.000Z' });
    expect(changes.deletedExternalIds).toEqual(['series-1']); // not the two instance keys
    expect(changes.events.map((e) => e.externalId)).toEqual(['series-2!2026-09-13T09:00:00.000Z']); // sibling series untouched
    // The next sync re-reports the same single series-level deletion.
    const again = await provider.listChanges({ syncToken: changes.nextSyncToken, timeMin: '2026-09-01T00:00:00.000Z' });
    expect(again.deletedExternalIds).toEqual(['series-1']);
  });
});
