# Remaining-audit remediation plan (2026-09-08)

Baseline for this phase: `5e4cbd5`, branch `arena/01a080d5-nextdoo`.
Sources: original `NEXTDOO_BASELINE_AUDIT.md`, committed `REPAIR_REPORT.md`, current services/routes/worker/client code, and PRD §§6,7,10–15,18–19. Prior green tests are bounded evidence, not product acceptance.

## Classification

1 = RELEASE-BLOCKING SECURITY/PRIVACY; 2 = RELEASE-BLOCKING DATA INTEGRITY/CORRECTNESS; 3 = IMPORTANT MVP FUNCTIONAL GAP; 4 = NON-BLOCKING / LATER ENHANCEMENT.

| ID / original finding | Remaining issue at phase entry | Class | Priority/action |
|---|---|---|---|
| F14-A | Reset TTL 60 rather than ≤30 minutes; token consumption/password/session revocation not one transaction; concurrent token issuance | 1 | P0: rollback/concurrency regressions, atomic account-security operations |
| F14-B | MFA changes do not rotate/revoke sessions; enrollment checks race | 1 | P0: lock/check/change atomically, invalidate pre-change sessions, rotate caller at route boundary |
| F14-C | No origin/CSRF checks, wildcard Server Actions origins; weak security headers | 1 | P0: reject cross-origin browser mutations, exact deployment-origin configuration, CSP/security headers with real browser checks |
| F14-D | Raw reset/verification URLs and DB error parameters can reach logs | 1 | P0: production no-secret logging, safe error metadata; dev-only delivery must be explicit |
| F14-E | Per-process/per-route rather than durable account+IP backoff; missing breach-password checking | 1 | P0: durable multi-instance login throttling; external breach-source qualification remains explicit |
| F07-A | Queue records have no owner/workspace boundary; random-key ordering | 1 / 2 | P0: scoped storage, FIFO, account-switch regression; do not activate full offline product |
| F07-B | Network errors quarantined, hard failures/rejections dropped, no backoff, no durable acknowledgement guarantee | 2 | P0: preserve raw content; retry classification; transaction-complete persistence; isolated acknowledgements |
| F07-C | Capture/edit never enqueue, no shell/pull reconciliation/conflict or recovery UX; sync load/clock-skew qualification absent | 3 / 2 | Queue safety first; full offline feature and SY-01/04/05/08/10 remain launch gates, not implied by helpers |
| F08-A | SMTP_URL does not send; production fallback leaks credentials and reports success | 1 / 2 | P0: no false success; real transport boundary and failure tests; provider credentials/domain delivery remain external qualification |
| F08-B | Worker marks reminders SENT without delivery or notification and can dispatch inactive tasks | 2 | P0: transactional in-app WEB notification; unsupported external channels fail honestly; cancellation/race tests |
| F08-C | Outbox marks published without consumers; no retry/DLQ/leases/drain guarantees | 2 | P0: never acknowledge unhandled events; durable claims/retry/operational failure visibility; do not invent integrations |
| F06 residual | Eligibility rechecked by purge, but expired deletion can still authenticate/cancel before worker; purge candidate starvation | 1 / 2 | P0: deny expired accounts everywhere, cancellation races, isolate per-account failures |
| F15-A | Export omits account-level audit/preferences/recurrence and other stored data; no rate/audit guarantees | 1 / 3 | P1: owner-bound export completeness and authenticated throttling; full signed/expiring export job remains a feature gate |
| F15-B | Audit/security/billing retention conflicts; backup/object deletion and legal holds not qualified | 1 | Policy/operations blocker: retain evidence; no arbitrary destructive retention decision |
| F05 residual / §11.3 | Resource boundary review beyond tasks: roles, projects/sections/tags/reminders, malformed IDs, export ownership | 1 / 2 | P0/P1: test actual owner authorization, not existence; fix confirmed bypasses |
| F02 residual / §10.7 | Only selected endpoints opt into HTTP idempotency; create/side-effect endpoints not comprehensively covered | 2 | P1: qualify mutation identity at remaining write boundaries; avoid conflating route presence with contract completeness |
| F03 residual | Global sync write serialization; migration runner has no concurrency lock/checksum | 2 | P1: migration coordination/drift regression; production sync throughput remains unmeasured |
| F04 residual | Same-entity merge/rejected-content recovery and all business paths not fully qualified | 2 | P1: rejected payload retention and boundary regressions; preserve previous isolation suite |
| F10 residual | Sub-minute per-session rounding loss, clock skew, legacy malformed timers | 2 | P1: quantify duration loss and retain exact credited seconds; no fabricated historical repair |
| F11 residual | Original scoring inputs not provenance-complete; UTC/trailing periods vs workspace periods | 2 / 3 | Qualify correctness, do not invent a full analytics rewrite; backfills/corrections/opt-out remain MVP work |
| F12 residual | Recurrence generation/workflow absent (now fails explicitly); parsed tags/projects discarded | 3 | No recurrence/large planning feature in this phase; preserve original intent instead of silent loss |
| F13 residual | Real Stripe lifecycle/reconciliation, other entitlement limits absent | 3 | Billing feature prohibited here; investigate current local quota/authorization races only |
| API/§14 | Missing groups/aliases/casing decisions, ignored tag filter, delete/restore version contracts, 100% contract coverage absent | 2 / 3 | P1 correctness where existing behavior lies; broader contract expansion requires compatibility decision |
| Database/§13 | SQL/schema drift, parent FK/index differences, missing rollups/configuration | 2 / 3 | Migration SQL remains authoritative; do not generate replacement schema/history |
| UI/§§6,8 | Editor/board/subtasks/dependencies/location, project lifecycle, filters/bulk/pagination, responsive navigation, shortcuts | 3 | Inventory only; no broad product implementation |
| Calendar/§16, desktop/§9, attachments/§6.8, commercial/§18, AI/§17 | Actual integrations/clients are absent | 3 | Explicitly prohibited next product work; not marked complete |
| Reporting/§7, export/§11.9 | Local periods, rollups/trends, corrections, wellbeing controls, expiring CSV/JSON | 3 | Remaining MVP acceptance gates |
| Operations/§§12,19 | Managed secrets/IAM/TLS, PITR/restore, rollback, SLO/load, OTel/alerts, ASVS/SAST/secret scan, a11y/support/kill switches | 1 / 2 (security/recovery); 3 (product/support) | Production release blocked until evidence exists; local tests cannot certify these |
| §20 and audit decisions | Consent-aware product events/activation conflict, weekly review choices, public API phase, deployment/provider/retention choices | 3 / 4 | Resolve before corresponding feature; no telemetry/provider/policy invented |
| Explicit P2/P3 | Teams/custom states/passkeys/social auth/mobile/voice/rules/public API/marketplace/enterprise | 4 | Later enhancements, not this remediation |

Previously repaired F01–F06/F09–F13 paths retain their permanent regressions. Only their residuals are listed above; no repaired path is assumed immune to regressions.

## Execution order

1. **Account-security boundary:** reset/MFA transactions and sessions, expiry, origin controls/logging, durable authentication throttling.
2. **Offline safety:** scoped queue, FIFO, durable writes, backoff and content retention; no full offline feature rollout.
3. **Honest durable delivery:** remove false acknowledgements, test real transport behavior, WEB notification consistency, external-channel failures, worker recovery.
4. **Remaining existing-path integrity:** authorization/export/deletion, migration safety and measurable timing/contract defects. Stop before product-level or legal decisions.
5. **Release qualification report:** fresh migrations + full tests/typecheck/lint/coverage/build/E2E + dependency audit. Report every open item and all unverified production gates, even if local tests pass.

Each completed repair milestone gets regressions before its fix, targeted and full verification, and a meaningful commit with a clean working tree. No recovered-branch changes, history rewrites or force-pushes.

## PRD acceptance disposition at entry

§19.2: (1) offline create **open**; (2) duplicate mutations **bounded server pass**; (3) cross-device convergence **client open**; (4) conflicting text **server retention only, UI open**; (5) recurring retry **absent**; (6) reminder cancellation **pass on tested paths**; (7) Calendar disconnect **absent**; (8) verified billing entitlements **provider absent**; (9) deleted-account auth **expired-grace defect to test**; (10) expiring exports **absent**; (11) malware-blocked downloads **absent**; (12) Unmeasured scoring **bounded pass**; (13) keyboard accessibility **five flows only, not full certification**; (14) database restore **unverified**.

§19.3: server SY-02/03/06/07/09 have bounded tests; full SY-01/04/05/08/10 and client convergence remain unaccepted. §19.4 has unresolved security/data-loss and unverified deployment/accessibility/monitoring/recovery gates. Neither routes nor schemas satisfy these gates.
