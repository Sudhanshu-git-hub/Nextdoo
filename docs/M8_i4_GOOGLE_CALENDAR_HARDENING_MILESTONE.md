# M8-i4 — Google Calendar two-way sync reliability hardening — implementation

**Status: IMPLEMENTED (this milestone).** Design authority:
`docs/M8_i4_GOOGLE_CALENDAR_HARDENING_REVIEW.md` (committed at `267a80c`,
CI-verified), PRD §§16.1, 16.4, 16.6, 12.4, 11.4, 13.5.

Per the approved review, M8-i4 closes exactly four items, in this order:
**T1** (persist refreshed/rotated tokens — the only class-1 defect),
**T5** (invalid sync-token recovery), **T4** (rate-limit backoff persisted
across cycles, migration `0023`), **T6a** (worker logs rate-limited cycles).
No new Calendar product features; T3 (channel-token column) remains
explicitly deferred (audit L4); class-5 live-Google items remain
CLOSED-BLOCKED (re-probed this increment — still blocked, §7).

## What was built

| File | Kind | Purpose |
| --- | --- | --- |
| `packages/db/migrations/0023_rate_limited_until.sql` | **new migration** | `ALTER TABLE calendar_connections ADD COLUMN rate_limited_until TIMESTAMPTZ;` |
| `packages/db/src/schema.ts` | touched | `rateLimitedUntil` column (between `channelExpiresAt` and `consecutiveFailures`) |
| `packages/contracts/src/calendar-provider.ts` | extended | `CalendarSyncTokenInvalid` error type (typed 400 invalid-sync-token signal) |
| `packages/calendar/src/google.ts` | extended | `parseRetryAfter` (delta-seconds **and** HTTP-date forms); 400 + `sync_?token` body → `CalendarSyncTokenInvalid` |
| `packages/db/src/calendar-sync.ts` | extended | T1 re-seal seam (`tokensFor`/`sealTokens` deps, `tokensChanged`, `initialTokens`), T5 recovery in `runCalendarImport` + `calendar.sync_token_reset` audit, T4 `recordRateLimit` + cycle skip, `result.tokenUpdates` |
| `packages/calendar/src/fixture.ts` | extended (test seam) | `rotateOnRefresh`, shared `store`, `invalidateSyncToken()`, `lastDeliveredSyncToken` |
| `apps/worker/src/jobs.ts` | extended | `openCalendarTokens`/`sealCalendarTokens` (envelope round-trip), cycle wired with both, `calendar.sync.rate_limited` warn (T6a) |
| `apps/web/src/server/services/calendar-connections.ts` | extended | `calendarProviderTokens` (single decrypt source), `syncConnectionNow` re-seals a changed token set |
| `apps/worker/src/calendar-sync.integration.test.ts` | extended | 14 new tests (T1 ×8, T4 ×5, T6a ×1) |
| `apps/web/src/server/services/calendar-sync.integration.test.ts` | extended | 5 new tests (T5 ×3, T1 manual-sync ×2) |
| `packages/calendar/src/google.test.ts` | extended | 7 new tests (Retry-After forms, 400 detection, fixture T5 seam) |

No new endpoints, no API shape changes, no new workers. The
`calendar.sync` job registry (name / 60 s cadence / §12.4 contract) is
unchanged.

## 1. T1 — refreshed/rotated tokens are re-sealed and reused

The PRD §16.1 row requires access tokens "refreshed on demand and **cached
until expiry**". Before M8-i4, the Google adapter refreshed in memory and
discarded the new set on every worker cycle (and on every manual sync):
the stored envelope kept the pre-refresh credentials, so the next cycle
re-opened the stale set and refreshed again — an unbounded token-endpoint
call every 60 s, and a rotated refresh token was silently lost.

Implementation (both persistence paths, same mechanism):

- **Engine seam** (`packages/db/src/calendar-sync.ts`): the cycle now
  accepts `tokensFor(row) → CalendarTokenSet | null` (opens the stored
  sealed set — the engine never sees plaintext sealing) and
  `sealTokens(row, tokens)` (persists the new set through the caller's
  existing encrypted-token mechanism). After export + import + channel
  renewal, the engine compares the provider's `currentTokens()` against
  the opened baseline with `tokensChanged` (access token, refresh token,
  expiry **and** scopes). Only on a real change does it call `sealTokens`
  — an unchanged set causes **zero** writes. `CalendarCycleResult` gains
  `tokenUpdates`.
- **Worker path** (`apps/worker/src/jobs.ts`): `openCalendarTokens`
  opens both envelopes with the `calendar_token` purpose (null when
  `AUTH_SECRET` is missing, no token stored, or the envelope is
  tampered — preserving the existing "tampered → tokenless provider →
  pause" fall-through); `sealCalendarTokens` re-seals both tokens
  (envelope v1, `sealSecret`) plus `token_expires_at`, keeping `scopes`
  via column self-reference. Wired into `runCalendarSyncCycle`.
- **Manual-sync path** (`syncConnectionNow`): opens the row's set as the
  baseline, runs the passes, and re-seals through the web app's
  `encryptSecret` when `tokensChanged` — same envelope mechanism as the
  OAuth callback.
- **Semantics preserved:** refresh is still on-demand (expiry-driven);
  a refresh that *fails* keeps the existing failure semantics (auth
  error → pause + reconnect prompt, no partial re-seal); a re-seal never
  increments `consecutive_failures` and never pauses.

## 2. T5 — invalid sync-token recovery (not a repeated failure)

When Google invalidates the stored incremental sync token (change-count
lifetime, channel churn), `events.list?syncToken=…` answers **400**. The
adapter now maps that specific response to `CalendarSyncTokenInvalid`
(status 400 + body matching `/sync_?token/i`; a generic 400 is untouched).
`runCalendarImport` recovers **inside the pass**: it retries once with a
`null` sync token — the bounded 24 h import window — and adopts the fresh
checkpoint the tokenless call delivers. In the same transaction it writes
the structured audit `calendar.sync_token_reset`
(`{reason: 'invalid_sync_token', reimported: <n>}`) on the connection.
Nothing else changes: no `consecutive_failures` increment, no pause, no
notification, no `calendar.sync_failed` audit; the upsert/conflict/
deletion logic is unchanged, so the re-import is idempotent and
connection-scoped (no cross-tenant effect, no wrong mirror duplication).
A second failure of the recovery call propagates to the existing generic
failure path (no recursion).

## 3. T4 — 429/403 backoff persisted across cycles (migration `0023`)

- **Migration `0023_rate_limited_until.sql`**:
  `calendar_connections.rate_limited_until TIMESTAMPTZ` (nullable; no
  default).
- **Recording**: every `CalendarRateLimited` catch point (token ops,
  import list, per-task export, delete loop) now calls `recordRateLimit`,
  which sets `rate_limited_until = now + retryAfterSeconds`, guarded by
  `rate_limited_until < until OR IS NULL` — a concurrent 429 can extend
  the window to a later time but **never shrink** a longer stored window.
- **Skipping**: the worker cycle checks the stored window **before**
  building the provider — inside the window a connection gets **zero**
  provider calls (no export, no import, no channel renewal), is counted
  in `result.rateLimited`, and never touches `consecutive_failures` or
  status. At/after expiry the marker is cleared and the pass runs
  normally.
- **Adapter**: `Retry-After` now parses both forms — delta-seconds
  (floored; `"0"` = retry immediately) and HTTP-date (against the
  injectable clock, clamped at 0) — defaulting to 60 s when absent or
  unusable. Previously only `Number(value) || 60` (so `"0"` meant 60 s).
- Rate limits remain **skips, not failures**: no pause, no notification,
  per-connection isolation.

## 4. T6a — the worker logs rate-limited cycles

`calendar.sync` now writes one `warn` line per rate-limited cycle:
`calendar.sync.rate_limited` carrying the cycle result (counts only —
connection ids, no tokens). No logging redesign; `paused`/`failed` lines
unchanged.

## 5. Test evidence (all deterministic, fixture provider — zero network)

**T1 (8 acceptance tests — worker, real sealed envelopes):** refresh
occurs and the new access token is persisted · rotated refresh token
replaces the old one · stored values stay `v1.*` envelopes with no
plaintext · `token_expires_at` advances to the fresh expiry · the next
cycle runs on the new credentials with **zero** refresh calls and a
byte-identical stored envelope (no redundant seal) · an unchanged token
set causes no write at all · a re-seal pauses nothing (status ACTIVE,
`consecutive_failures` 0, no notification) · a failed refresh keeps the
existing pause semantics and performs no partial re-seal.
**T1 (web):** `syncConnectionNow` re-seals a refreshed/rotated set
(re-openable to the new credentials, no plaintext, no pause) and performs
**no token write** when the set is unchanged.

**T5 (3 integration tests):** detection → clear → bounded 24 h
re-import → fresh checkpoint adopted (≠ stale token) → audit written
once with `reimported` count → no pause/failure/audit-failure ·
connection-scoped reset leaves a second tenant's checkpoint and mirrors
untouched · a reset re-import duplicates no mirrors and preserves an
open `CONFLICT` (task not silently moved). Plus 7 adapter/fixture unit
tests (400 → typed error only for the sync-token shape; generic 400
untouched; `invalidateSyncToken` seam).

**T4 (5 integration tests + 4 adapter unit tests):** a 429 stores
`rate_limited_until = now + Retry-After` exactly and is a skip (no
failure, no pause, no notification) · **zero** provider calls inside the
window (provider not even built; marker intact) · at the expiry boundary
the pass runs and the marker is cleared; a second 429 opens a fresh
window · a concurrent 429 never shrinks a longer stored window · two
connections stay isolated (one in backoff, the other syncing in the same
cycle, zero calls to the backoff'd one). Adapter: delta-seconds form
(429 + 403), `"0"` → 0 s, HTTP-date form against the injected clock
(5400 s ahead; past date clamps to 0), absent/unusable header → 60 s.

**T6a (1 job-level test):** the real `calendar.sync` job run emits
`calendar.sync.rate_limited` at `warn` with `rateLimited: 1`, no
`paused`/`failed` lines, and no token material in any emitted line.

**Regression (all green, unchanged):** the four calendar vitest files,
the full 79-file suite, and both calendar E2E specs
(`calendar.spec.ts`, `calendar-sync.spec.ts`) — no existing test was
weakened or deleted.

## 6. Environment limitations and live-Google status

- The sandbox egress was re-probed at the start of this increment: all
  Google endpoints (accounts/oauth2/calendar APIs) remain unreachable, so
  the M7 §7.3 **16-point live verification stays CLOSED-BLOCKED**. No
  live Google behavior was simulated or faked anywhere in this milestone;
  all tests run against the deterministic fixture provider or the
  injected-transport adapter layer.
- The sandbox was partially reset during the milestone (node_modules and
  `/tmp` wiped; working tree and HEAD survived). Recovery: pnpm store
  rehydration (10 s), PostgreSQL 18.4 cluster rebuilt, Chromium 153
  re-inflated from the npm-distributed `@sparticuz/chromium` binary via
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` (the documented fallback; no
  browser security disabled, no API mocks).
- Known behavioral note: `Retry-After: "0"` now means "retry
  immediately" (0 s) instead of the old 60 s default — spec-correct per
  RFC 9110, covered by a new unit test.

## 7. Deferred / explicitly not done (per review §3.3–§3.5, §7)

- **T3 — dedicated channel-token column** (audit L4 deferral honored):
  the webhook channel token remains the connection id until the live
  unblock checklist is met.
- T2 (literal webhook dedupe beyond the channel-token match), T6b
  (webhook bucket fairness), optional export cleanup, multi-calendar,
  RRULE/series editing, Outlook/CalDAV, new calendar UI.
- Class-5 live-Google items: remain CLOSED-BLOCKED, re-probed (still
  blocked) at the start of this increment.

## 8. Verification summary

Targeted calendar suites → full `vitest run` (unit + integration) →
`test:coverage` (thresholds met) → `typecheck` → `lint` → production
`build` → full Playwright E2E → push → GitHub CI. Exact figures are in
`docs/IMPLEMENTATION_LOG.md` (M8-i4 entry) and the milestone closeout
report.
