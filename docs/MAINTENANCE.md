# NEXTDOO Maintenance

This document describes the real maintenance process for NEXTDOO: how issues are handled, what versions are supported, the security policy, and how releases work. It reflects the actual practice of the maintainer, Sudhanshu Kumar (see [MAINTAINERS.md](../MAINTAINERS.md)).

## Maintenance process

- **Development happens on `main` with focused branches.** Feature branches follow the naming convention in [CONTRIBUTING.md](../CONTRIBUTING.md) (`feat/`, `fix/`, `docs/`, `security/`, etc.) and are merged after review.
- **Every merged change must pass the repository gates.** The maintainer runs the full chain locally before merging: security scan, dependency audit, migrations, lint, typecheck, coverage, build, and browser E2E. CI provides the same gates on GitHub.
- **No silent failures.** Database-backed tests fail when the database is unavailable. A test that cannot run is a failure, not a skip.
- **Milestone records are written at delivery time.** Each bounded increment gets a milestone report under `docs/` recording implementation boundaries, tests, and remaining work — so the next session can trust the ledger instead of re-deriving it.
- **Historical evidence is preserved.** Milestone counts and statuses are historical snapshots; the current verification record lives in [QUALITY_AND_TESTING.md](QUALITY_AND_TESTING.md) and CI.

## Issue handling

- The maintainer triages all issues: labels, categorization, and close decisions (duplicate/invalid/out-of-scope) are made with an explanation.
- **Bugs** get the bug-report template; reproduction steps, expected vs. actual behavior, and environment details are required for actionable work.
- **Feature requests** are assessed against the PRD and roadmap before acceptance. Accepted work appears in [ROADMAP.md](ROADMAP.md) with its milestone and acceptance criteria.
- **Security reports** never go through public issues. They are received privately via the repository's GitHub Security Advisories tab and triaged first — see [SECURITY.md](../SECURITY.md).
- Issues that cannot be acted on (externally blocked) are labeled and referenced from the roadmap rather than silently dropped.

## Supported versions

- The `main` branch is the only supported line. There are no stable releases yet, so there are no maintenance branches and no backport policy.
- Package manifests carry `0.1.0` for internal workspace identification only; it is **not** a published version.
- When the first release is published, this section will list supported minor versions and their support window (security fixes, no feature backports unless stated).

## Security policy

- **Vulnerability reporting:** private reports via the repository's GitHub Security Advisories tab (https://github.com/Sudhanshu-git-hub/Nextdoo/security/advisories) or by contacting the maintainer through GitHub. See [SECURITY.md](../SECURITY.md) for what to include and the expected response process.
- **Repository gates:** every change must pass the deterministic secret/static security scan (`pnpm security:scan`, 0 prohibited findings), the dependency audit (`pnpm audit --audit-level high`, no high findings), and the ASVS-oriented control review for security-sensitive changes.
- **Bounded scope:** the security scanner and control matrix are repository-level evidence, not certification. They do not replace deployment controls (TLS, managed secrets, backups), provider acceptance, or independent assessment.
- **Current boundaries:** Google Calendar is withheld from the first release (`GOOGLE_CALENDAR_ENABLED=false`); provider webhooks, SMTP, push, billing, and S3 require deployment configuration and acceptance evidence before they are enabled.
- **Disclosure:** confirmed vulnerabilities are disclosed privately to the maintainer, fixed, and documented in the changelog and security advisories. Public discussion follows the maintainer's assessment.
- **Incidents:** if a real deployment is ever compromised, the maintainer rotates affected credentials, assesses scope, and discloses through GitHub Security Advisories. (No incident has occurred; this procedure is documented for completeness.)

## Release approach

- **Releases are made only when the release checklist passes.** The checklist:
  1. Full CI green on the release commit (security scan, audit, migrations, lint, typecheck, coverage, build, ClamAV malware gate, restore smoke, browser acceptance).
  2. All open release blockers in [SECURITY.md](../SECURITY.md) reviewed and either closed or explicitly accepted by the maintainer.
  3. Google Calendar remains `GOOGLE_CALENDAR_ENABLED=false` unless its acceptance track has passed.
  4. No provider integration claimed without provider acceptance evidence.
  5. Changelog updated with the release notes; version tagged.
  6. Documentation reviewed for accuracy against the release commit.
- **No release is published without the maintainer's explicit decision.** Automated work (agents, bots) never publishes releases.
- **Rollback:** deployment rollback and migration rollback rehearsals remain outstanding operational gates; the forward-only migration runner requires a documented restore procedure before any production rollback.
- **Demo/status:** if a public demo is published, its URL, sign-in requirements, and feature scope are documented in [docs/SHOWCASE.md](SHOWCASE.md) and the README. Today, no public deployment exists.

## Maintenance health

| Area | Current state |
|---|---|
| Commit activity | Active; 140 commits on `main` since 2026-09-08 |
| Issue triage | Maintainer-managed; new templates added for community reports |
| CI | Full pipeline on every push/PR; failures are visible and cannot be converted to passes |
| Test suite | ~1,134 unit/integration tests + browser E2E suite; re-verified on exact commits |
| Documentation | PRD + 50+ milestone/audit docs; README/CONTRIBUTING/MAINTENANCE updated in this increment |
| Contributing | Open; see [CONTRIBUTING.md](../CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) |
