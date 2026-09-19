# M8-i6 — Google Calendar webhook ingress replay/fairness hardening

**Status:** IMPLEMENTED.
**Date:** 2026-09-19.
**Scope source:** `docs/M8_i6_REMAINING_HARDENING_REVIEW.md` at review commit `e6eab16`.

M8-i6 implements only the two approved Calendar ingress hardening items:

1. **T2 — Google Calendar webhook redelivery/replay deduplication**
2. **T6b — token-scoped webhook bucket fairness**

It does not reopen M8-i5, does not attempt live Google verification, does not add
a dedicated channel-token column (`T3`), and does not add Calendar product
features.

## 1. As-built T2 mechanism

Webhook delivery dedupe is implemented in the Calendar webhook service path:

- `apps/web/src/server/services/calendar-connections.ts`
  - `handleCalendarWebhook(channelToken, { messageId? })` now accepts an optional
    normalized provider notification id.
  - When `messageId` is present, it claims a durable ledger row before running the
    import.
  - The dedupe identity is exactly `(connection_id, message_id)`.
  - Successful replays return `200` with `duplicate: true` and make zero provider
    calls.
  - Same `messageId` on another connection is independent.
  - Absent `messageId` preserves the previous behavior: active token triggers an
    import; unknown/inactive token returns `ok: false`.
  - Failed deliveries are marked `FAILED` and immediately reclaimable so legitimate
    provider retries after a processing failure can run again.
  - Stale in-progress leases are reclaimable, avoiding permanent stuck rows.

Ledger details:

- Table: `calendar_webhook_deliveries`
- Primary key: `(connection_id, message_id)`
- Statuses: `PROCESSING`, `SUCCEEDED`, `FAILED`
- TTL: 24 hours from claim time
- Processing lease: 5 minutes
- Stored data: scoped connection id, normalized message id, status/timestamps,
  imported count, and truncated error text. The raw channel token is not stored,
  and no OAuth token or calendar/task content is added to the ledger.

Retention:

- `packages/db/src/calendar-sync.ts` now purges expired webhook-delivery rows via
  `sweepCalendarRetention`, returning `webhookDeliveries` alongside the existing
  Calendar retention counters.
- `apps/worker/src/jobs.ts` logs the expanded Calendar retention counters when
  any of them are non-zero.

## 2. As-built T6b mechanism

`apps/web/src/app/api/v1/calendar/webhook/route.ts` now performs Calendar-webhook
rate limiting after safe body parsing:

- Well-formed active/unknown tokens are limited by a token-scoped fixed window:
  `300/minute` per channel token.
- Bucket keys use a SHA-256 hash prefix of the token; raw token values are not
  placed in rate-limit keys that might be logged or inspected.
- Missing, malformed, or invalid JSON traffic is bounded by an IP-level invalid
  guard at `300/minute`.
- A shared global IP safety guard remains in place at `3000/minute`, checked only
  after the per-token bucket admits the request. This prevents one exhausted
  token from continuing to spend the shared IP bucket and starving unrelated
  tokens.
- Exhausted buckets return HTTP `429` with `Retry-After` using the existing
  problem-details shape.
- Unknown but well-formed tokens still return `200` / no-op once admitted; they do
  not invoke a provider.

## 3. Schema and migration

New forward-only migration:

- `packages/db/migrations/0024_calendar_webhook_deliveries.sql`

Schema export:

- `packages/db/src/schema.ts` adds `calendarWebhookDeliveries` with the same
  primary key, status check, non-negative imported check, and expiry/processing
  indexes.

No historical migration was edited. The migration runner applies `0024` after
`0023_rate_limited_until.sql` and remains checksum-validated.

## 4. Deterministic regression coverage

Expanded `apps/web/src/server/services/calendar-sync.integration.test.ts` covers:

- First delivery processes normally.
- Exact duplicate and multiple duplicates return duplicate/no-op and make zero
  provider calls.
- Duplicate after success is a no-op.
- Failed first delivery is marked `FAILED`; provider retry after failure succeeds;
  later duplicate after success is a no-op.
- Same provider message id on a different connection processes independently.
- Distinct provider message ids on the same connection process independently.
- Tenant isolation remains intact.
- Concurrent duplicate deliveries produce one import and one no-op loser.
- Expired dedupe rows are purged by Calendar retention without touching mirror
  events.
- A noisy token can exhaust its own 300/min bucket, receives `Retry-After`, and a
  second token from the same IP is still admitted.
- Window rollover admits the previously exhausted token again.
- Missing-token traffic is IP-guarded and does not affect a valid token bucket.

Existing Calendar, billing dedupe, worker Calendar sync, migration integrity, and
security-boundary suites were left intact.

## 5. Local validation snapshot

Local validation used the embedded PostgreSQL service on port `55432` with:

- `DATABASE_URL=postgres://postgres:postgres@localhost:55432/nextdoo`
- `AUTH_SECRET=test-only-secret-0123456789abcdefghij`
- `APP_URL=http://localhost:3100` for unit/integration/build and
  `APP_URL=http://localhost:3000` for Playwright attempts.

Passing local checks:

- `corepack pnpm --filter @nextdoo/db migrate` — applied `0024`.
- `corepack pnpm --filter @nextdoo/db migrate` ×2 after application — already up
  to date.
- Targeted Calendar sync/webhook integration:
  `vitest run apps/web/src/server/services/calendar-sync.integration.test.ts --silent`
  — **31 passed**.
- Targeted worker Calendar regression:
  `vitest run apps/worker/src/calendar-sync.integration.test.ts` — **20 passed**.
- Full unit/integration suite:
  `vitest run --silent` — **79 files / 900 tests passed** before the final
  concurrent-fairness regression was added; the final coverage run below executed
  the expanded **79 files / 901 tests** suite.
- Coverage gate:
  `vitest run --coverage --silent` — **79 files / 901 tests passed**; coverage
  summary **89.2% statements / 81.77% branches / 92.27% functions / 93.14% lines**.
- Lint:
  `eslint . --max-warnings=0` — clean.
- Typecheck:
  `turbo run typecheck` — **7 packages successful**.
- Production build:
  `turbo run build` — Next.js build successful.

Local E2E status:

- `pnpm --filter @nextdoo/web test:e2e` initially started but browser-launch tests
  failed immediately because the Playwright Chromium executable was absent from
  `/home/user/.cache/ms-playwright`.
- `pnpm --dir apps/web exec playwright install chromium` was attempted, but the
  sandbox could not download from `cdn.playwright.dev` (`ECONNRESET`).
- Therefore local E2E is **environment-blocked by missing browser binaries** in
  this sandbox, not by an application assertion. GitHub CI is expected to run the
  Playwright browser install and full E2E path, as it did successfully for the
  M8-i6 review commit.

## 6. Security, tenancy, and Calendar invariants

- No raw OAuth tokens, refresh tokens, or channel-token values are stored in the
  new ledger.
- Route logs include request id, route name, status/code and duration only; they
  do not log token values or webhook bodies.
- Dedupe is connection-scoped, preventing cross-tenant swallowing of equivalent
  provider message ids.
- Unknown/inactive channel tokens remain inert `200` no-op after rate admission.
- Existing Calendar import/export behavior, polling fallback, connection state
  transitions, token reseal/rotation, rate-limited outbound sync handling, and
  tenant-scoped event listing were not redesigned.
- The existing global safety posture remains, but no single admitted token can
  monopolize the Calendar webhook ingress quota for unrelated tokens.

## 7. Live Google status and deferred items

Live Google verification remains **blocked** for the same M8-i5 reasons: no live
Google credentials, no public HTTPS redirect/webhook host, no provider egress, and
no inbound webhook reachability in this sandbox. This increment makes no live
Google claim and does not simulate live provider header semantics beyond the
already-normalized `eventId` fixture envelope.

Deferred / not implemented by M8-i6:

- T3 dedicated random channel-token column and channel-token rotation.
- Live Google watch/webhook verification.
- Optional disconnect export cleanup.
- Proactive Google quota bucket modeling.
- Multi-calendar, RRULE/series editing, Outlook/CalDAV, and new Calendar UI.
- Any M8-i7 work.

## 8. Next recommended milestone

Stop after M8-i6. The next recommended milestone remains the release-gate
hardening candidate called out by the M8-i6 review: CI database restore smoke
coverage, unless the team instead unblocks live Google prerequisites and reopens
the externally blocked live-provider verification path.
