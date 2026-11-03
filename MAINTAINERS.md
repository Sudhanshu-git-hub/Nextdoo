# Maintainers

This document describes actual project ownership and maintenance responsibilities for NEXTDOO. It describes the roles the real maintainer performs today — no responsibilities are assigned that do not exist.

## Primary maintainer

**Sudhanshu Kumar**

- GitHub: [Sudhanshu-git-hub](https://github.com/Sudhanshu-git-hub)
- Role: sole human maintainer and owner of the repository
- Contact: via GitHub (issues, pull requests, and the repository's GitHub Security Advisories tab)

Sudhanshu is the author of the NEXTDOO product vision ([docs/PRD.md](docs/PRD.md)) and the implementing developer across the repository's commit history.

## Responsibilities

### Architecture

- Owns the product scope and architecture described in the PRD and reflected in the monorepo layout (`apps/web`, `apps/worker`, `packages/*`).
- Decides on technology choices and architectural direction (Next.js App Router, PostgreSQL/Drizzle, hand-authored SQL migrations, Turborepo, Vitest/Playwright gates).
- Reviews and approves structural changes before they land.

### Code review

- Reviews all pull requests before merging. The maintainer is the final review authority.
- Enforces the code quality requirements in [CONTRIBUTING.md](CONTRIBUTING.md) and the security boundaries in [SECURITY.md](SECURITY.md).
- Retains the authority to reject changes that weaken correctness, data integrity, or security even if tests pass.

### Issue triage

- Monitors and triages incoming issues (bugs, feature requests, security reports).
- Categorizes and labels issues, closes duplicates/invalid reports with explanation, and tracks accepted work in the roadmap.
- Security reports received privately through GitHub Security Advisories are triaged first and never discussed in public issues.

### Security maintenance

- Owns the security posture documented in [SECURITY.md](SECURITY.md) and the ASVS-oriented control matrix ([docs/M8_i8_SECURITY_CONTROL_MATRIX.md](docs/M8_i8_SECURITY_CONTROL_MATRIX.md)).
- Maintains the repository secret/static security scan (`pnpm security:scan`) and its reviewed allowlist (`security-allowlist.json`); reviews and rotates any genuine credentials discovered.
- Decides on security remediation priorities and approves security-sensitive changes.
- Manages the security policy, including the release-readiness register and the current release boundary (Google withheld, provider gating).

### Testing and regression responsibility

- Owns the verification gates: CI runs the full pipeline (security scan, dependency audit, migrations, lint, typecheck, coverage, build, ClamAV malware gating, restore smoke, first-attempt browser acceptance).
- Ensures new features and fixes carry real tests (unit, database-backed integration, browser E2E) rather than configuration-only claims.
- Investigates CI failures and regressions; requires exact-commit evidence before milestone closure.

### Release responsibility

- Sole authority to publish releases, tags, and public deployments.
- Maintains the release checklist and release policy in [docs/MAINTENANCE.md](docs/MAINTENANCE.md) and the changelog in [CHANGELOG.md](CHANGELOG.md).
- Decides when release criteria are met; no release is published until the documented gates pass.

### Decision-making process

- The maintainer makes final decisions on product scope, architecture, roadmap priorities, and release readiness.
- Community input (issues, pull requests, discussions) is considered, but no decision is delegated without an explicit maintainer handoff.
- Decisions affecting the PRD scope or release boundaries are recorded in the PRD's decision register or the roadmap.

## Delegation

Sudhanshu may delegate specific maintenance tasks (e.g., triaging a subset of issues, reviewing a pull request) to trusted contributors. Delegated work does not transfer ownership; the maintainer remains the final authority. Document any delegation here as it happens.

## Contributors

The repository history credits the following commit authors:

- **Sudhanshu Kumar** — primary developer and maintainer
- **Arena Agent / arena-ai-coding-agent** — automated coding agent commits made under maintainer authorization during development sessions

Contributors who have submitted merged pull requests are credited in the repository's contributor graph. This project is young: the maintainer is the sole human contributor to date.
