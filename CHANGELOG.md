# Changelog

All notable changes to the NEXTDOO project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
when releases are published.

> **Release status:** No releases have been published yet. The project is under
> active development and has not been released publicly. Package manifests
> currently carry the `0.1.0` version for internal workspace identification only.
> Entries below describe repository work, not published releases.

## [Unreleased]

### Added

- **Licensing:** Added the MIT License (`LICENSE`, Copyright 2026 Sudhanshu Kumar) and documented it in the README. The project's own source code is original and may be used, modified, and redistributed under MIT terms; third-party dependencies retain their own licenses.
- **Community documentation:** Added [CONTRIBUTING.md](CONTRIBUTING.md) (prerequisites, setup, branch naming, commit conventions, code quality requirements, testing, migration expectations, pull request process, security-sensitive contribution restrictions), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) (Contributor Covenant 2.1), [MAINTAINERS.md](MAINTAINERS.md) (actual ownership and maintenance responsibilities), and this changelog.
- **GitHub templates:** Added bug report, feature request, and pull request templates under `.github/ISSUE_TEMPLATE/` and `.github/PULL_REQUEST_TEMPLATE.md`.
- **Repository docs:** Added [docs/ROADMAP.md](docs/ROADMAP.md), [docs/MAINTENANCE.md](docs/MAINTENANCE.md), [docs/QUALITY_AND_TESTING.md](docs/QUALITY_AND_TESTING.md), and [docs/SHOWCASE.md](docs/SHOWCASE.md).
- **Verification evidence:** Added [docs/QUALITY_AND_TESTING.md](docs/QUALITY_AND_TESTING.md) recording current exact-commit verification results (commands, environment versions, test counts, coverage).

### Fixed

- **Test defect (date-dependent anchor):** `account-deletion.integration.test.ts` — the "reset/verification emails: issuable during the grace window" test anchored the deletion request to a fixed clock (`NOW - 1 day`), while the service suppression check (`deletionExpired`) evaluates against real time. The anchor drifted out of its 30-day validity window and the test began failing on real dates after 2026-10-11. The in-window step now anchors to the actual current time; the exact-boundary assertions keep the fixed reference. No product code changed. Found by re-running the full suite on 2026-11-02; suite was 1,133 passed / 1 failed before the fix and is re-verified after the fix.

### Security

- **Dependency advisory remediation (35 → 0):** `pnpm audit` previously reported 35 advisories (1 critical, 11 high, 22 moderate, 1 low). All are resolved in the working tree:
  - **Critical:** `next` `15.5.25` → `15.5.28` (GHSA-2464-fhr4-w9xw — unauthenticated RCE in the Image Optimization API via SVG).
  - **High:** `sharp` → `0.35.5`, `vite` → `8.2.4`, `nodemailer` → `10.3.1`, `source-map-js` → `1.2.2`, `brace-expansion` → `5.0.12` (pnpm overrides), and `zod` `3.24.1` → `4.6.7` (GHSA-mrhx-c7xc-m3w5 — no patched 3.x release exists; see Changed below).
  - **Moderate/high via toolchain:** `eslint` `9.39.5` (end-of-life) → `10.14.0`, `@eslint/js` → `10.0.1`, `typescript-eslint` → `8.72.1`, `vitest`/`@vitest/coverage-v8` → `4.1.12`, `minimatch` → `11.0.4` (override; the 10.x line is unpatched).
  - After remediation `pnpm audit --audit-level moderate` reports **No known vulnerabilities found**; `pnpm security:scan` reports **0 prohibited findings** (allowlist refreshed for touched files and reviewed dev-only documentation examples).
  - Full details, including the zod 3→4 migration notes and the E2E baseline comparison, are in [docs/QUALITY_AND_TESTING.md](docs/QUALITY_AND_TESTING.md).

### Changed

- **Zod 3 → 4 (classic API):** All 38 `import … from 'zod'` sites in `packages/contracts`, `packages/billing`, and `apps/web` now import from `zod/v4` (drop-in for this codebase's v3 patterns). Behavioural differences handled: `personalizationPatchSchema` rebuilds its shape with `removeDefault().optional()` per field (v4 `.partial()` fills defaults, which would have accepted empty patches and written every key on every patch); six `z.record(z.unknown())` calls now pass an explicit key type; `knowledgeConfig.default({})` uses the explicit full default object. Full suite (1,134 tests) passes on zod 4.6.7.
- **ESLint 10 upgrade:** `eslint` 9.39.5 → 10.14.0 with `@eslint/js` 10.0.1 and `typescript-eslint` 8.72.1 (peer-compatible). Ten new-rule findings fixed at the source: nine `no-useless-assignment` (dead initializers in try/catch patterns removed) and one `preserve-caught-error` (rethrown ICS parse errors now carry `{ cause }`).
- **Embedded dev PostgreSQL data directory ignored:** `.pgdata-test/` added to `.gitignore` so the test database directory is never committed or stashed accidentally.

## [Historical development notes]

The following entries are derived from the repository's Git history (first commit
2026-09-08). They describe development work that is already merged; none of it has
been published as a tagged release.

### 2026-09-08 — Initial implementation

- Added the NEXTDOO product requirements document (PRD v1.3) and technical blueprint.
- Added the MVP implementation: accounts and authentication (email/password, verification, reset, MFA, sessions), core task management (capture, edit, projects, sections/board, tags, priorities, due dates, subtasks/dependencies), reminders, focus timers, weekly task calendar, and execution-tracking foundations.
- Established the real quality gates (ESLint, TypeScript, Vitest, Playwright, Turborepo) and remediated dependency advisories.
- Added the M1–M6 milestone line (sync protocol, conflict resolution, durable tracking, analytics/reporting, billing scaffolding, account data rights, exports, entitlements).

### 2026-09-21 — Main repository consolidation

- Consolidated the development branches into `main`; preserved all implementation lineages and historical milestone evidence.
- Fixed a disclosed pre-existing test defect in the M8-i6 concurrent-delivery regression (fixed-clock anchor drift); the mock anchor now uses the actual current time.

### 2026-09-24 to 2026-09-28 — Personal core completion (PC1–PC7) and release hardening

- Added Goal Center (PC1), configurable Trackers (PC2), Knowledge & Data (PC3), shared personal workspace (command palette, shared search, task relationships, calendar layers, Home), Calendar Center (PC5), cross-module Insights (PC6), Settings/Account/Personalization (PC7), Focus execution workflows, and shared-workspace completion.
- Hardened release boundaries: OAuth state consumption, attachment finalization serialization, credential-field redaction, deterministic secret/static CI checks.
- Withheld Google Calendar from the first release (`GOOGLE_CALENDAR_ENABLED=false` default) per the pre-launch correctness closure.
