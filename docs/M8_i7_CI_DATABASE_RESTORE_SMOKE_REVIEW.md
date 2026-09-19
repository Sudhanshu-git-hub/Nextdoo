# M8-i7 — CI database restore smoke coverage / release-gate hardening review

**Status:** REVIEW ONLY — no M8-i7 implementation started.
**Date:** 2026-09-19.
**Baseline:** M8-i6 is closed and CI-verified at `29cdf35` on branch
`arena/01a0ba0b-nextdoo`.

This document is a planning/review artifact only. It does not reopen M8-i6, does
not modify Calendar webhook replay/fairness behavior, does not retry live Google
verification, and does not change product behavior.

## 0. Initial verification

Verified before reviewing or editing documentation:

| Check | Result |
| --- | --- |
| Active branch | `arena/01a0ba0b-nextdoo` |
| Local HEAD | `29cdf35b9c6abddaef08a97f08467b1d43099b60` |
| Remote branch HEAD | `29cdf35b9c6abddaef08a97f08467b1d43099b60` via `git ls-remote origin refs/heads/arena/01a0ba0b-nextdoo` |
| Working tree | Clean before this review doc work |
| GitHub auth | `gh auth status` succeeded as `arena-ai-coding-agent[bot]` using `GH_TOKEN` |

One implementation detail: this checkout does not expose a local
`origin/arena/01a0ba0b-nextdoo` tracking ref after `git fetch`; remote equality was
therefore verified with `FETCH_HEAD` and `git ls-remote` instead of
`git rev-parse origin/arena/01a0ba0b-nextdoo`.

## 1. Sources reviewed

Reviewed or re-checked for this planning pass:

- `docs/PRD.md`, especially:
  - §11.4 data protection;
  - §11.9 privacy operations;
  - §12.2 recovery targets;
  - §12.3 backups;
  - §12.5 deployment;
  - §19.1 test categories;
  - §19.2 required acceptance test #14;
  - §19.4 release gates;
  - §21.4 public-beta / GA entry gates.
- `docs/M8_ROADMAP_AUDIT.md`, especially rows M3, R3, X4 and the release-gate
  inventory.
- `docs/M8_i6_REMAINING_HARDENING_REVIEW.md`, especially candidate H7.
- `docs/M8_i6_GOOGLE_CALENDAR_WEBHOOK_INGRESS_MILESTONE.md` only to confirm M8-i6
  is closed and the next recommendation is this release-gate hardening item.
- `.github/workflows/quality.yml` for current CI ordering, PostgreSQL service,
  migration step, lint/typecheck/coverage/build/E2E gates, and artifact policy.
- `packages/db/src/migrate.ts` and
  `packages/db/src/migrate.integrity.integration.test.ts` for migration runner
  behavior and existing migration integrity coverage.
- `packages/db/migrations/*` for the forward-only SQL chain and latest migration
  status.
- `tests/database.ts`, `tests/dedicated-database.ts`, `scripts/dev-services.mjs`,
  and `docs/DEVELOPMENT.md` for test database setup and local service behavior.
- `apps/web/src/app/api/v1/health/route.ts` for application/database readiness
  smoke suitability.
- Existing operational/audit documents:
  `docs/AUDIT_REMEDIATION_PLAN.md`, `docs/AUDIT_REMEDIATION_REPORT.md`,
  `docs/AUDIT_REMEDIATION_LOG.md`, and `docs/IMPLEMENTATION_LOG.md`.

## 2. Requirement / operational anchors

The database-restore candidate is not a convenience item; it is tied directly to
PRD release acceptance:

| Anchor | Requirement / implication |
| --- | --- |
| PRD §12.2 | Recovery targets: RTO 4 hours, RPO 15 minutes, attachment RPO 1 hour, regional recovery within RTO, daily backups retained 30 days. |
| PRD §12.3 | Continuous PITR, daily full backups, encrypted backup storage, separate backup credentials, monthly restore tests, quarterly disaster-recovery exercises, restore test results retained for audit. |
| PRD §12.5 | No destructive migration without a tested reversal or restore plan; automated backward-compatible migrations; health/readiness checks. |
| PRD §19.1 | Reliability testing includes restore and failover. |
| PRD §19.2 #14 | MVP cannot ship unless “Database restore has been tested successfully.” |
| PRD §19.4 | Migration safety requires a backward-compatible migration with tested rollback or restore plan. |
| PRD §21.4 public beta | Entry gate includes “restore test passed.” |
| PRD §21.4 GA | Entry gate includes “verified backup restore.” |
| PRD §11.9 | Deletion propagation to backups by backup-window expiry must be documented; this is production retention policy evidence, not just CI. |

`docs/M8_ROADMAP_AUDIT.md` records the same gap:

- M3: backups/monthly restore tests/RTO/RPO are externally blocked at production
  level, and §19.2 #14 is not yet satisfied.
- R3: “Database restore has been tested successfully” remains open.
- X4: production PITR/monthly restore/SLO/pen-test/status-page evidence requires
  production infrastructure and elapsed evidence windows.

`docs/M8_i6_REMAINING_HARDENING_REVIEW.md` candidate H7 narrows the implementable
slice: a deterministic CI `pg_dump`/restore smoke against the existing PostgreSQL
service, explicitly not a production PITR claim.

## 3. Current capability

| Capability | Current state |
| --- | --- |
| Fresh migrations | CI runs `pnpm db:migrate && pnpm db:migrate` against PostgreSQL 16. The second run proves idempotent “already up to date” behavior. |
| Migration safety | `runMigrations` takes a PostgreSQL advisory lock, applies SQL files transactionally, writes checksums, and rejects changed/missing applied migrations. |
| Migration tests | `migrate.integrity.integration.test.ts` proves concurrent runners coordinate and checksum drift is rejected using disposable databases. |
| Test database setup | CI provides a PostgreSQL 16 service. Local dev uses embedded PostgreSQL. Integration helpers can create/drop dedicated databases when the role has `CREATEDB`. |
| Application database readiness | `/api/v1/health` executes `SELECT 1` through the production DB client and returns `200` when database connectivity is healthy. |
| App build/start coverage | CI builds the Next app and runs full Playwright E2E, but not against a restored database. |
| Backup tooling | No repo script currently invokes `pg_dump`, `pg_restore`, provider snapshots, PITR, or backup validation. |
| Restore tooling | No repo script currently restores a dump into a fresh database and validates application compatibility. |
| Production/deployment backups | The repo documents the requirement but contains no production backup provider, no managed-PG PITR config, no encrypted backup bucket config, and no monthly restore evidence. |

## 4. Concrete gap

The current pipeline proves “fresh install + migrations + tests” but not “backup
artifact can be restored and used.” Specifically, the project does **not** yet
prove that:

1. A PostgreSQL backup artifact can be produced from a migrated NEXTDOO database.
2. That artifact can be restored into a fresh database.
3. The migration runner can apply real checked-in migrations after a restore.
4. A restored-and-migrated database can serve the application readiness path.
5. Representative rows and invariants survive dump/restore, including foreign
   keys, unique constraints, migration checksums, and sequence-backed tables.

This is materially different from the existing migration tests: they protect the
migration ledger and concurrent migration behavior, but they never exercise
PostgreSQL dump/restore tools or an application process pointed at a restored DB.

## 5. What can be tested deterministically in CI

A bounded CI smoke can be deterministic using only the existing PostgreSQL service
and native PostgreSQL logical backup tooling:

- Create disposable source and target databases with unique names.
- Apply all checked-in migrations except the latest to the source database.
- Seed non-secret representative data that exercises core relational structure
  available before the latest migration: user, workspace, membership, project,
  section, tags/task tags, tasks with due data, sync changes/tombstones,
  audit/outbox rows, and tracking events/results. After applying the full current
  migration chain, assert latest-migration tables/columns exist and accept a
  minimal valid non-secret row where appropriate.
- Produce a real PostgreSQL logical backup using `pg_dump -Fc --no-owner --no-acl`.
- Restore it into the target database using `pg_restore --exit-on-error
  --single-transaction --no-owner --no-acl`.
- Run the full current migration chain against the restored target, so the latest
  real checked-in migration is applied after restore.
- Assert migration ledger count/checksums, representative row counts, foreign-key
  survivability, uniqueness, sequence continuity, and expected post-latest schema
  existence.
- Start the already-built web application with `DATABASE_URL` pointed at the
  restored target and call `/api/v1/health`, requiring `checks.database = "ok"`.
- Drop disposable databases and delete the dump file at the end.

This is a real backup/restore smoke because it uses PostgreSQL’s dump and restore
format. It is not a fake JSON export, not an application-level user export, and
not a mocked backup provider.

## 6. What remains external / deployment-blocked

CI restore smoke cannot honestly satisfy production operations requirements that
need deployed infrastructure, provider controls, real backup credentials, or
elapsed operational evidence. The following must remain external until a
production-like environment exists:

- Managed PostgreSQL PITR configuration and proof that the recovery point meets
  the 15-minute transactional RPO.
- Daily full backup scheduling, retention for 30 days, encryption at rest, and
  separate backup credentials/IAM.
- Monthly restore drill evidence retained for audit.
- Quarterly disaster-recovery exercise, measured RTO, regional recovery, and
  failover/cutover runbooks.
- Restoration of attachment/object storage and verification of the 1-hour
  attachment RPO.
- Deletion propagation to backups by backup-window expiry and any legal-hold
  retention exceptions.
- Production app cutover to a restored database under real traffic.
- SLO dashboards, alerts, status-page/on-call proof, pen-test evidence, and
  30-day public-beta/GA operational windows.

## 7. Scope recommendation

Recommended M8-i7 scope: **(b) backup → restore → migration → application smoke
path**, bounded to CI and PostgreSQL logical backups.

Why not (a) migration/restore smoke only:

- A migration-only restore drill would improve coverage but still would not prove
  the restored database can boot the application readiness path.
- PRD §12.5 and §19.4 connect restore planning to deployment and readiness, so an
  app health smoke is a small but important addition.

Why not (c) a larger operational recovery exercise:

- The PRD’s PITR, encrypted backup storage, separate credentials, RTO/RPO, monthly
  restore evidence, regional failover, and attachment restore requirements need a
  deployed environment and real managed services.
- Inventing production backup infrastructure in this repo would be misleading and
  out of scope.

The bounded M8-i7 should therefore close the deterministic CI proof gap only. It
should explicitly avoid claiming production PITR or disaster-recovery readiness.

## 8. Proposed CI workflow

Proposed implementation shape for a later turn, not implemented here:

1. Add a script such as `scripts/db-restore-smoke.mjs` plus a root package script
   such as `db:restore-smoke`.
2. The script should require `DATABASE_URL` and use the same PostgreSQL service
   already present in `.github/workflows/quality.yml`.
3. Install or otherwise access PostgreSQL client tools in CI (`pg_dump`,
   `pg_restore`, `createdb/dropdb` or equivalent SQL commands). Prefer the
   PostgreSQL client version matching the CI service major version.
4. Workflow ordering:
   - existing `pnpm db:migrate && pnpm db:migrate` remains unchanged;
   - lint/typecheck/coverage/build remain unchanged;
   - after `pnpm build`, run `pnpm db:restore-smoke` so the script can also start
     the built app for `/api/v1/health`;
   - keep E2E after that step.
5. The script should create/destroy only uniquely named disposable databases and a
   dump file in `$RUNNER_TEMP` or the OS temp directory.
6. The dump artifact should not be uploaded by default, even though the data is
   synthetic.

Expected high-level command flow inside the script:

```text
source DB: apply migrations except latest -> seed representative rows -> pg_dump -Fc
target DB: create empty DB -> pg_restore -> run full migrations -> assert data/integrity
app smoke: start built web app with target DATABASE_URL -> GET /api/v1/health -> expect database ok
cleanup: stop app, drop DBs, delete dump
```

## 9. Test database and storage strategy

| Dimension | Proposed strategy |
| --- | --- |
| Database server | Reuse CI PostgreSQL service, currently PostgreSQL 16. |
| Privileges | CI role may have `CREATEDB`/drop for disposable DBs only; production app role does not need those privileges. |
| Source DB | Fresh throwaway DB migrated with all checked-in migrations except the latest. |
| Target DB | Fresh throwaway DB restored from the dump, then migrated with the full current chain. |
| Seed data | Synthetic non-secret fixtures with stable UUIDs/emails and placeholder password/token hashes; no OAuth tokens, no webhook secrets, no real customer data. |
| Dump file | Native PostgreSQL custom-format dump in temp storage; deleted after test; not uploaded. |
| App smoke | Use the already-built Next app and restored target DB; call `/api/v1/health`. |
| Cleanup | Drop source/target DBs with `FORCE` where supported; always close connections before dropping. |

Representative fixture should stay small but broad enough to catch missing tables,
foreign-key breakage, sequence issues, JSONB restore problems, enum migration
problems, and checksum-ledger drift. It should not require external providers,
object storage, ClamAV scanning, SMTP, Google, Stripe/Razorpay, or S3.

## 10. Acceptance criteria for M8-i7 implementation

A later implementation should be accepted only if all of the following are true:

1. Documentation remains clear that this is CI logical restore smoke, not
   production PITR/DR certification.
2. CI produces a real PostgreSQL dump artifact using native PostgreSQL tooling.
3. CI restores that artifact into a separate disposable database using native
   PostgreSQL tooling.
4. The full migration runner succeeds on the restored database after restore,
   including application of at least one real checked-in migration from the
   “source minus latest” baseline to current head.
5. The restored database has the expected current migration ledger entries and
   non-null checksums.
6. Representative seeded rows survive restore and can still be joined across core
   foreign-key relationships.
7. Sequence-backed tables continue with monotonically increasing values after
   restore.
8. A duplicate or invalid representative write still fails where uniqueness/check
   constraints require it, proving constraints survived.
9. The built web app starts against the restored database and `/api/v1/health`
   reports database connectivity as `ok`.
10. The CI workflow runs the restore smoke on every push/PR and fails loudly on
    any dump, restore, migration, integrity, or app-health failure.
11. The step logs no credentials, no raw connection URL passwords, and no real or
    synthetic secret values.
12. The smoke cleans up disposable databases and temp dump files on success and
    best-effort on failure.

## 11. Failure scenarios to cover or document

| Scenario | Expected behavior |
| --- | --- |
| `pg_dump` missing or incompatible | Step fails before claiming restore coverage. |
| Source DB cannot be created/migrated | Step fails and reports source setup failure. |
| Dump command exits non-zero | Step fails; no restore claim. |
| Restore into target exits non-zero | Step fails; target DB is dropped best-effort. |
| Migration checksum drift after restore | Existing migration runner rejects it; CI fails. |
| Latest migration fails on restored pre-latest data | CI fails, proving upgrade-after-restore incompatibility. |
| Foreign keys or representative joins are missing | Integrity assertions fail. |
| Sequences regress after restore | Monotonic insert assertion fails. |
| `/api/v1/health` cannot reach restored DB | App smoke fails. |
| Cleanup fails because a connection remains open | Script should close its own clients and then drop with force where possible; failure should be visible. |

## 12. Security and privacy considerations

- Never use production data or credentials in CI restore smoke.
- Do not upload the dump artifact by default. If future debugging requires upload,
  it must contain only synthetic data and should have short retention.
- Redact connection URLs and passwords from logs. Prefer logging database names,
  counts, and migration filenames only.
- Seed placeholder hashes/tokens only; do not generate real session tokens,
  OAuth tokens, webhook signing secrets, API keys, export tokens, or MFA secrets.
- The CI database role can have `CREATEDB` for isolated testing, but this must not
  become a production app-role requirement.
- The smoke does not prove encrypted backup storage, backup IAM separation, or
  deletion propagation through production backup retention windows.
- The script must avoid shell interpolation of untrusted database names; generate
  controlled identifiers and quote them safely.

## 13. Expected runtime / cost impact

Estimated additional CI cost for the bounded implementation:

- PostgreSQL client installation or availability check: 5–20 seconds if needed.
- Source DB migrate/seed/dump/restore/target migrate/assertions: 20–60 seconds with
  a tiny fixture.
- App health smoke using the already-built app: 10–30 seconds.
- Total expected additional runtime: roughly 1–2 minutes.
- Storage impact: a small temporary dump, expected well under 10 MB, deleted after
  the step.
- External service cost: none.

The current workflow timeout is 25 minutes and the latest M8-i6 CI completed in
about 8.5 minutes, so this bounded addition should fit without increasing timeout
unless future E2E load changes materially.

## 14. Explicit non-goals

- No production backup provider, PITR provider, object-storage backup system, or
  external backup service.
- No fake backup mechanism and no application JSON export masquerading as a
  database backup.
- No production data restore in CI.
- No product UI/API behavior changes.
- No schema changes unless a later implementation finds an unavoidable metadata
  need, which is not expected.
- No Calendar webhook replay/fairness changes and no M8-i6 reopening.
- No live Google, billing-provider, SMTP, or S3 verification.
- No k6/Lighthouse/load testing, SAST/secret scan, feature flags, canary, rollback
  runbook implementation, SLO dashboard, status page, or incident/on-call setup.
- No claim that monthly restore tests, quarterly DR exercises, RTO/RPO, or GA
  operational readiness are satisfied.

## 15. M8-i7 proposal summary

M8-i7 should implement a single release-gate hardening increment:

> Add deterministic CI database restore smoke coverage using native PostgreSQL
> dump/restore tooling, representative synthetic data, post-restore migration, and
> app readiness smoke against the restored database.

This closes the deterministic part of PRD §19.2 #14 and strengthens PRD §19.4
migration-safety evidence. It remains clearly bounded below PRD §12.3 production
PITR/monthly restore/DR requirements, which need real deployment infrastructure
and must stay external until those prerequisites exist.

## 16. Stop point

This review stops here. No M8-i7 implementation has started. The next turn may
implement this proposal only if explicitly directed.
