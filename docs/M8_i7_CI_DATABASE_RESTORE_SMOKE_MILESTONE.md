# M8-i7 — CI database restore smoke implementation milestone

**Date:** 2026-09-20
**Branch:** `arena/01a0ba0b-nextdoo`
**Scope:** bounded Option (b) from the approved review at `94062ed`: CI-local PostgreSQL backup → restore → migration → application smoke.
**Status:** implemented locally; GitHub CI evidence to be appended after push verification.

M8-i6 remains closed. This increment does **not** reopen Calendar webhook replay/fairness behavior, does **not** retry live Google verification, and does **not** implement production backup/PITR/DR infrastructure.

## 1. What shipped

### Script and package command

- Added `scripts/db-restore-smoke.mts`.
- Added root script:

```bash
pnpm db:restore-smoke
```

The package command runs the smoke through the existing `@nextdoo/db` toolchain (`tsx`) and uses the repository migration runner and production web app build.

### CI workflow

`.github/workflows/quality.yml` now runs the restore smoke after `pnpm build` and before Playwright E2E:

1. Existing `pnpm db:migrate && pnpm db:migrate` remains unchanged.
2. Existing lint, typecheck, coverage, and production build remain unchanged.
3. CI installs PostgreSQL client tools and prints `pg_dump`/`pg_restore` versions.
4. CI runs `pnpm db:restore-smoke`.
5. Existing full Playwright E2E still runs afterward.

This makes the restore smoke part of the authoritative push/PR quality gate.

## 2. Exact restore pipeline

The restore smoke uses the PostgreSQL service already available through `DATABASE_URL`.

1. **Migration boundary discovery**
   - Lists checked-in `packages/db/migrations/*.sql`.
   - Treats the lexicographically latest file as the post-restore migration boundary.
   - At implementation time the boundary is `0024_calendar_webhook_deliveries.sql`.

2. **Disposable source database**
   - Creates a uniquely named `nextdoo_restore_src_*` database through the admin database.
   - Builds a temporary migration directory containing every checked-in migration **except** the latest.
   - Applies those pre-latest migrations with the normal `runMigrations` implementation.
   - Verifies the pre-latest application count equals total checked-in migrations minus one.

3. **Synthetic non-secret seed data**
   - Seeds deterministic rows for:
     - `users`, `sessions`, `workspaces`, `workspace_members`;
     - `projects`, `sections`, `tasks`, `tags`, `task_tags`;
     - `sync_changes`, `sync_tombstones`;
     - `audit_logs`, `outbox`;
     - `tracking_events`, `tracking_results`;
     - `calendar_connections`, `calendar_events`, `calendar_mappings`.
   - Uses fixed synthetic UUIDs and `restore-smoke@example.test` only.
   - Uses placeholder hashes and one short-lived synthetic session token strictly for the app-read smoke.
   - Seeds no OAuth token, webhook secret, API key, MFA secret, billing credential, real user data, or production data.

4. **Real logical backup**
   - Runs native PostgreSQL custom-format backup:

```text
pg_dump -Fc --no-owner --no-acl --file <temp>/nextdoo-restore-smoke.dump \
  --host <host> --port <port> --username <user> --dbname <sourceDb>
```

   - Fails if the command exits non-zero or the dump artifact is empty.
   - Does not upload the dump artifact.

5. **Disposable target restore**
   - Creates a clean `nextdoo_restore_tgt_*` database.
   - Restores the dump with native PostgreSQL tooling:

```text
pg_restore --exit-on-error --single-transaction --no-owner --no-acl \
  --host <host> --port <port> --username <user> --dbname <targetDb> \
  <temp>/nextdoo-restore-smoke.dump
```

6. **Post-restore migration using normal command**
   - Runs the repository's normal migration command against the restored DB:

```bash
DATABASE_URL=<restored-target-url> pnpm --filter @nextdoo/db migrate
```

   - Asserts the output reports the latest checked-in migration.
   - Reruns the same command and asserts `Already up to date`.

7. **Data and integrity verification**
   - Compares deterministic source/restored fingerprints after restore and migration.
   - Verifies representative table counts remain one-for-one for each seeded domain.
   - Verifies migration ledger count equals the checked-in migration count.
   - Verifies every ledger row has a non-null checksum.
   - Verifies the latest migration is present exactly once in `_migrations`.
   - Verifies a duplicate workspace tag fails with SQLSTATE `23505`.
   - Verifies an invalid task workspace FK fails with SQLSTATE `23503`.
   - Inserts a new `sync_changes` row and asserts the sequence advances beyond the source max.
   - Inserts a representative `calendar_webhook_deliveries` row after migration `0024` to prove the latest migration table exists and accepts valid data.

8. **Application smoke**
   - Requires `pnpm build` to have created `apps/web/.next/BUILD_ID`.
   - Starts the built web app with the same production style used by CI E2E:

```text
pnpm exec next start -H 0.0.0.0 -p 3100
```

   - Points `DATABASE_URL` at the restored target database.
   - Calls `GET /api/v1/health` and requires HTTP success with `checks.database = "ok"`.
   - Calls `GET /api/v1/me` with the seeded synthetic session cookie and requires the restored synthetic profile (`restore-smoke@example.test`, `Restore Smoke User`).

9. **Cleanup**
   - Stops the production app process.
   - Drops source and target databases with `DROP DATABASE ... WITH (FORCE)` when they were created.
   - Removes the dump artifact and temporary migration directory.
   - Logs command stages, database names, counts, migration filenames and dump size only; password-bearing URLs and secret values are not logged.

## 3. Security and privacy controls

- No production data, customer data, provider credentials, real session secrets, OAuth tokens, webhook tokens or billing secrets are seeded.
- `pg_dump`/`pg_restore` receive the database password through `PGPASSWORD`; the script redacts those command arguments from logs.
- The temporary dump stays in OS temp storage and is deleted in `finally`; the workflow artifact upload path does not include it.
- Generated database names are controlled identifiers and quoted before SQL execution.
- Synthetic session token is used only inside the disposable restored database and is not emitted in logs.
- The CI database role's database-create/drop ability is only for disposable test databases and is not made a production app-role requirement.

## 4. Acceptance coverage mapping

| Required M8-i7 criterion | Implementation evidence |
| --- | --- |
| Disposable source + target DBs | `nextdoo_restore_src_*` and `nextdoo_restore_tgt_*` databases are created per run and dropped in cleanup. |
| Source applies all migrations except latest | Temporary pre-latest migration directory; applied count checked as `total - 1`. |
| Real logical backup | Native `pg_dump -Fc --no-owner --no-acl`; empty/non-zero backup fails. |
| Real restore | Native `pg_restore --exit-on-error --single-transaction --no-owner --no-acl`. |
| Normal post-restore migration | `pnpm --filter @nextdoo/db migrate` against restored target. |
| At least one checked-in migration after restore | Boundary is latest checked-in file; at implementation time `0024_calendar_webhook_deliveries.sql` applies post-restore. |
| Migration idempotency | Second normal migration command must print `Already up to date`. |
| Ledger/checksum behavior | `_migrations` count, latest row, and non-null checksum count are asserted. |
| Users/workspaces/account data | Synthetic user, session, workspace, membership and authenticated `/me` profile read. |
| Tasks/projects | Synthetic project/section/task/tag/task-tag graph and deterministic join fingerprint. |
| Calendar data | Synthetic connection/event/mapping restored; latest webhook-delivery row inserted after migration. |
| Unique constraints/indexes | Duplicate tag name in workspace must fail SQLSTATE `23505`. |
| Foreign keys | Invalid task workspace FK must fail SQLSTATE `23503`. |
| Sequence continuity | Post-restore `sync_changes` insert must produce a sequence above the pre-dump max. |
| Deterministic fingerprints | Source/restored joined row fingerprint and per-table counts must match. |
| Application health | Built `next start` process must return `/api/v1/health` with DB ok. |
| Authenticated restored-data read | `/api/v1/me` must return the seeded restored profile through the real auth path. |
| Cleanup | Temp DBs and dump/migration artifacts are cleaned in `finally`. |

## 5. Explicit non-goals preserved

This milestone does **not** implement or claim:

- production PITR;
- daily encrypted backup infrastructure;
- backup IAM or separate production backup credentials;
- monthly restore drill evidence;
- quarterly disaster-recovery exercises;
- measured RTO/RPO;
- regional failover/cutover;
- object-store/attachment byte restore;
- deletion propagation through production backup windows;
- status page, on-call, SLO dashboard, pen-test or GA operational certification;
- live Google verification;
- Calendar webhook replay/fairness changes beyond the already-closed M8-i6.

## 6. Local validation before first push

Completed locally in this sandbox:

- `pnpm install --frozen-lockfile` — pass.
- `pnpm exec tsc --noEmit --module NodeNext --moduleResolution NodeNext --target ES2022 --skipLibCheck --types node scripts/db-restore-smoke.mts` — pass.
- `pnpm lint` — pass.
- `pnpm typecheck` — pass (7 packages).
- `pnpm build` — pass.
- `pnpm test:unit` — pass (10 files / 227 tests).

Local limitations:

- `pnpm db:restore-smoke` could not complete locally because the sandbox has no running PostgreSQL server and no installable PostgreSQL client/server packages; `sudo apt-get install postgresql postgresql-client` failed because Debian package indexes were unreachable. The script reached configuration/source-creation and failed with `ECONNREFUSED`, which is expected without the service.
- `pnpm test:coverage` without `DATABASE_URL` failed on the existing database-backed integration suites that intentionally require PostgreSQL. CI provides the PostgreSQL service and is the authoritative full-suite environment.
- Targeted migration integration tests likewise require `DATABASE_URL`; they are expected to run in CI.

## 7. CI evidence

To be filled after the implementation is pushed and GitHub Actions completes on this branch.

## 8. Remaining release-gate gaps

The deterministic CI gap for "logical backup can be restored, migrated, and used by the app" is covered by this milestone. Remaining release-gate gaps are operational and require production-like infrastructure/evidence:

- managed PostgreSQL PITR and proof of 15-minute transactional RPO;
- daily encrypted full backups retained for 30 days with separate backup credentials/IAM;
- monthly restore drills retained for audit;
- quarterly DR exercise with measured RTO and regional recovery;
- attachment/object-store backup and restore validation;
- deletion-window semantics for backups/legal holds;
- production cutover/readiness proof after restore;
- SLO monitoring, alerting, status-page/on-call and pen-test evidence.

## 9. Next recommended milestone

After CI closes M8-i7, the next milestone should remain a separately authorized M8-i8 candidate from the audit/release-gate backlog. Do **not** start it in this increment.
