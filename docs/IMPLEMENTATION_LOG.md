# Approved continuation: quality gates and integrity only

Baseline: `49b2e68`, preserved on remote `feat/mvp-implementation`. Work stays on
`arena/01a080d5-nextdoo`. No history rewrites or later product-feature implementation.

## Phase 1 — quality gates

- Real ESLint checks now run; removed unused imports/dead declarations, not working behavior.
- Integration tests fail if DATABASE_URL or the migrated database is unavailable.
  `test:unit` remains intentionally database-free.
- V8 coverage includes core and server services. Core thresholds are 85% on all four metrics.
- Playwright isolates E2E discovery, uses a real production server/database/browser and unique accounts.
- CI provisions PostgreSQL 16/UTF-8 and runs installation, audit, migration replay,
  lint, typecheck, coverage, build and E2E. Remote CI is not claimed executed until pushed/run.
- Dependencies upgraded compatibly: Next stays on 15, React on 19, Drizzle remains ORM;
  Vitest/Playwright/build tooling patched. Explicit Sharp/PostCSS/Vite pins cover transitive findings.
- Removed obsolete Drizzle Kit generator, replacing it with a tested, exclusive-write,
  nonzero-on-error **manual SQL scaffold** consistent with the existing migration workflow.
- Documentation now distinguishes actual services from reserved config and placeholders.

Verification: 193 tests passed (baseline 191 plus two migration-tool tests), 2 real
Chromium E2E passed, lint/typecheck/build passed. Core: 99.50% lines, 96.45%
statements, 85.58% branches, 100% functions. Full dependency audit: **0 findings**
(previously 4 critical/17 high; production previously 2 critical/16 high).

Environment: standard Playwright CDN download failed ECONNRESET. Locally ran real
Chromium 149 from a registry-distributed binary via executable-path override and
its native libraries; no API mocks or disabled browser security. CI installs the
standard Playwright browser. Local DB is PostgreSQL 18.4 UTF-8; CI specifies 16.

## Phase 2

Pending. Add failing regressions before changing affected behavior; tenant isolation
is a release blocker. Do not interpret Phase 1's green baseline as security acceptance.
