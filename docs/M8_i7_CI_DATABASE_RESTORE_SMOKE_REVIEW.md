# M8-i7 — CI database restore smoke coverage / release-gate hardening review

**Status:** IMPLEMENTED (bounded Option (b): CI backup → restore → migration → application smoke).
**Review baseline:** `94062edf7ed2c2eb0d4cbbb5a640e101d05f16fa`.
**Date:** 2026-09-20.
**Implementation milestone:** [M8_i7_CI_DATABASE_RESTORE_SMOKE_MILESTONE.md](M8_i7_CI_DATABASE_RESTORE_SMOKE_MILESTONE.md).

M8-i6 remains closed. This work does not reopen Calendar webhook replay/fairness behavior, does not retry live Google verification, and does not change product behavior. It implements the deterministic CI-local restore-smoke slice only.

## 1. Approved scope from the review

The approved implementation was **Option (b): backup → restore → migration → application smoke path**, bounded to CI and PostgreSQL logical backups.

The review rejected:

- option (a), because migration-only restore smoke would not prove that the restored DB can serve the application readiness path; and
- option (c), because production PITR/DR certification requires deployed infrastructure, provider backup controls, credentials, evidence windows, RTO/RPO measurement and operational runbooks.

## 2. Requirement / operational anchors

This work supports, but does not fully certify, the PRD release-gate requirements around database restore:

| Anchor | Relevance |
| --- | --- |
| PRD §12.2 | Recovery targets exist, but RTO/RPO measurement remains production-operational. |
| PRD §12.3 | Backups and restore drills are required; CI smoke covers only logical dump/restore. |
| PRD §12.5 | Migrations need a tested restore plan; this adds post-restore migration proof. |
| PRD §19.1 | Reliability testing includes restore/failover; this adds restore testing. |
| PRD §19.2 #14 | MVP cannot ship unless database restore has been tested successfully; this covers the deterministic CI-local database restore test. |
| PRD §19.4 | Migration safety requires compatible migrations and tested rollback/restore planning. |
| PRD §21.4 | Public-beta/GA gates require restore/backup evidence; production evidence remains external. |

`docs/M8_ROADMAP_AUDIT.md` still records production backup/PITR/monthly restore/DR evidence as deployment-blocked. M8-i7 closes only the deterministic CI proof gap.

## 3. Gap closed by M8-i7

Before this increment, CI proved fresh migrations, migration idempotency, migration checksum integrity, unit/integration coverage, production build and E2E. It did **not** prove that:

1. a PostgreSQL backup artifact can be produced from a migrated NEXTDOO database;
2. that artifact can be restored into a clean database;
3. the normal migration runner can apply a checked-in migration after restore;
4. restored data still has representative integrity, constraints and sequence continuity; or
5. the built application can start and read authenticated restored data from the restored database.

M8-i7 adds that proof path to CI.

## 4. Implementation summary

### Files changed

- `scripts/db-restore-smoke.mts` — narrowly scoped restore-smoke runner.
- `package.json` — root `db:restore-smoke` script.
- `.github/workflows/quality.yml` — installs PostgreSQL client tools and runs restore smoke after `pnpm build` and before E2E.
- `docs/M8_i7_CI_DATABASE_RESTORE_SMOKE_MILESTONE.md` — implementation/evidence record.
- `docs/IMPLEMENTATION_LOG.md` — ledger entry.

### Pipeline

```text
source DB: apply all migrations except latest -> seed synthetic rows -> pg_dump -Fc
target DB: create empty DB -> pg_restore -> normal pnpm db migration -> idempotent rerun
assertions: ledger/checksums/data/fingerprints/FKs/unique constraints/sequences/latest table
app smoke: next start -H 0.0.0.0 -p 3100 -> /api/v1/health -> authenticated /api/v1/me
cleanup: stop app, drop temp DBs, delete dump/temp migrations
```

At implementation time the source/target migration boundary is:

- source: migrations `0000` through `0023`;
- post-restore target: normal migration applies `0024_calendar_webhook_deliveries.sql`;
- rerun: `Already up to date`.

## 5. Synthetic data and assertions

The fixture is deterministic, small and non-secret. It covers:

- account/auth path: user, session, workspace, workspace member;
- planning path: project, section, task, tag, task-tag;
- sync/audit/integration path: sync change, tombstone, audit log, outbox;
- tracking path: tracking event and tracking result;
- Calendar path: connection, imported event and mapping;
- latest migration path: `calendar_webhook_deliveries` insert after `0024` applies.

The smoke verifies:

- source/restored row counts and deterministic joined fingerprint;
- `_migrations` row count, latest migration presence and non-null checksums;
- uniqueness via duplicate tag SQLSTATE `23505`;
- FK enforcement via invalid task workspace SQLSTATE `23503`;
- sequence continuity via post-restore `sync_changes` insert returning a value greater than the pre-dump max;
- `/api/v1/health` database status `ok`;
- authenticated `/api/v1/me` restored-profile read using the seeded synthetic session.

## 6. Security and privacy posture

- `pg_dump` and `pg_restore` are real native PostgreSQL commands; no mocks or SQL fixture substitution.
- Password-bearing connection URLs are not logged. PostgreSQL tool passwords are passed through `PGPASSWORD`; command arguments are redacted in script logs.
- The dump artifact is temporary and deleted; CI artifacts do not upload it.
- No production data, customer data, OAuth tokens, webhook tokens, MFA secrets, API keys or billing credentials are seeded.
- Generated database names are controlled identifiers and quoted.
- Cleanup runs in `finally` and best-effort drops created source/target DBs with `WITH (FORCE)`.

## 7. Validation status

Local validation completed before first push:

- `pnpm install --frozen-lockfile` — pass.
- Restore-smoke script compile check with NodeNext TypeScript options — pass.
- `pnpm lint` — pass.
- `pnpm typecheck` — pass.
- `pnpm build` — pass.
- `pnpm test:unit` — pass (10 files / 227 tests).

Local environment limitations:

- `pnpm db:restore-smoke` requires a live PostgreSQL server plus `pg_dump`/`pg_restore`. The sandbox had neither, and `sudo apt-get install postgresql postgresql-client` could not use Debian package indexes (`Connection failed` / package not found). A local dry attempt reached source DB creation and failed with `ECONNREFUSED`, as expected without the service.
- `pnpm test:coverage` without `DATABASE_URL` fails on the existing database-backed integration suites that intentionally require PostgreSQL. GitHub CI provides that service and remains authoritative for full coverage/migration/restore/E2E verification.

Implementation push CI succeeded: run `35464236805` (`push`) on commit `919faf3a0b65f6e2bceb03969cbed09fc6034d1c`, job `verify` / `105953402824`, result SUCCESS. The new `Smoke PostgreSQL backup restore and post-restore migration` step passed, followed by full Playwright E2E and artifact upload.

## 8. Remaining external / deployment-blocked work

This CI smoke does not satisfy the production operational requirements that need real infrastructure and elapsed evidence windows:

- managed PostgreSQL PITR and proof of 15-minute RPO;
- daily full encrypted backups retained for 30 days;
- separate backup credentials/IAM;
- monthly restore drill evidence retained for audit;
- quarterly disaster-recovery exercise;
- measured RTO and regional failover/cutover;
- attachment/object-store restore and 1-hour attachment RPO;
- deletion propagation through backup windows and legal-hold policy;
- production app cutover to a restored DB;
- SLO dashboards, alerting, status page, on-call, pen-test and GA readiness evidence.

## 9. Stop point

M8-i7 stops at bounded CI restore-smoke implementation and verification. Do not start M8-i8 in this increment.
