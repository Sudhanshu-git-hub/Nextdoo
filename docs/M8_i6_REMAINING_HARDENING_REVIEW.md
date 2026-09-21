# M8-i6 — Remaining class-3 hardening review and recommendation

**Status: REVIEW APPROVED; T2/T6b IMPLEMENTED AS M8-i6.**
Date: 2026-09-19. Review baseline: M8-i5 final commit `bc4fd90` on
`arena/01a0ba0b-nextdoo`; implementation authorized from review commit
`e6eab16`.

This document began as the planning/review artifact requested after M8-i5 closed
blocked at preflight. It now also records the as-built M8-i6 result for the two
approved items only: T2 webhook redelivery/replay dedupe and T6b token-scoped
webhook bucket fairness. M8-i6 does **not** reopen M8-i5, does **not** retry live
Google verification, and does **not** implement T3 channel-token hardening.

## 0. Sources reviewed

Reviewed in full or re-checked for the matrix below:

- `docs/PRD.md` — all sections, with special attention to §§5.5, 7.9, 11,
  12, 14, 16, 18, 19, 21 and the decision register.
- `docs/M8_ROADMAP_AUDIT.md` — remaining gaps and external-blocker inventory.
- M8-i4 review + milestone:
  `docs/M8_i4_GOOGLE_CALENDAR_HARDENING_REVIEW.md`,
  `docs/M8_i4_GOOGLE_CALENDAR_HARDENING_MILESTONE.md`.
- M8-i5 preflight:
  `docs/M8_i5_GOOGLE_CALENDAR_LIVE_UNBLOCK_PREFLIGHT.md`.
- Closed M8 milestones to avoid overlap:
  `docs/M8_i1_BROWSER_PUSH_MILESTONE.md`,
  `docs/M8_i2_ADVISORY_SUGGESTIONS_REVIEW.md`,
  `docs/M8_i2_ADVISORY_SUGGESTIONS_MILESTONE.md`,
  `docs/M8_i3_WELLBEING_CONTROLS_REVIEW.md`,
  `docs/M8_i3_WELLBEING_CONTROLS_MILESTONE.md`.
- Current implementation and coverage for the remaining candidates:
  - Calendar webhook route/service:
    `apps/web/src/app/api/v1/calendar/webhook/route.ts`,
    `apps/web/src/server/services/calendar-connections.ts`.
  - Calendar sync engine/schema/tests:
    `packages/db/src/calendar-sync.ts`, `packages/db/src/schema.ts`,
    `apps/web/src/server/services/calendar-sync.integration.test.ts`,
    `apps/worker/src/calendar-sync.integration.test.ts`,
    `packages/calendar/src/google.test.ts`.
  - Billing webhook dedupe contrast:
    `apps/web/src/app/api/v1/billing/webhooks/route.ts`,
    `packages/db/src/billing-sync.ts`,
    `apps/web/src/server/services/billing-lifecycle.integration.test.ts`.
  - Route throttling:
    `apps/web/src/server/http.ts`, `apps/web/src/server/auth.ts`.
  - Restore/migration/CI posture:
    `packages/db/src/migrate.integrity.integration.test.ts`,
    `.github/workflows/quality.yml`.

## 1. Review classification rule

For this review, a **remaining class-3 hardening candidate** means a bounded
hardening item left after the closed M8-i1…i5 work, especially the residual
Calendar hardening items called out in M8-i4. Each candidate is then
classified into the requested buckets:

1. **PRD-required** — an explicit PRD or release-gate requirement remains unmet.
2. **Security-required** — a demonstrable security defect/risk requires a fix.
3. **Reliability/operational hardening** — correctness mostly holds, but the
   current design can waste resources, reduce freshness, or hurt operations.
4. **Optional convenience** — useful UX/product convenience but not a PRD/security
   requirement and not needed for deterministic hardening.
5. **Externally blocked** — cannot be honestly completed in this sandbox because
   provider credentials, egress, ingress, production infrastructure, or elapsed
   operational evidence are missing.

A row may cite PRD/security text but still be classified as reliability if the
current implementation already prevents data corruption or cross-tenant access.
That distinction is important for the Calendar webhook rows: the remaining issue
is replay/load/fairness, not a proven data-loss or tenant-isolation bug.

## 2. Complete remaining class-3 candidate matrix

| ID | Candidate | Classification | Exact source / PRD anchor | Current implementation status | Concrete defect or risk addressed | External provider / env required? | Deterministic acceptance criteria | Expected schema / API / code impact | Existing test coverage | Overlap with closed milestone? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H1 | Calendar webhook redelivery dedupe (`T2`) | **3 — reliability/operational hardening** with PRD/security anchor | PRD §11.1 threat model: webhooks need replay controls including event-ID dedupe; M8-i4 review §3.3 `T2`; M8-i4 milestone §7 deferred list | Calendar webhook body schema accepts optional `eventId`, but `route.ts` ignores it; `handleCalendarWebhook(channelToken)` triggers an import every time. Import upserts/mapping writes are idempotent, and unknown/inactive tokens are 200 no-op. Billing webhooks already have durable event-id dedupe (`billing_events`). | Duplicate provider redeliveries are correctness-safe but can re-run imports, duplicate Calendar audit rows, consume DB/provider budget, and amplify noisy channels. No cross-tenant defect is proven because the token scopes to one connection. | **No** for deterministic app-level dedupe against the existing normalized webhook envelope. Real Google header/body shape remains M8-i5 live point 12 and is blocked. | Same `(connection_id, message_id)` delivery processes at most once; duplicate returns 200 with an explicit duplicate/no-op result; zero provider calls on duplicate; same `message_id` on another connection is not a duplicate; concurrent duplicates produce one import and one ledger row; rows expire by retention sweep; absent message id preserves current behavior. | Likely one migration for `calendar_webhook_deliveries` or equivalent recent-message ledger; schema export; `handleCalendarWebhook(token, {messageId?})`; route passes normalized `eventId`; no public endpoint path change and no Calendar product UI. | Current positive coverage: `calendar-sync.integration.test.ts` verifies webhook import, tenant scoping, unknown token no-op. Missing: duplicate delivery, concurrent duplicate, route-level body parsing, TTL cleanup. Billing dedupe tests provide a proven pattern. | **Does not reopen M8-i4**: M8-i4 explicitly deferred T2. Does not touch M8-i5 live blocked path. |
| H2 | Calendar webhook rate/bucket fairness (`T6b`) | **3 — reliability/operational hardening** | PRD §14.8 rate-limit responses; PRD §16.1 webhook change detection + polling fallback; PRD §12.1 Calendar sync freshness; M8-i4 review §3.3 `T6b`; M8-i4 milestone §7 deferred list | `publicRoute` applies `rateLimit("calendar.webhook:<ip>", 300/min)` before body parsing. A shared provider egress IP can make one noisy channel consume the whole bucket. Unknown tokens are still inert 200 once they reach the handler. | One connection's burst can 429 another connection behind the same provider IP. Repeated 4xx responses to a push channel can cause provider-side retirement; fallback polling limits data loss but freshness degrades and webhook health becomes noisy. | **No** for deterministic per-token fairness using the existing token in the accepted body. Live provider egress behavior remains blocked. | Active token A over its per-token window is limited with `Retry-After`; token B from the same IP remains accepted and imports; missing/invalid-token traffic remains capped by an IP-level guard; unknown tokens still do not trigger imports; duplicate H1 deliveries do not burn provider calls; route emits no token material in logs. | Route wrapper needs token-aware rate limiting after safe parse, or a small route-local limiter before `handleCalendarWebhook`; possibly no schema if paired with H1 ledger only. No public endpoint path change. | Current coverage only tests generic `publicRoute` security/rate patterns and service-level Calendar webhook import. Missing: token fairness route tests. | New work only; M8-i4 implemented outbound provider `Retry-After` scheduling (`T4`), not inbound webhook fairness. |
| H3 | Dedicated random Google push-channel verification-token column (`T3`) | **5 — externally blocked / deferred**; not security-required on current evidence | M8 audit L4; M8-i4 review §3.2/§3.3 `T3`; M8-i5 preflight §3; PRD §11.1 webhook replay/forgery control | Current token is the calendar connection UUID, echoed in the webhook body and used to scope import. Unknown or inactive token returns 200/no-op. M8-i4 review found no demonstrable cross-tenant or stale-channel defect. M8-i5 says T3 is implemented only with live evidence or explicit PRD/security requirement. | Would decouple the channel secret from the connection id and allow per-channel rotation/revocation. The current residual is architectural neatness, not a proven vulnerability. | **Yes.** M8-i5 live pass is blocked: no Google credentials, no public HTTPS redirect/webhook host, no Google egress, no inbound webhook reachability. | Only after unblock: real Google watch request carries the dedicated token; POST validates it; disconnect/renew rotates or invalidates it; stale channels no-op; tenant isolation verified live and fixture tests pass. | Migration adding a token column or channel table; watch creation uses random token; route looks up token instead of connection id; tests. | Existing tests cover connection-id token watch body and tenant scoping; no dedicated-token tests. | Explicitly blocked by M8-i5; implementing now would violate the current directive. |
| H4 | Optional export-event cleanup on disconnect (`T7`) | **4 — optional convenience** | PRD §16.5: exported calendar events are **not automatically deleted by default**; M8-i4 review §3.4 `T7`; M8-i4 milestone §7 deferred list | `finalizeDisconnect` revokes best effort, wipes tokens/sync/channel state, marks `DISCONNECTED`, and retains mappings/mirrors for 30 days. Test `disconnect ... retains mappings` pins that behavior. Exported calendar events remain unless the user deletes them in Google. | Convenience for users who want NEXTDOO-created Google events removed during disconnect. Not a reliability defect because the PRD explicitly says no automatic deletion by default. | Deterministic fixture tests possible, but live provider deletion semantics would still be unverified. | If ever built: explicit user option; default remains preserve; deletion attempts best-effort and isolated; failures cannot block local token wipe/disconnect; audit records option/outcome. | API/UI disconnect option, provider delete loop for mapped exports, tests, documentation. Would change existing locked disconnect expectations when option is true. | Existing test proves default retention. Export deletion for stale mapped tasks exists in `runCalendarExport`, but not disconnect cleanup. | Would modify M7/M8 Calendar disconnect behavior; not appropriate for hardening without a product requirement. |
| H5 | Orphaned export reconciliation after provider create succeeds but DB mapping commit fails | **3 — reliability hardening**, but low-evidence/deferred | PRD §16.6 no duplicate events for same task; M8-i4 review §3.4 "orphaned-export reconciliation" | Once a mapping row exists, unique `(connection_id, task_id)` prevents duplicates and stale mapping deletion is tested. The edge between provider create and local mapping insert has no deterministic provider marker/reconcile path. | Crash/transaction failure after a successful provider create could leave an external orphan; next export could create a second Google event. Rare, requires failure at a narrow seam. | No live provider needed for a fixture proof, but any robust design likely changes event payload/extended properties and should be live-verified later. | Fixture simulates provider create then DB insert failure; next pass identifies same task's existing provider marker and links rather than creating another event; no duplicate mapping; no cross-tenant marker collision. | Provider write payload marker, import/export reconciliation logic, tests; possible migration if marker stored separately. | Existing export tests cover mapping uniqueness, 404/412 recreate, stale mirror removal. | Adjacent to M7/M8-i4 export logic but not closed; too speculative without observed failure or marker requirement. |
| H6 | Proactive per-connection Google API token bucket | **3 — reliability/operational hardening**, deferred | PRD §16.1 rate-limit row says token bucket per connection; M8-i4 review §3.4; M8-i4 T4 already persisted `Retry-After` windows | M8-i4 implemented reactive 403/429 handling across cycles (`rate_limited_until`), parses `Retry-After`, makes zero calls inside the window, and logs rate-limited cycles. No proactive local quota bucket exists. | Proactive pacing could reduce first-hit 429s, but without live quota shape it risks inventing arbitrary limits or reducing freshness. | Live quota behavior is blocked; deterministic tests are possible but would encode guessed quotas. | A real quota model would need observed/provider-documented limits, per-connection token accounting, no freshness regression, and proof that it does not suppress needed sync. | Likely schema or durable counter plus cycle changes; test clock. | M8-i4 has strong reactive backoff tests. | Would overlap M8-i4 `T4`; not justified until live evidence shows reactive handling is insufficient. |
| H7 | CI database backup/restore smoke test | **1 — PRD-required** and **3 — reliability hardening** | PRD §19.2 required acceptance #14: "Database restore has been tested successfully"; PRD §12.3 monthly restore tests; PRD §21.4 public-beta/GA gates | CI runs `pnpm db:migrate` twice and migration integrity tests cover locking/checksums, but there is no `pg_dump`/`pg_restore` restore drill. Production PITR/monthly restore remains an ops gate. | A migration-only green build does not prove backup artifacts can be restored into a fresh database with data/invariants intact. | **No** for a CI smoke restore against the existing PostgreSQL service. **Yes** for production PITR/monthly restore evidence. | Script creates a throwaway DB, applies migrations, seeds representative rows, `pg_dump`s, restores into a second throwaway DB, asserts key counts/constraints/version rows, and drops both DBs. CI runs it after migrations. Explicitly does not claim production PITR. | New script and package script; CI workflow step; no product API/schema changes. | Existing `migrate.integrity.integration.test.ts` covers concurrent migrations/checksum drift only. | No closed feature overlap; release-gate hardening, not Calendar-specific. |
| H8 | Formal ASVS L2 mapping + deterministic SAST/secret-scan CI checks | **2 — security-required** for release assurance, partly **5** for pen test/push-protection evidence | PRD §11.8; PRD §19.1 security category; PRD §19.4 security gate; decision SD-02 | Many security tests exist (auth hardening, request security, isolation, attachment gating), and CI runs `pnpm audit --audit-level high`, but there is no formal ASVS mapping doc, no SAST step, and no secret-scan step in this workflow. Pen test is external. | Security evidence is ad hoc; touched areas cannot be mapped to ASVS controls; accidental secret additions may not be caught deterministically before push. | No external provider required for an initial local script/checklist. Third-party pen test and platform push-protection evidence remain external. | Add ASVS L2 control map for implemented surfaces; CI fails on deterministic secret patterns and forbidden committed env files; touched-area tests linked; no high/critical dependency findings. | Docs plus script/workflow. Avoid external scanners if CI supply-chain scope is a concern. | Current CI audit step and security tests remain. | No closed product overlap; scope can grow if not bounded. |
| H9 | k6 and Lighthouse baseline | **3 — reliability/performance hardening**, deferred | PRD §19.1 performance/reliability testing; PRD §19.4 performance/reliability release gates; M8 audit R5/M6 | M2 performance baseline exists via scripts/tests; no k6 or Lighthouse CI. | Lack of load/web-vitals gate can hide regressions. | No provider required, but stable load/browser budgets need staging-like resources; local CI can be flaky and may not represent production. | Minimal smoke budgets only: fixed seed, local server, deterministic thresholds, artifacts; no production SLO claim. | New dependencies/scripts/workflow; possibly longer CI. | Existing performance baseline only. | No closed feature overlap, but likely broader than one bounded M8 increment. |
| H10 | Feature flags / kill switches / canary / rollback procedure | **3 — reliability/operational hardening**, partly **5** for canary evidence | PRD §12.5 deployment; PRD §19.4 feature flag/rollback readiness | Migrations are backward-compatible with checksums; no general feature-flag system; no canary or kill-switch verification. | Risky changes cannot be disabled quickly except by revert/rollback; no measured rollback procedure. | A local feature-flag library/doc is implementable; canary evidence needs deployment infra. | One explicit kill switch for a touched risky path, rollback runbook, tests proving flag off path; no broad platform claim. | Code/config/docs depending on selected flag. | Migration safety tests exist. | Could become speculative without a concrete feature to guard. |
| H11 | Production SLO dashboards, 30-day evidence, status page/on-call/incident runbooks | **5 — externally blocked** | PRD §§12.1, 12.6, 19.4, 21.4 | Metrics/logs/request IDs exist, but no production dashboards or sustained SLO evidence in repo. | Public beta/GA operational readiness cannot be claimed. | **Yes:** needs production deployment, monitoring backend, status-page/on-call setup, elapsed 30-day window. | Production dashboards populated; alert tests; 30-day SLO report; incident runbooks/status page. | Mostly ops docs/config, external systems. | Current local tests cannot satisfy it. | No implementation in current sandbox. |
| H12 | Live provider verification gates (Google, billing, SMTP/S3 production delivery) | **5 — externally blocked** | M8 audit X1–X3; M8-i5 preflight; PRD §§16, 18, 6.6/9.3, 6.8 | Google live pass blocked at M8-i5; billing live verification blocked by absent provider keys/egress; SMTP production delivery absent; S3 bucket is deployment config. | Code can be fixture-verified but live provider behavior is unknown. | **Yes:** credentials, egress, public ingress/hosts, provider accounts. | Run provider-specific live checklists and record observed behavior; no mocks/stubs. | No code necessarily; env/deployment plus evidence docs. | Fixture and provider-adapter tests exist. | Closed-blocked work must not be reopened in this sandbox. |

## 3. Candidates that should be deferred

Deferred now because they are optional, speculative without live evidence, too broad for
M8-i6, or already covered enough by closed milestones:

1. **H3 — dedicated channel-token column (T3):** explicitly deferred by M8-i5
   until live evidence or an explicit PRD/security requirement exists.
2. **H4 — optional export cleanup:** PRD §16.5 says exported events are not
   automatically deleted by default; adding an explicit cleanup option is product
   convenience, not hardening.
3. **H5 — orphaned export reconciliation:** real risk is narrow, and a robust
   solution likely adds provider-visible event markers. Defer until observed or
   until live Calendar verification is unblocked.
4. **H6 — proactive Google API token bucket:** M8-i4 reactive backoff is already
   deterministic and CI-verified; without live quota evidence, proactive quotas
   would be guessed.
5. **H9 — k6/Lighthouse:** useful release hardening, but broader and more CI-flaky
   than H1/H2 or H7. Revisit as a dedicated release-gate increment.
6. **H10 — general feature-flag/canary system:** valuable, but too open-ended
   unless tied to a concrete risky path.
7. Minor route/product gaps from the audit (`PATCH /v1/reminders/:id`,
   `GET/POST /v1/workspaces`) are **not class-3 hardening**; they are small
   API/product-convenience gaps and should not drive M8-i6.

## 4. Externally blocked candidates

These cannot be honestly completed in the current sandbox:

| Blocked item | Why blocked now | Unblock requirement |
| --- | --- | --- |
| M8-i5 live Google 16-point pass and T3 decision | No Google OAuth credentials, no public HTTPS redirect/webhook host, egress to Google hosts blocked, no inbound webhook reachability | OAuth client/test account, configured `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`APP_URL`, egress, long-lived public ingress |
| Live billing verification | No Stripe/Razorpay provider keys and provider egress is blocked | Test-mode provider keys/accounts + egress |
| Production SMTP delivery evidence | No SMTP provider configured; production mode fails explicitly | SMTP provider, credentials, sender/domain setup |
| Production S3/object-storage qualification | Local-disk store/test seams exist; real S3 bucket and lifecycle policy are deployment config | S3-compatible bucket, credentials, lifecycle/scanning setup |
| Production PITR/monthly restore/SLO/pen-test/status-page evidence | Requires production infrastructure, monitoring/security vendors, and elapsed time | Production deployment + ops setup + evidence window |

## 5. Recommended M8-i6 scope

**Recommended exact M8-i6:** **Calendar webhook ingress replay/fairness hardening**
— implement **H1 (webhook redelivery dedupe)** and **H2 (per-token webhook bucket
fairness)** as one bounded ingress increment.

Rationale:

- It is the remaining Calendar class-3 hardening that is **legitimately
  implementable without live Google** and without reopening M8-i5.
- It is PRD/security/reliability justified: PRD §11.1 names webhook replay/dedupe
  controls; PRD §14.8 requires rate-limit behavior; PRD §16.1 relies on push
  webhooks for freshness.
- It does **not** implement T3 and does not depend on T3.
- It does not add product functionality: no UI, no new Calendar feature, no new
  provider capability claim.
- It is bounded to one ingress route/service path, likely one small retention
  migration, and deterministic fixture/route tests.
- It complements, rather than overlaps, M8-i4: M8-i4 hardened outbound provider
  cycles (`T1/T5/T4/T6a`); M8-i6 would harden inbound webhook replay/fairness.

**Not selected for M8-i6, but valid later:** H7 (CI database restore smoke test) is
also strongly PRD-required and implementable. It should be the next release-gate
hardening candidate after the Calendar ingress residuals, or it may supersede H1/H2
if the team explicitly chooses release-gate hardening over Calendar continuity.

## 6. M8-i6 acceptance criteria

All acceptance criteria are deterministic and must use fixture/provider seams only.
No live Google calls, no live webhook delivery, and no T3 channel-token column.

1. **Duplicate delivery no-op:** two Calendar webhook requests for the same active
   connection and same normalized `messageId`/`eventId` produce exactly one import;
   the second returns 200 with a duplicate/no-op marker and makes zero provider calls.
2. **Connection scoping:** the same message id on two different active connections is
   processed independently; no cross-tenant dedupe or data leakage.
3. **Concurrent duplicate safety:** concurrent duplicate deliveries race safely: one
   ledger insert/import wins; all others no-op; no duplicate audit rows for the same
   provider message.
4. **Absent id preserves behavior:** a webhook without a message id follows the current
   behavior (token-scoped import if active; no dedupe claim). This avoids inventing live
   provider semantics before M8-i5 is unblocked.
5. **Retention:** old webhook-dedupe ledger rows are purged by a deterministic retention
   path (for example, the existing Calendar retention sweep) without touching
   connections, mappings, events, tasks, or audit logs.
6. **Token-bucket fairness:** a burst for token A can rate-limit token A and include
   `Retry-After`; a request for token B from the same IP still reaches the handler and
   imports normally.
7. **Invalid-token guard:** missing or malformed tokens remain bounded by an IP-level
   guard; unknown/inactive well-formed tokens still return 200/no-op and never invoke a
   provider.
8. **No token/content leaks:** logs/ledger rows contain connection/message metadata only,
   no OAuth tokens and no task/calendar titles beyond existing audit behavior.
9. **No public API break:** endpoint path and success status remain compatible; any new
   `duplicate` field is additive. Existing Calendar E2E and integration tests pass
   unchanged except where expanded to assert the new behavior.
10. **Regression:** targeted Calendar route/service tests, full unit/integration suite,
    coverage gate, typecheck, lint, build, E2E, push and GitHub CI all green.

## 7. M8-i6 explicit non-goals

- No live Google verification, no Google egress probes beyond the already-closed M8-i5
  preflight, and no simulated claim of live provider behavior.
- No T3 dedicated channel-token column, channel-token rotation, or provider watch-token
  redesign.
- No optional disconnect export cleanup.
- No proactive Google API quota model.
- No RRULE/series editing, multi-calendar selection, Outlook/CalDAV, or new Calendar UI.
- No billing, SMTP, S3, or production-ops verification.
- No changes to M8-i1 push, M8-i2 suggestions, M8-i3 wellbeing, or M8-i4 outbound
  Calendar hardening except the minimum imports/tests needed for the webhook ingress path.

## 8. Proposed M8-i6 test strategy

| Layer | Tests |
| --- | --- |
| Pure/service integration | Seed two users/connections with fixture providers. Verify duplicate message id, same id on different connections, concurrent duplicate race, absent id behavior, unknown/inactive token no-op, and retention purge. Assert provider call counts and audit row counts. |
| Route integration | Exercise `POST /api/v1/calendar/webhook` through the real route with the current normalized body shape (`channel.token`, optional `eventId`). Verify 200/no-op duplicate response, malformed body 400, same-IP token-fairness behavior, IP guard for invalid/missing tokens, and `Retry-After` on a per-token limit. |
| Regression | Existing Calendar import/export/conflict/disconnect tests; M8-i4 token/backoff tests; billing webhook dedupe tests unaffected; full `test:coverage`. |
| E2E | Existing `calendar.spec.ts` and `calendar-sync.spec.ts` should pass unchanged. No new live-provider E2E is added. |
| Security/logging | Assert no token material appears in logger output or dedupe ledger; duplicate requests cannot cross tenant boundaries. |

## 9. As-built implementation result

Implementation proceeded only after explicit authorization from review commit
`e6eab16`. The selected M8-i6 scope is complete in code and deterministic tests:

- **T2 implemented:** `handleCalendarWebhook(token, { messageId? })` claims a
  durable `(connection_id, message_id)` ledger row before import. Successful
  duplicates return an additive `duplicate: true` no-op response and make zero
  provider calls. Failed/stale processing rows are reclaimable, so legitimate
  provider retries after a transient failure remain recoverable. Absent
  `messageId` keeps the previous token-only import behavior.
- **T6b implemented:** the Calendar webhook route now parses safely, then applies
  per-token `300/minute` buckets with `Retry-After`, an IP-level invalid/missing
  body guard, and a higher global IP safety guard that is checked only after the
  token bucket admits a request. Bucket keys hash the token; raw token values are
  not logged.
- **Schema implemented:** migration
  `packages/db/migrations/0024_calendar_webhook_deliveries.sql` adds
  `calendar_webhook_deliveries`; `packages/db/src/schema.ts` exports
  `calendarWebhookDeliveries`.
- **Retention implemented:** `sweepCalendarRetention` purges expired webhook
  delivery rows and returns a `webhookDeliveries` count; the worker retention log
  includes it.
- **Regression tests added:** expanded Calendar integration tests cover first
  delivery, exact/multiple duplicates, duplicate after success, retry after
  processing failure, same message id on two connections, distinct messages on
  one connection, tenant isolation, concurrent duplicate safety, retention purge,
  token-bucket exhaustion, unrelated-token admission from the same IP, window
  rollover, and invalid/missing-token IP guarding.

Detailed as-built notes, validation results and deferred items are recorded in
`docs/M8_i6_GOOGLE_CALENDAR_WEBHOOK_INGRESS_MILESTONE.md`.

## 10. Stop point

M8-i6 stops after T2/T6b webhook ingress hardening. Do not start M8-i7 from this
milestone, and do not reopen M8-i5/T3/live Google without a separate unblock
decision.
