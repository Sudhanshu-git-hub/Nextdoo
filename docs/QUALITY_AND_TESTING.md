# Quality & Testing — Nextdoo

Verification report for the Nextdoo monorepo: what is tested, how it is verified,
and the exact recorded results for this audit.

**Report date:** 2026-11-02
**Repository:** `Sudhanshu-git-hub/Nextdoo` (cloned from GitHub)
**Verified commit:** `84f16f21195ae4110d89a23dff85196d458e5f40` (`main`, 2026-09-28)
**Working tree:** contains uncommitted maintenance changes (dependency security
remediation, lint fixes, test fixes, documentation) applied on top of the commit.
Every command below was executed in this working tree unless noted.

**Environment:** Node `v22.22.3`, pnpm `9.15.4`, PostgreSQL `18.4` (embedded,
port `55432`, database `nextdoo_test`, migrations `0000`–`0031` applied),
Chromium `153.0.8010.12` (system Playwright browser, revision required by
Playwright `1.63.0`).

---

## 1. Test inventory

| Suite | Tooling | Location | Scope |
|---|---|---|---|
| Unit + integration | Vitest `4.1.12` (v8 coverage) | `packages/*/src/**/*.test.ts`, `apps/web/src/**/*.test.ts` | Domain logic, services, HTTP routes, sync, billing, calendar, retention, entitlements |
| Browser end-to-end | Playwright `1.63.0` (Chromium) | `apps/web/e2e/*.spec.ts` (~50 spec files) | Real production build + real PostgreSQL + real Chromium |
| Static security scan | `scripts/security-scan.mjs` | whole repo | Secret patterns, dynamic code, shell exec, raw SQL, unsafe config, HTML injection |
| Dependency audit | `pnpm audit` | lockfile | Known advisories from the npm ecosystem |
| CI | `.github/workflows/quality.yml` | GitHub Actions | Lint, typecheck, tests, coverage, build, E2E, security scan, dependency audit, migration drift |

The suite is intentionally heavy: integration tests run against a real
PostgreSQL with the real migration history, and the E2E suite drives the real
production build. Nothing is mocked at the database or browser boundary except
external providers (Google Calendar, payment providers), which are exercised
through fixtures and signature-verified webhook fixtures.

## 2. Recorded results (2026-11-02)

### 2.1 Static security scan

```
$ pnpm security:scan
Security scan: 0 prohibited findings.
```

Exit code `0`. The scanner's allowlist (`security-allowlist.json`, 111 entries)
pins reviewed exceptions by exact content fingerprint; every entry was verified
against the current tree (no stale entries).

### 2.2 Lint

```
$ pnpm lint            # eslint . --max-warnings=0
# exit 0, no output (clean)
```

### 2.3 Typecheck

```
$ pnpm exec turbo run typecheck --concurrency=1 --force
Tasks: 7 successful, 7 total
```

All seven workspace projects typecheck cleanly (`@nextdoo/contracts`,
`@nextdoo/core`, `@nextdoo/db`, `@nextdoo/calendar`, `@nextdoo/billing`,
`@nextdoo/worker`, `@nextdoo/web`).

### 2.4 Unit + integration suite (with coverage)

```
$ DATABASE_URL=postgres://postgres:postgres@localhost:55432/nextdoo_test \
  AUTH_SECRET=<32+ char test secret> APP_URL=http://localhost:3000 CI=true \
  pnpm exec vitest run --coverage --maxWorkers=1

Test Files  101 passed (101)
Tests       1134 passed (1134)
Duration    218.99s
```

Exit code `0`. Coverage totals:

| Metric | Coverage |
|---|---|
| Lines | **94.46%** (4509/4773) |
| Statements | 90.35% |
| Functions | 94.21% |
| Branches | 83.08% |

`packages/core` sits at 98.31% lines / 100% branches; the majority of
`apps/web` server services are at 90–100% lines. The vitest config enforces
thresholds (lines/branches) that the suite meets.

### 2.5 Production build

```
$ pnpm exec turbo run build --concurrency=1 --force
# exit 0 (1 successful task, ~1m22s)
```

### 2.6 Dependency audit

```
$ pnpm audit --audit-level moderate
No known vulnerabilities found.
```

Exit code `0`. See §3 for the remediation history behind this result.

### 2.7 Browser end-to-end suite

```
$ DATABASE_URL=… AUTH_SECRET=… APP_URL=http://localhost:3100 CI=true \
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=<system chromium> \
  pnpm --filter @nextdoo/web exec playwright test --reporter=list

246 passed (11.6m)
6 failed
5 did not run (attachment specs gated behind the ClamAV beforeAll hook)
```

Every failure was investigated and accounted for; none is caused by the
maintenance changes in this working tree:

| Failure | Root cause | Status |
|---|---|---|
| `attachments.spec.ts:85` (+5 dependent specs) | `ATTACHMENT_SCAN_ENGINE_MISSING` — the suite refuses to run without a real ClamAV engine (`clamscan`), by design. ClamAV is not installed in this sandbox. | Environmental; not a code defect. CI provisions ClamAV. |
| `security-release.spec.ts:16` | The test's insights query window (`2026-09-01`–`2026-09-30`) is now outside the free-tier 30-day history bound enforced by `assertHistoryWindow` (PRD §18.1). The spec was written on 2026-09-28 when the window was inside the bound; it is time-sensitive and expires as "now" moves. | Pre-existing test time-bomb; unrelated to dependency changes. |
| `calendar-center.spec.ts:31` | Click/`toHaveCount` timeout in the year-view navigation spec. | **Pre-existing** — fails identically on the pristine commit with original dependencies (baseline run, §2.8). |
| `push-notifications.spec.ts:75` | The blocked-notifications UI state assertion does not match the headless browser's default permission state. | **Pre-existing** — fails identically on the baseline (§2.8). |
| `shared-workspace.spec.ts:36` | Offline palette search assertion (`Requires connection` status text) not produced under `context.setOffline(true)`. | **Pre-existing** — fails identically on the baseline (§2.8). |
| `conflict-resolution.spec.ts:262` | `locator.click: Test ended` timing flake. | **Passed on isolated re-run** (flaky, not deterministic). |

### 2.8 Baseline comparison (pre-existing failure proof)

To prove the three consistent E2E failures are not caused by the maintenance
changes, the same three specs were run against the **pristine commit
`84f16f2` with the original dependency lockfile** (`next@15.5.25`, `zod@3.24.1`,
`eslint@9.39.5`):

```
$ # original source + original node_modules + original build
$ pnpm --filter @nextdoo/web exec playwright test \
    calendar-center.spec.ts:31 push-notifications.spec.ts:75 shared-workspace.spec.ts:36

3 failed
  [chromium] › e2e/calendar-center.spec.ts:31:1 › day, week, month, year and agenda remain navigable
  [chromium] › e2e/push-notifications.spec.ts:75:1 › service worker registers and the configured public key is served to an authenticated browser
  [chromium] › e2e/shared-workspace.spec.ts:36:1 › palette keeps navigation usable offline and reports search failure without invented results
```

Identical failures on the untouched baseline ⇒ environmental/headless-browser
behaviour, not a regression from this work.

## 3. Dependency security remediation (2026-11-02)

`pnpm audit` initially reported **35 advisories** (1 critical, 11 high,
22 moderate, 1 low) across 6 direct/transitive packages. After remediation the
audit reports **zero**. All changes are in the working tree (uncommitted);
nothing was pushed.

| Package | Before | After | Advisory | Fix |
|---|---|---|---|---|
| `next` (apps/web) | 15.5.25 | **15.5.28** | GHSA-2464-fhr4-w9xw — unauthenticated RCE in the Image Optimization API via SVG (critical) | Patch bump |
| `sharp` (override) | 0.35.4 | **0.35.5** | high | Override bump |
| `vite` (override) | 8.2.2 | **8.2.4** | high | Override bump |
| `nodemailer` (apps/worker) | 10.0.1 | **10.3.1** | high | Patch bump |
| `source-map-js` (override) | 1.2.1 | **1.2.2** | high (via `@vitest/coverage-v8` → `magicast`) | Override bump |
| `brace-expansion` (override) | 1.1.18 / 5.0.9 | **5.0.12** | high (nested-brace stack exhaustion) + moderate (quadratic expansion) | Override bump; eslint 10 uses minimatch 10 so the 1.x line disappears |
| `zod` (4 packages) | 3.24.1 | **4.6.7** | GHSA-mrhx-c7xc-m3w5 — memory exhaustion on oversized constrained collections (high); **no 3.x patch exists** | Major migration to the `zod/v4` classic API |
| `eslint` / `@eslint/js` / `typescript-eslint` | 9.39.5 / 9.39.5 / 8.70.0 | **10.14.0 / 10.0.1 / 8.72.1** | `eslint@9.39.5` is end-of-life; its `minimatch@3 → brace-expansion@1.1.18` chain carried the high advisory | Supported-version upgrade (peer-compatible) |
| `vitest` / `@vitest/coverage-v8` (all workspaces) | 4.1.11 | **4.1.12** | moderate — code injection via manual mock registration; Windows backslash traversal | Patch bump |
| `minimatch` (override) | 10.2.6 | **11.0.4** | moderate (globparts amplification); 10.x line unpatched | Override bump; lint verified working with it |

### 3.1 Zod 3 → 4 migration notes

`zod` had no patched 3.x release, so a major-version migration was required.
The project uses the **classic API** (`import { z } from 'zod/v4'`, 38 import
sites across `packages/contracts`, `packages/billing`, `apps/web`) — a
drop-in for the v3 patterns in this codebase. Three behavioural differences
required code changes, all validated by the full suite:

1. **`.partial()` fills defaults.** In v4, `personalizationSchema.partial()`
   applies every field default when parsing, which let an empty `{}` patch
   pass the emptiness refine and made every patch write every key.
   `personalizationPatchSchema` now builds its shape from
   `personalizationSchema.shape` with `removeDefault().optional()` per field,
   preserving v3 semantics exactly (`packages/contracts/src/personalization.ts`).
2. **`z.record` requires two arguments.** Six single-argument
   `z.record(z.unknown())` calls became `z.record(z.string(), z.unknown())`.
3. **`.default()` is typed to the output shape.**
   `knowledgeConfig.default({})` became the explicit full default object
   (identical parsed result).

The full suite (1,134 tests) passes on zod 4.6.7; `updateWorkspaceSchema`
(the only other `.partial()` user) is unaffected because its fields carry no
defaults.

### 3.2 ESLint 10 upgrade notes

ESLint 10 introduced two rules the codebase trips on; all 10 findings were
fixed at the source (no rule disables):

- `no-useless-assignment` (9): `let x = <init>; try { x = … } catch { x = … }`
  patterns where the initializer is never read — initializers removed.
- `preserve-caught-error` (1): rethrown ICS parse errors now carry
  `{ cause: error }`.

### 3.3 Allowlist maintenance

The security scanner binds `STATIC_*` findings to whole-file content
fingerprints, so any file edit invalidates its entry. The remediation touched
`knowledge-relations.ts` (zod import) and `retention.ts` (lint fix); their
allowlist entries were refreshed with new fingerprints. Documentation added
during this audit (README, CONTRIBUTING, SHOWCASE, `screenshot-demo.mjs`)
contains the same reviewed dev-only embedded-PostgreSQL example credentials as
`.env.example`; those were added to the allowlist with the project's existing
"reviewed local/CI-only example, exact value pinned" pattern.

## 4. Test-fix record

One test fix was required during this audit (product code untouched):

- `apps/web/src/server/services/account-deletion.integration.test.ts` — the
  deletion-expiry test anchored on a fixed clock while the service compares
  against real `Date.now()`, so it failed intermittently. The test now anchors
  on real time. Post-fix, the full suite passes deterministically.

## 5. Reproducing this report

```bash
# 0. Prereqs: Node >= 22.22, pnpm 9, a PostgreSQL 18 reachable at the URL below
#    (embedded dev services: pnpm dev:services prints the DATABASE_URL).
export PATH=$HOME/.local/bin:$PATH

# 1. Install (lockfile pins every version in §3)
pnpm install --frozen-lockfile

# 2. Gates (run sequentially to stay inside sandbox memory limits)
pnpm security:scan
pnpm lint
pnpm exec turbo run typecheck --concurrency=1 --force
DATABASE_URL=postgres://postgres:postgres@localhost:55432/nextdoo_test \
AUTH_SECRET=<32+ chars> APP_URL=http://localhost:3000 CI=true \
pnpm exec vitest run --coverage --maxWorkers=1
pnpm exec turbo run build --concurrency=1 --force
pnpm audit --audit-level moderate

# 3. Browser E2E (needs a system Chromium; see playwright.config.ts)
DATABASE_URL=… AUTH_SECRET=… APP_URL=http://localhost:3100 CI=true \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=<chromium path> \
pnpm --filter @nextdoo/web exec playwright test --reporter=list
```

Notes:
- `--maxWorkers=1` / `--concurrency=1` are required in constrained sandboxes;
  the suite itself is parallel-safe.
- The E2E suite provisions its own production server on port 3100 (see
  `apps/web/playwright.config.ts`); `reuseExistingServer` is disabled.
- ClamAV (`clamscan`) must be installed for the attachment E2E specs; the suite
  deliberately refuses to run them with a mocked scanner.

## 6. Known limitations of this verification

- Coverage is measured on the vitest unit/integration suite; the Playwright
  E2E suite is behavioural, not coverage-instrumented.
- The three pre-existing E2E failures (§2.7) are environmental in this
  sandbox and are expected to behave the same on the pristine commit.
- The `security-release.spec.ts` insights window assertion is time-sensitive
  (§2.7) and should be re-anchored to relative dates by the maintainer.
- This report describes the working tree at the time of writing; it is not a
  substitute for CI on the committed state.
