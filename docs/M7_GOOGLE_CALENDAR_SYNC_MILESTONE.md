# M7 — Google Calendar two-way sync (increment 1)

Bounded M7 increment: the complete Google Calendar two-way sync described by
PRD §16, built on the existing sync/conflict architecture (no parallel sync
system), with the provider behind a clean boundary so the Google adapter is
swappable and every test is deterministic without network.

Date: 2026-09-13 · Branch: `arena/01a085b7-nextdoo` · Status: complete (live
Google verification externally blocked — see below)

## 1. What was implemented

**Provider boundary** (new package `packages/calendar` + contracts module
`calendar-provider.ts`):

- `CalendarProvider` interface: `beginAuthorization(mode)` (PKCE S256),
  `completeAuthorization(code, codeVerifier)`, `ensureAccessToken()` (refresh
  on demand + refresh-token rotation), `currentTokens()`, `revoke()`,
  `listChanges({syncToken, timeMin})` (incremental, paging, cancelled→deleted),
  `getEvent`, `writeEvent` (create / PATCH with If-Match; 404/412→recreate),
  `deleteEvent` (404 = success), `ensureChannel` (push channel, <7-day
  expiry).
- `CalendarAuthError` (401 → pause + reconnect prompt) and
  `CalendarRateLimited` (403/429/424 → skip pass with Retry-After) error
  types in `@nextdoo/contracts`.
- `createGoogleCalendar` — the Google adapter: minimum scopes per mode
  (`calendar.readonly` vs `calendar`, never drive/contacts/mail),
  `accounts.google.com/o/oauth2/v2/auth` with `access_type=offline`,
  token exchange/refresh at `oauth2.googleapis.com/token`,
  `events.list` with `singleEvents=true` (recurrence → instances in window)
  + syncToken + pageToken paging, `events/watch` push channel. All I/O goes
  through an injectable transport (default: global fetch), so unit tests are
  deterministic and live verification stays separate.
- `FixtureCalendarProvider` — deterministic in-memory implementation of the
  same interface (sync tokens, etags, deletions, 401/429, channels). Used by
  every integration/E2E-seeding path. **Test-only; never wired into product.**

**Sync engine** (`packages/db/src/calendar-sync.ts`):

- `runCalendarImport` — normalizes provider changes into
  `calendar_events` (PRD §16.3 shape: external_id, calendar_id, title,
  starts/ends, time_zone, is_all_day, busy, etag); applies external-only
  changes to mapped tasks **through the task invariants** (version bump,
  reschedule count, sync change on the device cursor, transactional outbox
  event — indistinguishable from an online edit); detects both-side changes
  as `CONFLICT` with both values preserved (PRD §16.4); external deletions
  unschedule the task + durable in-app notification (PRD §16.6 AC-3).
- `runCalendarExport` — due-time tasks (30-day horizon) become timed events
  on the provider's primary (NEXTDOO) calendar; idempotent via the unique
  `(connection_id, task_id)` mapping (PRD §16.6 AC-4); locally rescheduled
  tasks PATCH the event (If-Match etag from the mirror; 404→recreate +
  re-link); deleted/unscheduled tasks delete their event (PRD §16.6 AC-2).
  READ_WRITE connections only.
- `runCalendarSyncCycle` — the worker's 60-second job body: export every
  cycle (PRD §16.6 AC-1's 60-second guarantee), import on the 10-minute
  incremental-poll cadence (PRD §16.1), push-channel renewal before lapse,
  retention sweep. Failure policy (PRD §12.4): auth failures pause the
  connection with a reconnect prompt immediately (PRD §16.6 AC-5); rate
  limits skip without counting; generic transport failures count per
  connection and pause+notify after 5 consecutive
  (`consecutive_failures` column).
- `finalizeDisconnect` (PRD §16.5) — revoke where supported, wipe tokens
  from storage, stop sync immediately; mappings retained 30 days; imported
  tasks and exported events left in place (exported-event deletion is NOT
  the default).
- `sweepCalendarRetention` — expired OAuth states + 30-day post-disconnect
  mapping/event mirrors (tasks and audit never touched).
- `applyTaskDueChange` (exported) — the shared task-mutation primitive used
  by both the engine and the conflict-resolution path.

**Web** (routes + service extensions in `calendar-connections.ts`):

- `POST /calendar/connections/google/start` — **mode chosen before
  authorization** (PRD §16.2); 503 `PROVIDER_UNAVAILABLE` when the
  deployment has no Google credentials (honest degradation, billing
  precedent); single-use, 10-minute hashed OAuth state row (PKCE verifier
  stored).
- `GET /calendar/connections/google/callback` — public; state hash is the
  credential; redirects to `/settings?calendar=connected|error=…`.
- `POST /calendar/connections/:id/reconnect` — the reconnect prompt flow;
  doubles as the mode-change (PATCH-connection) semantics since a scope
  change requires fresh consent.
- `POST /calendar/connections/:id/sync` — manual import+export now.
- `GET /calendar/events?start&end` — normalized provider events for the
  window (tenant-scoped to the caller's ACTIVE connections).
- `POST /calendar/webhook` — Google push-channel target (channel token =
  connection id, which Google echoes back); triggers an immediate import for
  exactly that connection; unknown tokens are ignored.
- `GET /calendar/connections/:id/conflicts` +
  `POST /calendar/connections/:id/conflicts/:mappingId/resolve` — both-side
  conflicts list both values; KEEP_TASK (patch event to task), KEEP_CALENDAR
  (reschedule task through the task invariants), UNLINK (mapping removed,
  both sides keep their data). Every decision audit-logged with the user as
  actor (PRD §16.4).
- `DELETE /calendar/connections/:id` now implements PRD §16.5 (revoke +
  token wipe) — the pre-M7 "tokens retained" behavior was superseded by the
  PRD requirement; the pre-existing integration test was updated
  accordingly (disclosed in the report).

**Worker**: `calendar.sync` job (60 s) in `apps/worker/src/jobs.ts` —
provider built from `GOOGLE_CLIENT_ID/SECRET` + `AUTH_SECRET` (sealed
envelope via `openSecret`, purpose `calendar_token`); unconfigured
deployment → cheap no-op.

**UI**: `CalendarSettings` (Settings → Calendar): mode radio before
connect, connect/reconnect/disconnect/sync-now, paused-connection reconnect
banner (PRD §16.6), conflict cards with the three PRD §16.4 choices, honest
"not configured in this deployment" banner on 503. `CalendarView` renders
provider events as read-only "cal" blocks in day/week/month.

**Schema** (migration `0021_calendar_oauth_states.sql`):
`calendar_oauth_states` (state_hash PK, user, workspace, mode, code_verifier,
expires_at); `calendar_connections` gains `pause_reason`,
`channel_expires_at`, `consecutive_failures`; `calendar_events` gains
`etag` (If-Match for optimistic re-export).

## 2. Scope decisions (documented per PRD review)

| Decision | Rationale |
| --- | --- |
| Recurring events imported as **expanded instances** in the sync window | PRD §16.3's normalized shape has no recurrence field; `singleEvents=true` is the MVP contract. Storing full recurrence rules is a later increment. |
| Mode is the export toggle; reconnect route = PATCH-connection semantics | PRD §14.3's `PATCH :id` covers credential-bound fields, and a scope change (RO↔RW) inherently requires re-authorization (PRD §16.2). Documented divergence, same behavior. |
| 60-second AC-1 met by the 60 s export job cycle + manual sync | Imports run on the 10-minute poll (PRD §16.1); the export guarantee is the 60-second one. |
| Webhook channel token = connection id | Google echoes it back verbatim; it scopes the import to exactly that connection (no cross-tenant effect). A dedicated random token column is a cheap future hardening. |
| Tokens remain in `calendar_connections` (sealed envelopes) | Existing M4 storage, already covered by the plan/entitlement and capacity seams; §16.1 requires refresh on demand — done via the adapter. |
| `notifications.type='calendar'` | The column is a free varchar(60); no migration needed. |

## 3. Acceptance criteria (PRD §16.6) and test evidence

All verified in `apps/web/src/server/services/calendar-sync.integration.test.ts`
(real PostgreSQL + deterministic fixture provider, zero network):

1. **Due-time task on the NEXTDOO calendar within 60 s** — export pass
   creates the event + mapping in one pass; the worker cycle runs every
   60 s (`calendar.sync` job, `intervalMs: 60_000`, asserted in the worker
   integration suite). ✔
2. **Task deletion removes the mapped event** — `AC-2` test: event deleted
   provider-side, mapping removed, re-run is a no-op (idempotent). ✔
3. **Event deleted in Google → task unscheduled + user notified** —
   `AC-3` test: `dueAt` nulled, `rescheduleCount+1`, `version+1`, sync
   change on the device cursor, durable `calendar` notification, mapping
   removed. ✔
4. **No duplicate events (unique connection_id, task_id)** — `AC-1/AC-4`
   test: re-running the export creates nothing; the DB unique index is the
   backstop. ✔
5. **Revoked/expired token → pause + reconnect prompt** — `AC-5` test:
   connection `SUSPENDED` + `pause_reason` + reconnect notification;
   `syncConnectionNow` refuses until reconnected; E2E shows the
   `calendar-reconnect-prompt` banner. ✔

Plus: PRD §16.4 both-side change → CONFLICT with both values and
three-way resolution (all three actions tested, each audit-logged; title is
never silently overwritten); external-only change applied through the task
invariants; 429 skips the pass without state change or failure counts;
PRD §12.4 pause-after-5-consecutive-generic-failures; disconnect PRD §16.5
(revoke called, tokens wiped, mappings retained, task survives); retention
sweep (expired OAuth states; 30-day post-disconnect mirrors, task survives);
tenant isolation (B never sees A's connections/events/conflicts — API 404
and no cross-import); adapter unit tests (PKCE URL/scopes per mode, code
exchange, refresh + rotation, sync-token paging, cancelled→deleted,
401/429/424 mapping, If-Match patch, 404-recreate, 404-delete, channel
watch, §16.3 normalization, all-day events, default fetch wiring).

E2E (`apps/web/e2e/calendar-sync.spec.ts`, real browser, unconfigured
deployment — the honest path): mode-before-auth UI, 503 → "not configured"
banner, reconnect prompt for a suspended connection, conflict card with
both values + resolution, disconnect (task survives), read-only provider
event blocks in CalendarView, cross-tenant 404. 6/6 passed.

## 4. Validation results (local, 2026-09-13)

- Unit + integration: **781/781** (was 741 before M7; +40 new).
- Coverage: all thresholds pass; `packages/calendar/src` **90.2% stmts /
  80.4% branches / 92.9% functions / 92.4% lines** (threshold 80/70/80/80);
  overall 88.8% statements.
- Typecheck: all packages (contracts, calendar, db, web, worker).
- Lint: 0 warnings. Production build: clean.
- E2E: **147 passed**; the only local failure is `attachments.spec`
  refusing to run without the ClamAV engine (by design — CI installs
  ClamAV; this sandbox has no egress to install it).

## 5. Live Google verification — EXTERNALLY BLOCKED (recorded, not faked)

Live end-to-end verification against real Google (OAuth consent screen,
real `oauth2.googleapis.com` token exchange, real `www.googleapis.com`
event traffic, real push channels) **could not be performed in this
environment**:

1. **No Google credentials** — `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
   are not provisioned here (and a consent-screen client would also need
   the redirect URI allow-listed).
2. **No network egress to Google** — the sandbox blocks
   `accounts.google.com`, `oauth2.googleapis.com` and
   `www.googleapis.com` (verified: connection failure; only
   `github.com`, `codeload.github.com`, `registry.npmjs.org` are
   reachable).

Per the M7 directive, no Google API call was faked and no live
verification is claimed. What IS verified: the adapter's exact request
shape (URLs, scopes, PKCE parameters, form bodies, If-Match, sync-token
paging, status-code mapping) against a deterministic transport, and the
entire engine/worker/UI behavior against the fixture provider implementing
the same contract. **To unblock**: provision a Google OAuth client
(id/secret + `http://<host>/api/v1/calendar/connections/google/callback`
redirect URI), set the two env vars, and allow egress to the three Google
hosts; the feature gates on presence and degrades to 503 until then.

## 6. Recommended next M7 increment

**M7-i2: live Google verification + hardening** — with credentials + egress:
real OAuth consent flow, real event traffic (incl. a recurring series →
instance expansion), real push-channel webhook delivery, token rotation over
time, and the 7-day channel renewal in production. Cheap hardening that can
ship in the same increment: dedicated random channel-token column (instead
of connection id), rate-limit backoff scheduling (currently skip-pass), and
a `calendar.disconnect` purge of the external NEXTDOO events when a user
explicitly asks (opt-in, never default — PRD §16.5).
