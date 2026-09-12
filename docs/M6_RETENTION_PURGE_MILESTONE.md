# M6 — increment 6: retention & purge pipeline

PRD scope implemented (authoritative sources: PRD §12.4 job table, §13.5
retention, §18.1 plan matrix, §6.3 task state machine):

- the daily `retention.purge` worker job (interval 24 h);
- **3 bounded retries** — codebase convention "N retries" = initial attempt +
  N (same as `export.generate`'s "2 retries"): attempts 1–4 with 60 s / 5 m /
  15 m backoff;
- **Alert; never auto-skip** — every attempt failure logs
  `retention.purge.attempt_failed` with the root-cause error; exhaustion logs
  `retention.purge.dead_lettered` (loud error) and returns normally so the
  supervisor does not loop a daily job; un-purged rows stay in place for the
  next run, and every purge decision is accounted for in
  `retention.purge.completed` (nothing is silently dropped);
- **30-day purge of eligible deleted tasks** (§13.5 "Deleted tasks 30 days",
  §6.3 "Deleted → Permanently deleted, system retention job"): tasks with
  `deleted_at <= now − 30 d` (exact boundary inclusive), with full cascade —
  attachments (+ object-store files), reminders, timer sessions, tags,
  dependencies, calendar mappings, recurrence rules, tracking jobs, sync
  tombstones (`purge_after <= now`);
- **plan-based audit-log retention** (§18.1: None / 30 d / 1 y / 7 y =
  0 / 30 / 365 / 2555 d) using the *same* entitlement source the read side
  uses (`limitsFor(plan).auditLogRetentionDays`), so visibility and
  destruction can never disagree about a plan's window; strict complement:
  rows visible while `created_at >= now − R`, purged when
  `created_at < now − R` — no gap, no overlap;
- **security-log floor** (§13.5 "Security logs 1 year"): security-critical
  actions (explicit `SECURITY_AUDIT_ACTIONS` allowlist — all `account.*`
  security events) are kept at least one year even where the plan window is
  shorter (FREE: floor is the entire retention);
- **failed-job cleanup** (§13.5 "Failed jobs 30 days"): terminal failed
  tracking jobs (attempts ≥ 6, not acknowledged, unclaimed), failed reminders,
  failed exports, failed mail deliveries — all older than 30 days;
- **idempotent + crash-safe**: each unit purges via `DELETE … WHERE id IN
  (SELECT … FOR UPDATE SKIP LOCKED)`, commits per unit; a crash mid-run leaves
  completed units durable and the remainder eligible; rerunning is a no-op on
  already-purged rows;
- **tenant/workspace isolation**: audit purging is per-workspace (and
  per-account-owner for account-level rows) against each owner's *own* plan;
- **records that must NOT be deleted are retained and counted**: tasks with
  an in-flight export (PENDING/PROCESSING) are retained (purged once the
  export reaches a terminal state), tasks referenced by an active parent
  (no-action FK) are retained, security-critical audit rows are floored, and
  tracking events/results, the sync replay log, the outbox, and
  in-window/in-restore-window rows are never touched by this job.

Out of scope by design: legal-hold and enterprise destructive-retention
semantics (PRD §13.6 mentions legal hold for enterprise but does not define
behavior — flagged as an open policy decision, not invented); account-deletion
purge (`purgeAccount`, M6 work) and export-file 24 h expiry (existing
`expireExports` job) are separate PRD rules with their own jobs and are
untouched. The M6-i1 read-side retention behavior is unchanged.

## Implementation

- `packages/db/src/retention.ts` — `runRetentionPurge(db, opts)`:
  single-pass sweep in fixed unit order (tasks → tombstones → audit → failed
  jobs), per-row failure isolation (one poisoned row is reported with its
  root-cause error, retried next run, never aborts the sweep), per-run bounded
  limits (1000 tasks, 1000 tombstones, 200 distinct workspaces / 200 distinct
  account owners, 20 audit batches × 1000 per workspace, 1000 failed jobs).
  `opts.now` (fixed clock) and `opts.limit` exist for testing; production
  uses real time and the defaults.
- `apps/worker/src/jobs.ts` — `retention.purge` job (24 h) wiring
  `runRetentionPurgeWithRetries` (initial attempt + 3 retries, backoff,
  dead-letter alert, full accounting in the result details).
- Candidate scans cap **distinct tenants**, not raw rows: a single busy
  tenant cannot inflate its way into the whole slot budget and starve other
  tenants (root cause of a real CI failure — see Validation). Purged tenants
  drop out of the candidate set, so each daily run makes forward progress.

## Safety / retention invariants verified

| Invariant | Where verified |
|---|---|
| Exact 30-day task boundary (`<= now − 30d`), cascade incl. files | web suite, test 1 |
| Every plan boundary at the exact day (FREE 0 / PRO 30 / TEAM 365 / ENT 2555) | web suite, test 2 |
| 1-year security floor boundary, per plan | web suite, test 3 |
| Tenant isolation (each owner's own plan window; account-level rows) | web suite, test 4 |
| Distinct-tenant scan cap; busy tenant cannot starve others; next-run catch-up | web suite, test 5 |
| In-flight export retention; purge after export completes | web suite, test 6 |
| No-action parent FK retention + convergence | web suite, test 7 |
| Per-row failure isolation (poisoned row reported, sweep continues, row survives until repaired) | web suite, test 8 |
| Tombstone expiry (any entity type; in-restore-window kept) | web suite, test 9 |
| Failed-job expiry (4 kinds, terminal-failure + age only) | web suite, test 10 |
| Protected records never deleted (tracking, sync log, outbox, in-window rows) | web suite, test 11 |
| Bounded passes across crash/restart; idempotent rerun | web suite, test 12 |
| Job wiring, retry/backoff timing, dead-letter alert, result accounting | worker suite (5 tests) |
| User-visible: 31-d task restore 404 + row/tombstone gone; 29-d restore 200 ACTIVE; plan-scoped audit visibility (40-d gone, 5-d visible) + DB-level purge proof | E2E `retention.spec.ts` (CI) |

## Tests

- 12 web integration tests (`apps/web/src/server/services/retention-purge.integration.test.ts`)
  on a dedicated disposable database per test (fresh schema, fixed clock).
- 5 worker integration tests (`apps/worker/src/retention-purge.integration.test.ts`):
  job registration/interval, success accounting, retry with backoff after
  transient failures, dead-letter after exhaustion (4 `attempt_failed` +
  `dead_lettered`), and result propagation.
- 1 Playwright E2E spec (`apps/web/e2e/retention.spec.ts`) driving the real
  API (register, task create/delete/restore, audit-logs endpoint) plus the
  same `runRetentionPurge` the job invokes. Runs in CI (no browser in the
  sandbox, as in all prior milestones).

## Validation (all executed)

- Full local suite: **722/722 passed** (69 files), exit 0.
- Lint: `eslint . --max-warnings=0` — 0 warnings. Typecheck: web / worker /
  db — clean.
- Coverage thresholds met (collection scope unchanged: core 97.91% lines;
  overall 89.4% statements / 93.24% lines); `packages/db` and `apps/worker`
  are outside the collection include, as in every prior milestone.
- Production build: `pnpm build` (Next.js, all pages) — success; web is the
  only build-script package (worker/db run from source).
- Migration replay: fresh database → all 21 migrations applied → every new
  retention SQL statement parses and executes against the fresh schema
  (idempotent re-run verified by the per-test fresh-DB pattern).
- GitHub CI (full pipeline incl. the real-browser E2E suite) **green on tip
  `c38ac41`**: push run `34681167041` and pull-request run `34681169648`.

### CI incidents and root causes (fixed, disclosed)

1. Run on `1d984da`: E2E audit assertion expected the seeded 5-day row to be
   the *only* row targeting the recoverable task, but the real API operations
   (`task.created`/`task.deleted`/`task.restored`) also audit those targets
   with recent timestamps and legitimately survive PRO 30-day retention.
   Spec fixed to scope the boundary assertions to the seeded `task.updated`
   action (`a3cd685`). No product change.
2. Run on `a3cd685`: the seeded 40-day row survived the purge in the shared
   CI database. Root cause: the audit candidate scan capped by **raw rows**
   (`ORDER BY workspace_id LIMIT 200`), so one tenant's rows could fill the
   entire budget and other tenants were never scanned; the read-side plan
   filter masked it in the API. Fixed to cap **distinct tenants** (`c38ac41`)
   with a dedicated regression test (busy tenant + next-run catch-up). The
   same run's `task-virtualization.spec.ts` focus assertion (passed in run 1,
   failed in run 2, passed in the fixed run; no UI code changed in this
   milestone) was a flake — confirmed by two consecutive green runs.

## Open policy decisions (not invented)

- `SECURITY_AUDIT_ACTIONS` is an explicit allowlist of the `account.*`
  security events; the PRD says "Security logs 1 year" without enumerating
  which events qualify. The list is documented in `retention.ts` and easy to
  extend — confirm with product which events are security-critical.
- Tasks referenced by an active parent (no-action FK) are **retained while
  referenced** rather than blocked from expiry; the PRD does not specify this
  case. Alternative (block the parent from the 30-day window) is a product
  decision.
- Legal-hold / enterprise custom retention (PRD §13.6, "7 years /
  negotiated") is not implemented — behavior undefined by the PRD.

## Next recommended milestone

M6-i7: account-deletion end-to-end (re-auth gate → grace window →
`purgeAccount` job → verification email suppression + restore path
acceptance), the last destructive data-rights surface before M6 closeout.
