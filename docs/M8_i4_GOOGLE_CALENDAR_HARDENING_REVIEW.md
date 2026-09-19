# M8-i4 — Google Calendar two-way sync reliability hardening — REVIEW (planning only)

**Status: REVIEW COMPLETE; APPROVED AND IMPLEMENTED** — the implementation
increment (T1 → T5 → T4 → T6a, migration `0023`) is recorded in
`docs/M8_i4_GOOGLE_CALENDAR_HARDENING_MILESTONE.md` and the closeout notes
in §9 below. No product code was changed by this review turn itself.
Design authorities: PRD §16 (§16.1–§16.7), §12.4, §13.5, §11.1, §11.4;
`docs/M8_ROADMAP_AUDIT.md` (O1, O2, X1, L4, M1, N8); M7 milestone docs
(`docs/M7_GOOGLE_CALENDAR_SYNC_MILESTONE.md` §2/§5/§6/§7.2/§7.3,
`docs/CALENDAR_MILESTONE.md`); current implementation surveyed 2026-09-19:
`packages/calendar/src/google.ts`, `packages/db/src/calendar-sync.ts`,
`apps/web/src/server/services/calendar-connections.ts`,
`apps/web/src/app/api/v1/calendar/webhook/route.ts`,
`apps/worker/src/jobs.ts` (`calendar.sync`), `packages/db/src/schema.ts`
(`calendar_connections`), and all four calendar test files.

Per the M8-i4 directive this is a **planning/review turn only**: the output
is a bounded proposal. Nothing is implemented, nothing live is simulated,
and no requirement is invented.

## 1. Exact M8-i4 requirements (PRD/security anchors only)

| Anchor | Requirement |
| --- | --- |
| §16.1 (token rotation row) | "Refresh tokens encrypted; **access tokens refreshed on demand and cached until expiry**" |
| §16.1 (rate-limit row) | "Respect 403/429 backoff, token bucket per connection, batched requests" |
| §16.1 (webhooks row) | "Google push notification channels, **renewed before expiry**" |
| §16.1 (polling row) | "Incremental sync token every 10 minutes when a channel is unhealthy" |
| §12.4 (`calendar.sync` row) | Job contract: idempotency key · max retry 5 · exponential backoff · timeout · DLQ = "pause connection, notify user" · structured error code · alert threshold |
| §16.6 AC-5 | "A revoked or expired token **pauses** the connection and surfaces a reconnect prompt rather than failing silently" |
| §13.5 | Failed jobs retained 30 days; mappings retained 30 days post-disconnect |
| §11.1 | "Webhook signature verification + **dedupe** (billing, calendar channel token)" |
| §11.4 | OAuth tokens envelope-encrypted; never plaintext |
| Audit L4 | Calendar channel token = connection id — "documented accepted limitation; dedicated token column deferred to first unblocked live increment" |
| Audit X1 | Live 16-point verification + M7 hardening candidates (channel-token column, rate-limit backoff) |

Everything else considered in this review is classified below, not
required.

## 2. Current implementation status (reliability posture)

The M7 baseline is strong (audit O1 = satisfied, 5×§16.6 ACs + conflict +
disconnect + tenant isolation CI-verified):

- **OAuth**: code + PKCE (S256, 128-char verifier), `prompt=consent` +
  `access_type=offline`, minimum scopes per mode chosen **before**
  authorization, single-use 10-min hashed state rows, mode stored on the
  state row (a replayed callback cannot change the mode).
- **Token storage**: envelope-encrypted (`calendar_token` purpose), never in
  views/APIs; tampered envelope → provider without tokens → pause +
  reconnect prompt (worker seam).
- **Import**: single transaction — event upserts keyed
  `(connection_id, external_id)`, external-only changes applied through the
  task invariants (title never overwritten), both-side change → `CONFLICT`
  with both values + audit, external deletion → unschedule + notification +
  mirror cleanup (M7-i2 per-occurrence keys), sync checkpoint advanced last.
- **Export**: idempotent via unique `(connection, task)` mapping; per-task
  error isolation (one failing task never blocks the pass, audited
  `calendar.export_failed`); stale mappings → event deletion (404 = no-op);
  404/412 patch → recreate + re-link + stale-mirror removal.
- **Rate limiting**: 403/429/424 → `CalendarRateLimited(Retry-After,
  default 60 s)`; a rate-limited pass is **skipped, not counted** as a
  failure (never pauses).
- **Failure policy**: auth failure → immediate `SUSPENDED` +
  `calendar.connection_paused` audit + one reconnect notification
  (§16.6 AC-5); generic failure → `consecutive_failures` counter, pause +
  notify at 5 (§12.4), reset on success; worker logs `paused`/`failed`
  cycles.
- **Channel renewal**: `renewCalendarChannel` with a 24 h margin (channel
  lifetime 7 d − 1 h), best-effort (failure defers to the 10-min poll, which
  runs unconditionally — a safe superset of "poll when unhealthy").
- **Disconnect**: best-effort revoke (failure must not block), tokens +
  sync token + channel wiped, `DISCONNECTED`, sync stops immediately
  (cycle processes ACTIVE only), mappings + mirrors purged after 30 days by
  the retention sweep; imported tasks and exported events preserved.
- **Webhook**: public endpoint, bearer channel token (= connection id,
  128-bit UUID) echoed by Google; unknown/inactive tokens → 200 + no-op
  (stale channels cannot error-loop); 300/min in-process limit keyed by IP.
- **Deterministic test base**: 31 adapter unit tests (exact request shapes,
  status mapping, rotation, paging, per-occurrence keys) + engine/worker
  integration suites on real PostgreSQL with a fixture provider (zero
  network) + 2 E2E specs (honest unconfigured-deployment path).

**Gaps found in this review:** three genuine reliability gaps (one
PRD-anchored, two production), one minor observability gap, and the
standing live-verification blocker. Details in §3.

## 3. Genuine remaining gaps (classified)

### 3.1 Class 1 — explicitly required by PRD

**T1 — Refreshed/rotated tokens are never persisted (token-rotation
robustness). CONFIRMED DEFECT in the current implementation.**

Evidence:
- `calendar-sync.ts` defines `CalendarSyncOutcome.tokens` — documented
  "Refreshed tokens the caller must re-seal (PRD §16.1 rotation)" — and
  both passes set it (`outcome.tokens = tokensIfRefreshed(ctx)`).
- `runCalendarSyncCycle` returns `CalendarCycleResult`
  (connections/imported/exported/paused/rateLimited/failed/retention) —
  **no token propagation**; grep confirms `outcome.tokens` is consumed
  nowhere (only the OAuth callback consumes its own exchange result).
- Worker `calendar.sync` (jobs.ts) and web `syncConnectionNow` never update
  `calendar_connections` token fields after a cycle.

Consequences (deterministic, from code inspection):
1. The stored access token / `token_expires_at` freeze at the OAuth
   callback values. Each cycle rebuilds the provider from the row, so
   in-memory refreshes are lost at the cycle boundary → a redundant token
   endpoint call per connection per stored-expiry period, forever.
2. If Google re-issues the refresh token (Workspace rotation policy, or any
   re-issue), the stored **old** refresh token fails on the next refresh →
   `CalendarAuthError` → connection paused `TOKEN_REVOKED` → forced
   re-authentication of a perfectly healthy account. This is a
   live-verification-exposed failure class, but its mechanism is fully
   provable offline.
3. PRD §16.1 "access tokens … cached until expiry" is not honored for the
   persisted cache.

Verifiable **without live Google**: yes — fixture provider that rotates on
refresh + transport call counters (the adapter test "refreshes an expired
token before use and rotates the refresh token" already proves the rotation
shape; the persistence seam is the missing half).

### 3.2 Class 2 — security hardening required by the existing model

**No new gaps found.** Reviewed: webhook authenticity (bearer 128-bit UUID,
connection-scoped lookup, unknown/inactive → inert 200 — stale channels are
harmless, including post-disconnect), OAuth state replay (single-use, TTL,
hashed, mode-bound), token encryption at rest, PKCE, minimum scopes, and
tenant isolation under failure/retry (every query is scoped through the
connection's `(user, workspace)` pair; pause/audit/notification paths use
the row's owner; webhook import can only affect the connection named by the
token). The existing model holds under the failure paths examined.

The only candidate (dedicated channel-verification-token column, T3 below)
is operational, not security-required: the current token is
cryptographically indistinguishable from a dedicated random token, and no
cross-tenant or stale-channel defect is demonstrable.

### 3.3 Class 3 — useful production hardening, not PRD-required

**T4 — 429/403 backoff scheduling (M7 §6/§7.3 + audit X1 candidate).**
Today a rate-limited pass is skipped and the **next** cycle (60 s for
export, 10 min for import) retries immediately, ignoring `Retry-After`
across cycles. With `Retry-After` longer than the cycle interval, every
cycle wastes a guaranteed-429 request (burning Google quota and potentially
extending the limit), and the rate-limited state is invisible — the worker
logs `paused`/`failed` but **not** `rateLimited` (jobs.ts only logs
`paused`/`failed`/`retention`). Fix: a `rate_limited_until` timestamp
(small migration, `0023`), set to `now + Retry-After` on
`CalendarRateLimited`; cycles skip provider calls while inside the window;
log `calendar.sync.rate_limited`. PRD §16.1 "respect 403/429 backoff" is
met within-cycle today; scheduling strengthens it. Deterministically
testable (inject clock; assert zero transport calls inside the window,
retry after).

**T5 — Sync-token invalidation recovery.** Google sync tokens are
invalidated (change-count lifetime, channel churn); an invalidated
`syncToken` makes `listChanges` fail with HTTP 400. Current behavior: the
400 surfaces as a generic error → `consecutive_failures` → **pause + forced
reconnect after 5 cycles** even though the tokens are healthy. Recovery:
recognize the invalid-sync-token response, clear `syncToken`, re-run the
pass on the 24 h `timeMin` window in the same cycle, audit
`calendar.sync_token_reset`. Deterministically testable (fixture: 400 with
the token, success without). Related limitation (accepted, documented):
without any sync token the import window is 24 h, so a tokenless reconnect
after >24 h downtime can miss older external changes — worth a sentence in
the milestone doc, no code change proposed.

**T6a — Worker observability for rate-limited cycles** (2 lines: log the
existing `result.rateLimited` field). Cheap; include with T4.

**T2 — Webhook redelivery dedupe (`X-Goog-Message-Id`).** PRD §11.1 names
webhook dedupe; audit L4 closed the calendar entry on channel-token
scoping. Google redelivers on failure; today each redelivery runs a full
import — correctness-safe (idempotent upserts, version-guarded task
writes) but wasteful, and it duplicates `calendar.item_updated` audit rows.
Fix: remember recent `(connection_id, message_id)` with a 24 h TTL and
skip repeats. Deterministically testable. **Optional** — recommend
excluding from the bounded scope (no correctness defect; the import is
already idempotent) unless the team prioritizes §11.1 literalism.

**T3 — Dedicated random push-channel-verification-token column.** Audit L4
explicitly deferred this to "the first unblocked live increment."
Benefit: per-channel rotation/revocation and decoupling the webhook
credential from the connection id. No security defect demonstrated (§3.2).
**Excluded** from the bounded scope per the directive ("do not implement
optional hardening merely because it seems convenient"); remains a
documented candidate.

**T6b — Webhook rate-limit fairness.** The 300/min in-process bucket is
keyed by client IP; Google egresses from a small IP set, so one
connection's burst can 429 other connections' webhooks — and repeated 4xx
on a push channel can make Google retire it. A per-token (or higher) limit
is the fix. **Deferred** — single-worker deployment model today, no
observed incident, and the 10-min poll bounds any loss.

### 3.4 Class 4 — future enhancement / Phase 2

- **T7 — Opt-in export-event cleanup on explicit user request.** PRD
  §16.5 forbids auto-deletion ("Exported calendar events are not
  automatically deleted by default") but does not require an explicit
  option. M7 §6 listed it as cheap hardening; it is a feature, not
  reliability — Phase 2.
- **Orphaned-export reconciliation** (event created at Google, mapping
  commit fails → next pass creates a second event). Rare; would require
  deterministic event markers (payload change) — not worth MVP churn.
- **Per-connection proactive token bucket** (§16.1 wording) — reactive
  429 handling exists and is CI-verified; proactive client-side buckets add
  no observable protection at MVP scale.
- **Multi-calendar selection** (§16.1 lists "calendar selection"; M7
  imports the primary calendar only — audit O1 closed this as the MVP
  decision).
- Outlook / CalDAV (PRD §16.7 Phase 2) — out of scope by directive.
- RRULE / series editing — **excluded by directive**.

### 3.5 Class 5 — externally blocked pending live Google verification

**Re-probed this turn (2026-09-19 review):** all three Google hosts
(`accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`)
still blocked (connection failure, same as the M7-i3 preflight);
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` still absent. Therefore:

- **T8 — the 16-point live verification pass** (real OAuth consent, token
  exchange + rotation over time, mode/scopes, recurring-series import with
  M7-i2 per-occurrence identity, occurrence update/cancel, series cancel,
  deleted-event mirror cleanup, two-way export, real push delivery,
  polling fallback, reconnect after auth failure, real rate-limit handling,
  disconnect/revoke cleanup, live tenant isolation) — **BLOCKED**.
- **T9 — real revocation semantics** (does revoking the access token
  invalidate the refresh token on live Google?) — BLOCKED (code revokes the
  access token best-effort; either way tokens are wiped locally).
- **T10 — real push-channel lifecycle** (X-Goog-* header presence,
  redelivery behavior, channel retirement thresholds) — BLOCKED.
- **T11 — live refresh-rotation policy** (consumer vs Workspace) — BLOCKED
  (T1's fix is correct for both cases regardless).

Unblock checklist (unchanged from M7 §7.3): OAuth client + redirect
allow-list + env vars + egress to the three hosts + a long-lived public
host for `/api/v1/calendar/webhook`. T1/T4/T5 make this pass
substantively better: rotation, recovery and backoff would then be
observable on live traffic instead of only provable offline.

## 4. Bounded M8-i4 implementation scope (proposal)

**In scope (deterministic, no live Google required, one small migration):**

1. **T1** — persist refreshed/rotated tokens: the cycle (worker path) and
   `syncConnectionNow` (web path) re-seal `outcome.tokens` back onto the
   connection row (envelope-encrypted, same `calendar_token` purpose)
   whenever a refresh occurred.
2. **T5** — sync-token invalidation recovery: recognize, clear, re-import
   on the 24 h window, audit `calendar.sync_token_reset`.
3. **T4** — backoff scheduling: `0023` migration adding
   `calendar_connections.rate_limited_until`; engine sets it on
   `CalendarRateLimited`; cycle skips provider calls inside the window;
   backoff never counts as a failure.
4. **T6a** — worker logs `calendar.sync.rate_limited`.

**Out of scope this increment:** T2 (optional dedupe), T3 (channel-token
column — audit deferral honored), T6b (webhook bucket fairness), all class
4, and everything class 5 (remains CLOSED-BLOCKED, re-verified each
increment until unblocked).

**Constraints honored:** no new endpoints, no API shape changes
(`CalendarSyncOutcome.tokens` semantics stay; only consumers added), no
product-behavior changes beyond the four items, no weakening/deleting
existing tests, no simulated Google.

## 5. Acceptance criteria (proposed, all deterministic)

1. **T1:** a cycle in which the provider refreshes (and rotates) the token
   leaves the re-sealed access token, new `token_expires_at` (and rotated
   refresh token) on the row; the next cycle serves from cache with **zero**
   token-endpoint calls until the new expiry approaches (transport counter);
   a rotated refresh token does **not** trigger a pause; `syncConnectionNow`
   re-seals as well. Tokens remain encrypted at rest (existing sealing
   tests still pass).
2. **T5:** a 400 invalid-sync-token response clears the stored sync token,
   re-imports the 24 h window in the same cycle, advances to the fresh sync
   token, records `calendar.sync_token_reset`, counts no failure and pauses
   nothing; the following cycle resumes incrementally.
3. **T4:** a 429 with `Retry-After: N` sets `rate_limited_until = now + N`;
   cycles inside the window make **zero** provider calls for that
   connection (export and import); after the window the pass runs again;
   rate-limited windows never increment `consecutive_failures` and never
   pause; the worker log shows the rate-limited cycle.
4. **Regression:** all four existing calendar test files + both calendar
   E2E specs green unchanged; the full `test:coverage` suite green;
   `calendar.sync` job registry unchanged (name/cadence/contract per
   §12.4); no other route's behavior changes.

## 6. Proposed implementation order

1. T1 (persistence seam + regression test first — it is the only class-1
   item and the others share the cycle code path);
2. T5 (recovery in `runCalendarImport` + cycle);
3. T4 (migration `0023` → engine → cycle skip → worker log = T6a);
4. Full validation battery (targeted → full vitest/coverage → typecheck →
   lint → build → E2E → push → CI), then milestone doc + log entry.

One bounded increment; STOP after M8-i4 with the 8-style final report.

## 7. Explicit non-goals

- No live Google calls, no simulated/faked Google API or webhook
  verification, no credentials work.
- No RRULE/series editing; no Outlook/CalDAV; no multi-calendar selection.
- No channel-token column, no webhook dedupe, no webhook bucket changes, no
  opt-in export cleanup (documented candidates/Phase 2 — §3.3/§3.4).
- No changes to score/tracking/export/billing or any non-calendar surface.
- No weakening or deleting of existing tests; no new workers; no new
  endpoints; no API response-shape changes.

## 8. Recommended next action

On approval, implement M8-i4 exactly per §4/§5/§6 (T1 → T5 → T4 → T6a).
Keep the class-5 items CLOSED-BLOCKED and re-probe egress/credentials at
the start of that increment (if the environment changes, the 16-point live
pass supersedes the offline items' ordering). If the team wants §11.1
literal dedupe (T2), it slots in after T4 as a fifth bounded item; T3
stays deferred until the unblock checklist is met.
## 9. Implementation closeout (as-built, M8-i4)

Implemented exactly per §4/§5/§6 (T1 → T5 → T4 → T6a). Full as-built detail
lives in `docs/M8_i4_GOOGLE_CALENDAR_HARDENING_MILESTONE.md`. What actually
shipped, and where it differs from the proposal:

**Migration `0023_rate_limited_until.sql`** — `calendar_connections
.rate_limited_until TIMESTAMPTZ` (nullable, no default); schema column
inserted between `channel_expires_at` and `consecutive_failures`.

**T1 (token re-seal)** — shipped via an engine seam rather than by having
the engine open envelopes: `runCalendarSyncCycle` takes `tokensFor(row)`
and `sealTokens(row, tokens)`; the engine compares `provider.currentTokens()`
to the opened baseline with the exported `tokensChanged(...)` and calls
`sealTokens` only on a real change. `CalendarCycleResult` gained
`tokenUpdates`. The worker supplies `openCalendarTokens` (null on missing
secret / no token / tampered envelope — preserving the existing pause
fall-through) and `sealCalendarTokens` (re-seals both tokens + expiry via
`sealSecret`, keeps `scopes` via column self-reference). The web
`syncConnectionNow` re-seals the same way through `encryptSecret`, using a
new single decrypt source `calendarProviderTokens`. One deliberate
strengthening beyond the proposal: `tokensChanged` also compares
**`scopes`** (a scope change is a credential change and must persist).

**T5 (invalid sync-token recovery)** — adapter maps 400 + body matching
`/sync_?token/i` to the new `CalendarSyncTokenInvalid` (generic 400
untouched). `runCalendarImport` retries once with a `null` sync token on
the bounded 24 h window, adopts the fresh checkpoint, and writes the
`calendar.sync_token_reset` audit in the same transaction. No
`consecutive_failures` increment, no pause, no `calendar.sync_failed`
audit; idempotent and connection-scoped. A failing recovery call
propagates to the existing generic-failure path (no recursion).

**T4 (rate-limit backoff)** — `recordRateLimit` runs at all four
`CalendarRateLimited` catch points and sets
`rate_limited_until = now + retryAfterSeconds`, guarded so a concurrent
429 extends but never shrinks a longer stored window. The cycle checks the
window **before** building the provider (zero provider calls — no export,
import, or channel renewal — inside the window) and clears the marker at/
after expiry. Adapter `parseRetryAfter` now handles delta-seconds (floored;
`"0"` → 0 s) and HTTP-date (against the injectable clock, clamped ≥ 0),
defaulting to 60 s. Known behavior change: `Retry-After: "0"` is now 0 s,
not the old 60 s (spec-correct, unit-tested).

**T6a (worker log)** — `calendar.sync` emits one `warn`
`calendar.sync.rate_limited` line per rate-limited cycle carrying the
result counts (no tokens). No logging redesign.

**Differences from the proposal (all within scope):** (a) T1 persistence is
delegated to caller-supplied `tokensFor`/`sealTokens` instead of the engine
touching envelopes — keeps plaintext out of `@nextdoo/db`; (b) the cycle
skip is placed before `providerFor` so the provider is never even
constructed inside a window; (c) `tokensChanged` includes `scopes`;
(d) `Retry-After: "0"` → 0 s. No API shape changed; `calendar.sync`
registry (name/cadence/§12.4 contract) unchanged; no new endpoints/workers.

**Test evidence:** T1 ×10 (worker 8 + web 2), T5 ×3 integration + adapter/
fixture seam unit tests, T4 ×5 integration + 4 adapter unit tests (both
Retry-After forms, `"0"`, HTTP-date, default), T6a ×1 job-level test — all
deterministic on the fixture provider (zero network). Full regression: the
four calendar vitest files, the 79-file suite, and both calendar E2E specs
green unchanged; no existing test weakened or deleted.

**Environment / live-Google:** egress re-probed at increment start — all
Google endpoints still unreachable, so the M7 §7.3 16-point live
verification **stays CLOSED-BLOCKED**; nothing live was simulated. The
sandbox was partially reset mid-milestone (node_modules + `/tmp`);
recovered via pnpm store rehydration, a rebuilt PostgreSQL 18.4 cluster,
and a re-inflated Chromium 153 via the documented
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` fallback (no security disabled, no
API mocks).

**Deferred (unchanged):** T3 channel-token column (audit L4), T2 literal
webhook dedupe, T6b webhook bucket fairness, optional export cleanup,
multi-calendar, RRULE/series editing, Outlook/CalDAV, new calendar UI; all
class-5 live-Google items remain CLOSED-BLOCKED.
