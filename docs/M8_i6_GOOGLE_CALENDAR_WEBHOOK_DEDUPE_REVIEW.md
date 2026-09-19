# M8-i6 — Google Calendar webhook redelivery dedupe — REVIEW (planning only)

**Status: REVIEW COMPLETE — bounded implementation proposal, not started.**
Per the M8-i6 directive this is a **planning/review turn only**: the output
is the remaining class-3 hardening matrix and a bounded M8-i6 proposal.
No product code was changed by this review turn, no live Google flow was
attempted, and no requirement was invented.

Method (2026-09-20, branch `arena/01a085b7-nextdoo`, tip `bc4fd90`):
full re-read of `docs/PRD.md` (all 22 sections); `docs/M8_ROADMAP_AUDIT.md`;
`docs/M8_i4_GOOGLE_CALENDAR_HARDENING_REVIEW.md` +
`docs/M8_i4_GOOGLE_CALENDAR_HARDENING_MILESTONE.md`;
`docs/M8_i5_GOOGLE_CALENDAR_LIVE_UNBLOCK_PREFLIGHT.md`; M8-i1…i3
milestone documents (closed-scope check); and a code survey of the current
webhook path, rate-limit middleware, sync engine, disconnect/retention
sweep, fixture provider seams, and all four calendar test suites. M8-i4 is
fully CLOSED (`5b3c4e9` + `90e6992`) and M8-i5 is CLOSED-BLOCKED at
preflight (`bc4fd90`) — neither is modified or reopened here.

**Classification legend (per directive)**

1. PRD-required
2. security-required
3. reliability/operational hardening
4. optional convenience
5. externally blocked

---

## 1. Requirements context (PRD anchors only)

| Anchor | Requirement (verbatim essence) |
| --- | --- |
| §11.1 threat model, Webhooks row | Threat: "Forged or replayed events". Control: "**Signature verification, timestamp window, event-ID dedupe**" |
| §18.3 Billing rules | "Webhook events are **idempotently processed (deduplicated on provider `event.id`)**" — the codebase's established dedupe pattern |
| §16.1 Webhooks row | "Google push notification channels, **renewed before expiry**" |
| §16.1 Rate-limit row | "Respect 403/429 backoff, token bucket per connection, batched requests" |
| §12.4 `calendar.sync` row | Job contract: idempotency · retry · backoff · timeout · DLQ = pause + notify · structured error code |
| §12.1 SLO | "Calendar sync freshness — 99% within 10 min" (the polling floor that bounds any webhook-skip edge case) |
| §14.8 | "Rate-limit responses use HTTP 429 and include a `Retry-After` header"; "Calendar synchronization — Provider and plan-specific" |
| Audit L4 | Webhook signature verification + dedupe — status 1 (closed on channel-token scoping; "calendar channel token is the connection id — documented accepted limitation; dedicated token column deferred to first unblocked live increment") |
| Audit X1 | Live Google verification + hardening candidates — blocked (re-measured at M8-i5 preflight) |
| M8-i4 review §3.2 | Security review of the webhook path: no security defect demonstrable in the current model (128-bit UUID bearer, connection-scoped lookup, unknown/inactive → inert 200) |
| M8-i4 review §3.3 | The remaining calendar class-3 candidates: **T2** (webhook dedupe — "Optional — recommend excluding from the bounded scope (no correctness defect; the import is already idempotent) unless the team prioritizes §11.1 literalism"), **T3** (channel-token column — excluded, audit L4 deferral), **T6b** (webhook bucket fairness — "Deferred — single-worker deployment model today, no observed incident, and the 10-min poll bounds any loss") |
| M8-i4 review §3.4 | Class 4: **T7** (opt-in export cleanup — "a feature, not reliability — Phase 2"), orphaned-export reconciliation ("Rare; would require deterministic event markers (payload change) — not worth MVP churn"), per-connection proactive token bucket ("add[s] no observable protection at MVP scale"), multi-calendar (MVP decision closed) |
| M8-i5 preflight | Live-unblock path **BLOCKED** (no credentials, no `APP_URL`/public HTTPS host, no egress to the three Google hosts, no inbound webhook host). Directive: do not retry live verification in the current sandbox; T3 only with live evidence or explicit PRD/security requirement |

---

## 2. Complete remaining class-3 candidate matrix (calendar)

Each row: classification · exact anchor · current implementation status ·
concrete defect/risk · external provider needed · deterministic acceptance
criteria · expected schema/API/code impact · existing test coverage ·
overlap with closed milestones.

### C1 — T2: Webhook redelivery dedupe (`X-Goog-Message-Id`) — **RECOMMENDED**

- **Classification: 3 (reliability/operational hardening)** — with the
  strongest requirement anchor of any remaining class-3 item: §11.1 names
  "event-ID dedupe" as the webhook control for "replayed events". It is
  **not** classified PRD-required or security-required because the closed
  M8-i4 review §3.2 found no security defect in the current webhook model
  and §3.3 closed the audit L4 calendar entry on channel-token scoping,
  leaving T2 as "optional … unless the team prioritizes §11.1
  literalism". This review is that prioritization decision, and it
  selects T2.
- **Anchor:** §11.1 Webhooks row; §18.3 (billing dedupe precedent);
  M8-i4 review §3.3 (T2); audit L4.
- **Current status: NOT IMPLEMENTED.** `handleCalendarWebhook`
  (`apps/web/src/server/services/calendar-connections.ts:583`) runs a full
  `runCalendarImport` on **every** delivery; the webhook route's zod body
  schema (`…/calendar/webhook/route.ts`) parses only
  `channel.token`/`resource`/`eventId` — the `X-Goog-Message-Id` header is
  not read anywhere in the codebase; no table or state records received
  message ids.
- **Defect/risk (concrete, no live Google needed to demonstrate the
  mechanism):** Google redelivers a notification when its response is
  lost or the client fails. Each redelivery today executes a complete
  24-hour-window `listChanges` pass: wasted Google API quota (worst during
  Google's own delivery retries or an outage, when redeliveries cluster),
  duplicate `calendar.item_updated`/`calendar.item_imported` audit rows,
  and duplicate notification insert attempts (mitigated today only by
  `onConflictDoNothing`). Additionally the endpoint has **no replay
  resistance**: a captured notification (token + body) replays as a full
  import pass for its entire lifetime — the exact §11.1 threat row
  ("replayed events") with only the 128-bit bearer token as the
  control. Correctness is safe today (the import is idempotent); the
  defect is waste + audit noise + missing replay control, not data
  loss.
- **External provider/environment: NO.** The header is plain HTTP; the
  state is a local table; the fixture provider's `calls` log
  (`packages/calendar/src/fixture.ts`) counts `list` operations
  deterministically (zero network).
- **Deterministic acceptance criteria:** see §6 (10 numbered criteria).
- **Expected schema/API/code impact:** one new migration
  `0024_calendar_webhook_messages.sql` (table
  `calendar_webhook_messages(connection_id uuid PK-part REFERENCES
  calendar_connections(id) ON DELETE CASCADE, message_id text PK-part,
  received_at timestamptz default now())` + `received_at` index for the
  sweep); one schema table in `packages/db/src/schema.ts`; the webhook
  route reads the optional `X-Goog-Message-Id` header (non-empty string,
  length-capped) and passes it to the service; `handleCalendarWebhook`
  gains an optional `messageId` parameter and the dedupe check (no dedupe
  row for unknown/inactive tokens or an unconfigured provider);
  `sweepCalendarRetention` purges rows older than 24 h (injected clock)
  with an additive result field. **No new endpoints, no API
  response-shape change** (the response stays `200 {ok, imported}`;
  `imported` is 0 on a dedupe hit), no worker job-registry change.
- **Existing test coverage:** the webhook path is covered by
  "manual sync + events listing + webhook (tenant-scoped)" in
  `apps/web/src/server/services/calendar-sync.integration.test.ts`
  (webhook triggers import; per-tenant scoping; unknown token inert) and
  by the E2E specs' unconfigured-deployment path. **No dedupe coverage
  exists** (nothing to weaken or extend destructively).
- **Overlap with closed milestones: NONE.** M8-i4 explicitly excluded T2
  from its bounded scope ("Out of scope this increment: T2"); M7's
  webhook semantics (first delivery → immediate import; unknown token →
  inert 200) are preserved byte-for-byte. This is the continuation of the
  calendar hardening series, not a reopening.

### C2 — T6b: Webhook rate-limit fairness (per-token bucket) — DEFERRED

- **Classification: 3 (reliability/operational) — deferred.**
- **Anchor:** none in the PRD for the *inbound* webhook (the §14.8
  "Calendar synchronization — Provider and plan-specific" row governs the
  sync API, not Google's push endpoint); M8-i4 review §3.3 (T6b).
- **Current status:** `publicRoute` keys the 300/min in-process bucket by
  client IP (`apps/web/src/server/http.ts:152`,
  `${routeName}:${ip}`); the webhook route uses `rateLimitPerMinute: 300`.
- **Defect/risk (hypothetical, no incident):** Google egresses from a
  small IP set, so one connection's burst could 429 other connections'
  webhooks sharing an IP; repeated 4xx on a push channel can make Google
  retire it. Not observed; the 10-minute poll bounds any resulting loss.
- **External provider/environment:** no (implementable offline) — but
  there is **no evidence base** for it.
- **Why deferred:** the closed M8-i4 review made the deferral decision
  ("single-worker deployment model today, no observed incident, and the
  10-min poll bounds any loss") and the standing rule bars optional
  hardening without PRD/security evidence. Revisit only if the live pass
  (C8) observes channel retirement or cross-connection 429s. Changing the
  rate-limit key on a public route also carries its own security
  considerations that should be evaluated against live behavior, not
  hypothesized.
- **Existing coverage:** generic rate-limit middleware behavior (429 +
  `Retry-After`) is tested at the middleware level; no calendar-webhook
  fairness test exists or is needed while deferred.
- **Overlap:** none (deferral honored, not reopened).

### C3 — T3: Dedicated random push-channel-verification-token column — DEFERRED (directive + audit L4)

- **Classification: 3 (reliability/operational) — deferred.**
- **Anchor:** audit L4 ("documented accepted limitation; dedicated token
  column deferred to first unblocked live increment"); M8-i4 review §3.3;
  M8-i5 preflight §3 (decision rule).
- **Current status:** the channel token is the connection id (UUID).
  M8-i4 review §3.2: "cryptographically indistinguishable from a dedicated
  random token, and no cross-tenant or stale-channel defect is
  demonstrable."
- **Defect/risk:** per-channel rotation/revocation and decoupling the
  webhook credential from the connection id would be operationally nicer;
  **no defect is demonstrated.**
- **External provider/environment:** NO to implement, but **live evidence
  is required to justify** — and the directive is explicit: "Do not
  implement T3 channel-token hardening without live evidence or an
  explicit PRD/security requirement." Neither exists.
- **Status:** remains deferred, exactly as M8-i4 closed it and M8-i5
  re-affirmed. If implemented someday it would be a migration
  (`calendar_connections.channel_token`), channel creation/echo change,
  and webhook validation change — all out of M8-i6 scope.
- **Existing coverage:** webhook token scoping (unknown/inactive → inert)
  is tested in the web integration suite.
- **Overlap:** none.

### C4 — T7: Opt-in export-event cleanup — DEFERRED (Phase 2 / feature)

- **Classification: 4 (optional convenience — a feature, not hardening).**
- **Anchor:** PRD §16.5: "Exported calendar events are **not
  automatically deleted by default**" — the PRD forbids auto-deletion and
  does not require an opt-in option; M8-i4 review §3.4: "it is a feature,
  not reliability — Phase 2."
- **Current status:** the §16.5 default is honored (disconnect leaves
  exported events in place; `finalizeDisconnect` never deletes events).
- **Defect/risk:** none — satisfying the PRD row requires no code.
- **External provider/environment:** yes, in practice (deleting real
  events needs provider egress to verify); deterministic tests possible
  via the fixture, but the surface is a new endpoint + UI.
- **Why deferred:** it is new product surface (explicit directive
  non-goal: "does not add speculative product functionality"), not
  hardening of existing behavior.
- **Existing coverage:** disconnect + 30-day retention sweep is covered
  by the web/worker integration suites and the M7 disconnect E2E.
- **Overlap:** none.

### C5 — Orphaned-export reconciliation — DEFERRED

- **Classification: 3 (reliability) — deferred (closed trade-off).**
- **Anchor:** M8-i4 review §3.4 (class 4): "event created at Google,
  mapping commit fails → next pass creates a second event. Rare; would
  require deterministic event markers (payload change) — not worth MVP
  churn."
- **Current status:** in `runCalendarExport`, if `writeEvent` succeeds
  but the mapping-insert transaction fails, the next pass re-creates the
  event; the first becomes an orphan on the NEXTDOO calendar. Per-task
  failure isolation (`calendar.export_failed` audit) covers the visible
  error; the orphan is not reconciled.
- **Defect/risk:** rare (requires a DB failure in the narrow window
  between a successful provider write and the mapping commit); user sees
  a duplicate event in Google; NEXTDOO state stays correct.
- **External provider/environment:** the *fix* requires a deterministic
  event marker in the provider payload (Google-specific adapter change) —
  i.e., provider-specific behavior change that the directive bars without
  justification.
- **Why deferred:** the closed M8-i4 review made this trade-off
  explicitly; reopening it without new evidence (e.g., an observed orphan
  incident) would violate "do not reopen closed work".
- **Existing coverage:** export failure isolation and idempotent re-run
  (no duplicate while the mapping exists) are integration-tested.
- **Overlap:** none.

### C6 — Per-connection proactive token bucket / batched requests — DEFERRED

- **Classification: 3 (reliability) — deferred (one §16.1 element already
  delivered; the rest adds no observable protection at MVP scale).**
- **Anchor:** PRD §16.1 rate-limit row: "Respect 403/429 backoff, token
  bucket per connection, batched requests."
- **Current status:** the "Respect 403/429 backoff" element is delivered
  and CI-verified (M8-i4 T4: per-connection `rate_limited_until` window,
  zero provider calls inside it, `Retry-After` both forms); there is no
  proactive client-side bucket and no request batching (≤ 500
  tasks/pass, one request per task).
- **Defect/risk:** none demonstrated — reactive handling plus the
  per-connection persisted window already prevents the failure class
  (cyclical guaranteed-429 quota burn) T4 was created for.
- **External provider/environment:** no to implement; but a proactive
  bucket would be tuned against *live* quota shapes (the 16-point pass,
  C8, point 14 is where real `Retry-After` behavior is observed).
- **Why deferred:** M8-i4 review §3.4 closed it: "proactive
  client-side buckets add no observable protection at MVP scale."
  Revisit only with live-traffic evidence.
- **Existing coverage:** M8-i4 T4 battery (5 integration + 4 adapter unit
  tests) covers the delivered element.
- **Overlap:** none (the delivered element is untouched).

### C7 — Webhook channel-state handling (`X-Goog-Channel-State`) — DEFERRED (safe superset today)

- **Classification: 3 (reliability) — deferred (no demonstrated defect).**
- **Anchor:** Google-documented push behavior (channel state
  `PROVISIONED`/`DELIVERING`/`STOPPED`/`EXPIRED` in the notification
  header); not a PRD-named control. Reviewed in this increment because it
  is the only webhook-behavior gap not previously on a closed candidate
  list.
- **Current status:** the route ignores the header; every state —
  including `STOPPED`/`EXPIRED` — triggers the same idempotent import.
- **Defect/risk:** none: importing on a final `STOPPED` notification is a
  **safe superset** (idempotent upserts; the 10-minute poll — a PRD SLO,
  §12.1 — bounds any staleness; the worker renews channels before
  expiry). Skipping work on `STOPPED` would save one import pass, nothing
  more.
- **External provider/environment:** implementing is offline; but the
  correct policy (what to do on `EXPIRED`) is exactly what live pass
  point 12/13 would observe.
- **Why deferred:** no defect to fix; the change is behavior with no
  measurable benefit today. Revisit during/after the live pass.
- **Existing coverage:** state-agnostic webhook delivery is implicitly
  covered by the existing webhook tests.
- **Overlap:** none.

### C8 — T8–T11: the 16-point live pass, live revocation semantics, live push-channel lifecycle, live rotation policy — EXTERNALLY BLOCKED

- **Classification: 5 (externally blocked).**
- **Anchor:** M7-i3 §7.3; audit X1; M8-i5 preflight §2 (the exact 16-point
  checklist) and §4 (unblock requirements).
- **Current status:** CLOSED-BLOCKED at preflight (`bc4fd90`, measured
  2026-09-19): no `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`; no
  `APP_URL`/public HTTPS redirect host; egress to
  `accounts.google.com` / `oauth2.googleapis.com` /
  `www.googleapis.com` blocked (all `000`); no inbound public reachability
  for `POST /api/v1/calendar/webhook`.
- **Defect/risk:** not applicable — verification work, not code.
- **External provider/environment:** YES — all four unblock
  requirements (M8-i5 preflight §4).
- **Status per directive:** "Do not retry live Google verification in the
  current sandbox." Remains CLOSED-BLOCKED; the next increment re-runs the
  six-check preflight. If unblocked, the 16-point pass runs first and
  feeds the T3 (C3), T6b (C2), C6, and C7 decisions with live evidence.
- **Existing coverage:** the fixture-based suites (38 adapter unit tests;
  worker 20 + web 24 + connections 8 integration; 2 E2E specs) cover
  everything observable offline; live points remain unobserved by
  design/honesty.
- **Overlap:** none.

---

## 3. Candidates that should be deferred

| # | Candidate | Class | Deferral basis |
| --- | --- | --- | --- |
| C2 | Webhook bucket fairness (T6b) | 3 | Closed M8-i4 deferral; no PRD anchor for the inbound webhook; no observed incident; 10-min poll bounds loss; live evidence would govern it |
| C3 | Channel-token column (T3) | 3 | M8-i6 directive (no live evidence, no explicit PRD/security requirement) + audit L4 deferral to the unblocked live increment |
| C4 | Opt-in export cleanup (T7) | 4 | Feature, not hardening (M8-i4 §3.4, Phase 2); would add new product surface — directive non-goal |
| C5 | Orphaned-export reconciliation | 3 | Rare defect; the fix requires a provider payload change; closed M8-i4 trade-off |
| C6 | Proactive token bucket / batching | 3 | M8-i4 §3.4: no observable protection at MVP scale; the reactive backoff element is already delivered (T4) |
| C7 | Channel-state handling | 3 | Current behavior is a safe superset; no demonstrated defect; live pass would inform the policy |

**Non-calendar items reviewed and set aside as not class-3 calendar
hardening** (no action proposed this increment; listed so the matrix is
complete and nothing is silently dropped):

| Item | Anchor | Class | Note |
| --- | --- | --- | --- |
| SAST / dependency / secret scanning in CI + ASVS L2 mapping doc | §11.8 (SD-02) | 1 (PRD-required assurance) | The largest remaining PRD-required assurance gap; it is CI/assurance scope, not class-3 reliability hardening — a separate increment if selected |
| CI-based database restore test | §19.2 #14, §12.3 | 1/5 (GA gate) | Implementable in CI with embedded PG (audit §4.3 noted this); operational gate, not class 3 |
| k6 load tests / Lighthouse CI | §19.4, §12.1 | 4/5 (ops) | Needs staging load infrastructure |
| `PATCH /v1/reminders/:id` (N2) | §14.3 | 4 (minor product gap) | Foldable into a nearby product increment |
| `GET/POST /v1/workspaces` (N5) | §14.3, §6.2 | 4 (minor) | Single-workspace MVP; POST is a Phase-2 concept |
| Optional break intervals (G3) | §6.7 | 4 (minor optional) | Never built; optional |
| Live email (F2/X3), live billing (Q3/X2), production reliability gates (X4) | audit | 5 | Externally blocked (SMTP / provider keys / production infra) |
| Desktop (Z1), all Phase-2 items | PRD §4.2/§4.3, standing directive | 5/deferred | Unchanged |

---

## 4. Candidates that are externally blocked

**Only C8 (T8–T11)** — the entire live-Google verification surface.
Blockers (re-measured 2026-09-19 at the M8-i5 preflight, unchanged):
no credentials, no `APP_URL`/public HTTPS host, egress to all three
Google hosts blocked, no inbound public webhook host. Unblock
requirements are the four lines in the M8-i5 preflight §4. Per directive,
none is retried in this review and none gates M8-i6: **T2 (C1) requires
no external access at all.**

---

## 5. Exact recommended M8-i6 scope

**M8-i6 = C1 (T2): calendar webhook redelivery dedupe on
`X-Goog-Message-Id`.**

Rationale against the directive's preference list:
- **Justified by PRD/security/reliability:** §11.1 names "event-ID
  dedupe" as the control for replayed webhook events; §18.3 established
  the dedupe-on-provider-id pattern for billing webhooks; the concrete
  operational defect (full 24 h-window import per redelivery → Google
  quota waste, duplicate audit rows, no replay resistance) is
  deterministic and provider-independent.
- **Independently verifiable without Google/Stripe/SMTP:** yes — plain
  HTTP header + local table + fixture provider with a `calls` counter
  (zero network).
- **Bounded:** one small migration, one table, one service function
  extended, one sweep extended; no endpoints, no API shape changes, no
  worker job-registry changes, no product behavior beyond the webhook
  path.
- **Deterministically testable:** yes (§6).
- **No speculative product functionality:** correct — it hardens the
  existing webhook; first-delivery semantics, unknown-token semantics,
  response shape, and all M7/M8-i1…i5 behavior are preserved.

**In scope (the bounded increment):**

1. **Migration `0024_calendar_webhook_messages.sql`** —
   `CREATE TABLE calendar_webhook_messages (connection_id uuid NOT NULL
   REFERENCES calendar_connections(id) ON DELETE CASCADE, message_id text
   NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY
   (connection_id, message_id));` + `CREATE INDEX … ON
   calendar_webhook_messages (received_at);`
2. **`packages/db/src/schema.ts`** — the table definition.
3. **Webhook route** (`apps/web/src/app/api/v1/calendar/webhook/route.ts`)
   — read the optional `X-Goog-Message-Id` header (non-empty string,
   length-capped at 128 chars; anything else treated as absent) and pass
   it to the service. The 300/min IP bucket (C2) is **unchanged**.
4. **`handleCalendarWebhook(channelToken, messageId?)`** — required
   semantics:
   - unknown/inactive token → inert `{ok: false, imported: 0}` exactly as
     today, and **no dedupe row written**;
   - provider unconfigured → inert, no dedupe row;
   - valid token **with** a message id: first-delivery check via
     `INSERT … ON CONFLICT (connection_id, message_id) DO NOTHING
     RETURNING` — a conflict (row already present within the 24 h window)
     means redelivery → return `{ok: true, imported: 0}` with **zero**
     provider calls;
   - the import runs only when the dedupe row was freshly inserted; if
     the import subsequently **fails**, the dedupe row is removed
     (compensating delete, best-effort) so Google's redelivery retries —
     a failure must not be deduplicated away;
   - valid token **without** a message id → import as today (never
     dedupe on absence — the connection id repeats every delivery).
5. **`sweepCalendarRetention`** — purge `calendar_webhook_messages` rows
   older than 24 h using the injected clock (same sweep that already
   purges OAuth states and 30-day post-disconnect rows); additive count in
   the result. Connection FK `ON DELETE CASCADE` covers disconnect-time
   cleanup.

**Constraints honored:** no new endpoints, no API response-shape changes,
no worker job-registry changes, no provider-specific logic beyond reading
the standard Google header name, no weakening/deleting existing tests, no
simulated Google, no C2/C3/C4/C5/C6/C7, nothing from C8.

## 6. Acceptance criteria (all deterministic, fixture provider — zero network)

1. **First delivery processes:** `POST` the webhook with a valid channel
   token and `X-Goog-Message-Id: M1` → import runs (fixture `list` call
   count increases), response `{ok: true, imported: n}`, a
   `(connection_id, M1)` row exists.
2. **Redelivery is a no-op:** the same token + `M1` again → 200,
   `{ok: true, imported: 0}`, and the fixture `list` call count is
   **unchanged** (zero provider calls); no duplicate audit rows.
3. **Different message id processes:** same token + `M2` → import runs.
4. **Per-connection keying:** a different connection's token + `M1` →
   import runs (message ids are only unique per channel).
5. **Missing/invalid header:** no header, empty, or >128 chars → import
   runs as today; no dedupe row is written; repeat calls still process
   (no accidental permanent skip).
6. **Inert paths write nothing:** unknown token, inactive token,
   unconfigured provider → inert response, zero rows in
   `calendar_webhook_messages`.
7. **Failure is not deduplicated:** with the fixture forced to fail the
   import (e.g. a transport error), the first delivery fails and its
   dedupe row is removed (or never durable); the redelivery then runs a
   fresh import. (Deterministic via the fixture's fault seam.)
8. **Concurrent first deliveries:** two simultaneous first deliveries of
   the same message id → at most one import runs (unique-constraint
   race); the mirror/audit end state equals the single-import end state.
9. **TTL expiry (injected clock):** a row 24 h old is purged by
   `sweepCalendarRetention`; a delivery after purging re-imports
   (idempotent — no duplicate mirrors); the sweep returns the purged
   count.
10. **Regression:** the existing webhook tests (trigger import,
    tenant scoping, unknown-token inert), all four calendar vitest files,
    both calendar E2E specs, and the full `test:coverage` suite green
    unchanged; `calendar.sync` job registry (name/cadence/§12.4
    contract) unchanged; no other route's behavior changes; full
    validation battery (typecheck, lint, build) + CI green on push and
    PR.

## 7. Explicit non-goals

- No live Google calls, no simulated/faked Google verification, no
  credentials work (C8 stays CLOSED-BLOCKED; the M8-i5 preflight doc
  governs the unblock).
- **No T3** channel-token column (directive: no live evidence / no
  explicit PRD-security requirement).
- **No T6b** webhook bucket-fairness change; the 300/min IP bucket stays.
- **No T7** opt-in export cleanup (Phase 2 feature).
- No orphaned-export reconciliation, no proactive token bucket or
  request batching, no channel-state (`X-Goog-Channel-State`) handling.
- No RRULE/series editing; no Outlook/CalDAV; no multi-calendar
  selection; no new Calendar UI.
- No changes to score/tracking/exports/billing/push or any non-calendar
  surface; no new workers; no new endpoints; no API response-shape
  changes; no weakening or deleting existing tests.

## 8. Proposed test strategy

- **Primary home:** `apps/web/src/server/services/calendar-sync.integration.test.ts`
  (the existing webhook tests live here; same fixture-provider
  discipline — deterministic, zero network). Criteria 1–9 map 1:1 to
  tests there, using the fixture's `calls` array to count `list`
  operations and `pushEvent`/fault seams to shape provider state.
  Criterion 9 uses the cycle's injected `now`.
- **Route-level check:** one integration test (or extension of the
  existing webhook test) asserting the header is actually read end-to-end
  through `POST /api/v1/calendar/webhook` (present → dedupe active;
  absent → legacy behavior), so the header-plumbing contract is pinned,
  not just the service function.
- **Sweep test:** in the worker calendar-sync integration suite
  (`sweepCalendarRetention` is exercised there): seed a 25 h-old row + a
  fresh row (injected clock), assert only the old row is purged and the
  count is additive to the existing result shape.
- **E2E:** unchanged. In this deployment Google is unconfigured, so the
  E2E webhook path exercises the honest inert/503 boundary, which this
  increment must not change — that is itself the regression assertion.
- **Full battery (per standing rules):** targeted calendar suites → full
  `vitest run` + `test:coverage` (thresholds) → `typecheck` → `lint` →
  production `build` → full Playwright E2E (Chromium, real ClamAV in CI)
  → push → GitHub CI on push + PR → milestone doc + ledger entry → clean
  tree.

## 9. Environment note and status

This increment needs **no external provider** (no Google/Stripe/SMTP
access); the C8 live surface was **not** re-probed and is not retried,
per directive — its status (BLOCKED, `bc4fd90`) stands until an
increment's preflight re-measures it. No product code was changed by
this review.

**M8-i6: REVIEW COMPLETE — proposal above; NOT implemented. STOP after
this review.**
