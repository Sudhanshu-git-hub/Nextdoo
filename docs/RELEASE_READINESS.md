# NEXTDOO Release Readiness Assessment

Date: 2026-11-02. Baseline commit: `84f16f2` (plus the test-defect fix in this increment). Prepared as part of the open-source repository upgrade. This assessment does **not** authorize a release; the maintainer decides when (or whether) to release.

## Verdict

**Not ready for a first public release.** The application implements a substantial, tested personal core, but several release criteria are unmet — primarily provider acceptance, production operations evidence, and a public deployment. Publishing a release now would overstate the product's actual state. The open-source repository itself (code, docs, CI, license) is ready for public contribution.

## Criteria assessment

| Criterion | Status | Evidence / blockers |
|---|---|---|
| Installation reliability | ⚠️ Partially met | `pnpm install --frozen-lockfile` succeeds; Node 22.22+ and pnpm 9.15.4 are required and documented. Embedded PostgreSQL removes the DB prerequisite for development. |
| Environment configuration | ✅ Met | `.env.example` documents required (`DATABASE_URL`, `AUTH_SECRET`, `APP_URL`) and optional settings; `docs/DEVELOPMENT.md` explains provider gating. |
| Database migrations | ✅ Met | 32 checksummed, forward-only SQL migrations; fresh-install and replay verified; runner serializes with a session lock and verifies checksums. |
| Authentication and authorization | ✅ Met (bounded) | Argon2id, email verification, reset, TOTP MFA, sessions, owner-scoped isolation, durable backoff. Bounded: no breached-password screening; session policy review outstanding. |
| Security controls | ⚠️ Partially met | Deterministic secret/static scan (0 findings), dependency audit gate, ClamAV gating, ASVS-oriented control matrix. Outstanding: live Google webhook channel credentials, managed secrets/rotation, independent assessment. See [SECURITY.md](../SECURITY.md). |
| Core user workflows | ✅ Met | Tasks, projects, goals, trackers, knowledge, calendar (native/ICS), insights, settings, offline capture, sync — all with database-backed tests and browser E2E. |
| Data integrity | ✅ Met (bounded) | Transactional outbox, idempotent writes, optimistic versioning, append-only history, correction workflow, account purge. Backup/PITR and legal retention remain external. |
| Automated test results | ✅ Met | Current exact-commit run: lint, typecheck (7 packages), 1,134 unit/integration tests, coverage thresholds green, build, migrations — see [QUALITY_AND_TESTING.md](QUALITY_AND_TESTING.md). Browser E2E evidence recorded separately. |
| Known bugs | ⚠️ Partially met | One date-dependent test defect found and fixed in this increment (test only, no product impact). Outstanding: Google provider fixes (F3 protocol repairs), broader contract coverage. |
| Deployment configuration | ❌ Not met | No deployment target, container image, or hosting configuration exists. No public URL. |
| Documentation accuracy | ✅ Met | PRD, DEVELOPMENT, ROADMAP, MAINTENANCE, QUALITY_AND_TESTING, SHOWCASE, CONTRIBUTING, SECURITY, templates — all reviewed against implementation in this increment. |
| Licensing | ✅ Met | MIT License applied (Copyright 2026 Sudhanshu Kumar); ownership confirmed by the maintainer. |

## Remaining release blockers (must be addressed before a public release)

1. **Deployment** — a hosting target, TLS, trusted ingress, and configuration for a real deployment.
2. **Google Calendar** — remains `GOOGLE_CALENDAR_ENABLED=false`; live OAuth/webhook acceptance outstanding (or explicitly dropped from the release scope).
3. **Provider integrations** — SMTP delivery, browser push, billing, and S3 storage require deployment configuration and provider acceptance, or must remain gated.
4. **Production operations** — encrypted backups/PITR, restore rehearsal, RTO/RPO, monitoring/alerting, load testing, rollback drill.
5. **Security qualification** — managed secrets/rotation, DB TLS, and (recommended) an independent security assessment for the deployed system.
6. **Release checklist sign-off** — the maintainer must review and accept the checklist in [MAINTENANCE.md](MAINTENANCE.md).

## Recommended next steps

1. Deploy to a staging environment behind TLS with the documented configuration.
2. Run the full verification suite against the staging deployment (database, migrations, provider acceptance where enabled).
3. Rehearse backup/restore and rollback.
4. Re-run this assessment against the deployment; then the maintainer decides on a tagged release.
5. Version proposal if released: **v0.1.0** (first public release, no prior releases). The changelog records Unreleased work only until then.

## Explicitly not claimed

- No release, tag, or version has been published.
- No public deployment exists.
- No stars, forks, users, downloads, or usage statistics are claimed.
- The test count here is from the current exact commit, not copied from historical milestones.
