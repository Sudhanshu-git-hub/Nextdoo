# M8-i8 — Remaining release-gate hardening review

**Status:** REVIEW ONLY — no implementation started.
**Date:** 2026-09-20.
**Branch:** `arena/01a0ba0b-nextdoo`.
**Baseline after verification:** M8-i7 CLOSED and CI-verified at `09ea72e3b6f99d2b7c38c1b95f0bcf238b580514`.

This document does not reopen M8-i7, does not modify the database restore smoke, and does not retry live Google verification. It is a planning/review artifact for the next possible release-gate hardening increment.

## 0. Initial verification

The first check found the local workspace stale relative to the closed M8-i7 tip:

| Check | First result |
| --- | --- |
| Active branch | `arena/01a0ba0b-nextdoo` |
| Local HEAD | `bc4fd902125efc2d5e50bd82efaea6699afcd559` |
| Remote branch HEAD | `09ea72e3b6f99d2b7c38c1b95f0bcf238b580514` via `git ls-remote origin refs/heads/arena/01a0ba0b-nextdoo` |
| Working tree | Dirty, containing stale M8-i6/M8-i7 implementation files from the older local checkout |
| GitHub auth | `gh auth status` succeeded as `arena-ai-coding-agent[bot]` using `GH_TOKEN` |

To honor the user's M8-i7 baseline (`09ea72e`) and avoid modifying stale local files, the checkout was aligned to the remote tip with:

```bash
git fetch origin refs/heads/arena/01a0ba0b-nextdoo
git reset --hard FETCH_HEAD
git clean -fd
```

Final verified baseline before this review doc work:

| Check | Final result |
| --- | --- |
| Active branch | `arena/01a0ba0b-nextdoo` |
| Local HEAD | `09ea72e3b6f99d2b7c38c1b95f0bcf238b580514` |
| Remote branch HEAD | `09ea72e3b6f99d2b7c38c1b95f0bcf238b580514` |
| Working tree | Clean |
| GitHub auth | OK |

## 1. Sources reviewed

Reviewed or re-checked for this planning pass:

- `docs/PRD.md`, especially §§11.4, 11.8, 11.9, 12.1–12.6, 19.1, 19.2 #14, 19.4, 21.4, 21.7, and SD-02.
- `docs/M8_ROADMAP_AUDIT.md`, especially rows L5, M2–M6, R3/R5 and X4.
- `docs/M8_i5_GOOGLE_CALENDAR_LIVE_UNBLOCK_PREFLIGHT.md`.
- `docs/M8_i6_REMAINING_HARDENING_REVIEW.md`, especially H8–H12.
- `docs/M8_i7_CI_DATABASE_RESTORE_SMOKE_MILESTONE.md`.
- `.github/workflows/quality.yml` and root `package.json` scripts.
- Current security/release documentation: `docs/AUDIT_REMEDIATION_PLAN.md`, `docs/AUDIT_REMEDIATION_REPORT.md`, `docs/IMPLEMENTATION_LOG.md`, and the closed M8 milestone docs.
- Existing release/quality scripts: `scripts/perf-baseline.mjs`, `scripts/db-restore-smoke.mts`, migration tooling, and E2E failure annotation workflow support.

## 2. Classification legend

The user's requested classifications are used in the matrix below:

1. **PRD-required** — directly required by PRD/security/release text.
2. **Security-required** — required to satisfy security assurance or materially reduce security risk.
3. **Reliability/release hardening** — release-quality hardening, not necessarily a product feature.
4. **External/deployment blocked** — cannot be honestly completed in this sandbox without deployed infrastructure, provider accounts, vendor services, or elapsed evidence windows.
5. **Optional/convenience** — useful but not required by the cited PRD/release gate.
6. **Phase 2/deferred** — explicitly Phase 2/3 or previously deferred by directive/decision.

Rows may carry multiple classifications. `Should be M8-i8?` means this review's recommendation for the **next** bounded implementation increment, not a statement that the candidate is unimportant.

## 3. Current quality/release evidence summary

Current CI (`.github/workflows/quality.yml`) already runs:

- PostgreSQL 16 service with UTF-8 database;
- install + frozen lockfile;
- Playwright browser install;
- real ClamAV install and EICAR detection;
- `pnpm audit --audit-level high`;
- `pnpm db:migrate && pnpm db:migrate`;
- `pnpm lint`;
- `pnpm typecheck`;
- `pnpm test:coverage`;
- `pnpm build`;
- PostgreSQL client install;
- `pnpm db:restore-smoke` from M8-i7;
- full Playwright E2E with retries;
- coverage/Playwright artifact upload.

Current root scripts include `lint`, `typecheck`, `test:coverage`, `build`, `test:e2e`, `db:migrate`, and `db:restore-smoke`.

Not currently present in CI/repo:

- formal ASVS L2 control map;
- deterministic first-party secret scan;
- explicit SAST gate beyond TypeScript/ESLint and tests;
- container image build/scan;
- k6 load test;
- Lighthouse/web-vitals gate;
- production monitoring dashboard evidence;
- status page/on-call evidence;
- incident response runbooks tied to named rotations;
- production PITR/backup/IAM/RTO/RPO evidence;
- third-party penetration-test evidence.

M8-i7 materially changes the old audit state: PRD §19.2 #14 now has deterministic CI logical database restore smoke coverage. Production backup/DR evidence remains external.

## 4. Complete remaining release-gate matrix

| ID | Candidate | Classification | Exact anchor | Current implementation status | Existing evidence | Concrete remaining gap | Deterministically implementable in CI? | Requires deployed production infrastructure? | Should be M8-i8? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| RG1 | Production PITR / managed database backup strategy | **1**, **3**, **4** | PRD §§12.2, 12.3, 21.4; audit M3/X4 | No production managed-PG backup config in repo; M8-i7 covers CI logical restore only | M8-i7 CI `pg_dump`/`pg_restore` smoke is green | Need managed PostgreSQL PITR design, retention, access controls and provider evidence | No. A design/runbook can be documented, but PITR proof cannot be produced in CI | Yes | No — document as external blocker; do not fake with CI |
| RG2 | Daily encrypted backups | **1**, **2**, **4** | PRD §§11.4, 12.2, 12.3 | No production backup service/bucket/provider config | M8-i7 dump is temporary synthetic CI-only and not encrypted backup storage | Need daily full backup schedule, encryption at rest, retention proof | No, except policy documentation | Yes | No |
| RG3 | Backup IAM / separate backup credentials | **1**, **2**, **4** | PRD §§11.4, 12.3 | No production IAM/credential architecture in repo | App secrets patterns and envelope encryption exist for app data; no backup IAM evidence | Need separate backup identity, least privilege, rotation, break-glass policy | No, except architecture/runbook documentation | Yes | No |
| RG4 | Recurring restore evidence / monthly restore tests | **1**, **3**, **4** | PRD §12.3; §21.4 public-beta/GA gates | M8-i7 provides a deterministic CI restore smoke on every push/PR | CI runs `pnpm db:restore-smoke`; runs `35464236805`, `35464738765`, `35465103463` green | Need monthly production-like restore drill evidence retained for audit | CI can prove repeatable logical restore, but not monthly production evidence | Yes, plus elapsed calendar time | No |
| RG5 | RTO/RPO measurement | **1**, **3**, **4** | PRD §12.2; §21.4 | No production measurement harness/evidence | Sync SLO harness exists; M8-i7 verifies restore compatibility | Need measured RTO 4h, transactional RPO 15m, attachment RPO 1h | No | Yes | No |
| RG6 | Regional failover / regional recovery | **1**, **3**, **4** | PRD §§12.2, 12.3, 21.4 | No multi-region deployment or failover config | None in repo; PRD marks regional recovery requirement | Need region topology, replication, cutover runbook, timed exercise | No | Yes | No |
| RG7 | Attachment/object-store restore | **1**, **3**, **4** | PRD §§6.8, 11.4, 12.2, 12.3 | Attachment pipeline and clean-only downloads exist; production object store is deployment config | CI verifies ClamAV/EICAR and attachment E2E; M8-i7 restores metadata only, not object bytes | Need object-store backup/restore validation and attachment RPO evidence | Only metadata restore is CI-proven; real object restore requires storage backend | Yes | No |
| RG8 | Deletion-window backup semantics | **1**, **2**, **4** | PRD §11.9; §12.2 retention subject to privacy/legal requirements | Account deletion/export/retention technical paths exist; backup-window semantics not decided/proven | M6 retention/deletion evidence; audit docs flag legal/backup policy open | Need documented production policy for deletion propagation to backups, legal hold exceptions and backup expiry | Policy doc could be written, but evidence requires production backup system | Yes / legal-operational | No unless explicitly a policy-doc milestone; not selected now |
| RG9 | Status page | **1**, **3**, **4** | PRD §§12.6, 21.4, 21.7 | No status-page provider/config/evidence | None | Need live status page and status-page communication process | No, except draft docs | Yes | No |
| RG10 | SLO/monitoring dashboards and 30-day evidence | **1**, **3**, **4** | PRD §§12.1, 19.4, 21.4, 21.7 | Request IDs/logs/metrics-style events exist; no production dashboard backend/evidence | M2 instrumentation; M5 sync SLO harness; health route | Need production dashboards, alerting backend, 30 days meeting SLOs | No for 30-day evidence; dashboards-as-code only if a backend is chosen | Yes | No |
| RG11 | Alerts tested / job alert routing | **1**, **3**, **4** | PRD §§12.4, 19.4 | Jobs log and return failure/dead-letter state; no routed alert backend | Worker/job integration tests verify retries/dead letters | Need alert destinations, test pages, escalation and job SLA alert proof | Only local log assertions are CI-testable | Yes | No |
| RG12 | Incident / on-call runbooks | **1**, **3**, **4** | PRD §§12.6, 21.4, 21.7 | No complete incident-response/on-call runbook set in repo | Some milestone docs record failures and debugging patterns | Need SEV taxonomy procedures, named owner/escalation, customer notification timelines, on-call rotation | Draft runbooks are docs-only; real rotation/evidence is external | Partly | Not selected; viable later docs-only ops increment |
| RG13 | ASVS Level 2 mapping | **1**, **2**, **3** | PRD §11.8; §19.1 security; §19.4 security; SD-02 | Security tests exist but no formal ASVS L2 mapping | Auth, request-security, isolation, rate-limit, attachment and webhook tests; `pnpm audit` | Need mapped control inventory linking implemented surfaces to tests/files and explicitly marking unsupported/external controls | Yes | No for mapping itself | **Yes** |
| RG14 | SAST gate | **1**, **2**, **3** | PRD §11.8; §19.1 security; §19.4 security | TypeScript + ESLint + tests run; no explicit SAST step | ESLint catches many correctness issues; audit catches dependencies | Need a deterministic static security gate for high-risk patterns/known classes, with documented limitations | Yes, if bounded to a first-party rule set or CI-available scanner | No for baseline; vendor dashboards are external | **Yes**, as bounded baseline |
| RG15 | Secret scanning / push protection | **1**, **2**, **3**, partly **4** | PRD §11.8; §19.4 security; §11.4 secrets not stored plainly | No first-party CI secret scan; no evidence of GitHub push protection setting | `.gitignore` and docs patterns; no committed obvious production secrets; dependency audit only | Need CI check for private keys, provider tokens, forbidden env files and high-confidence secret patterns; push-protection setting remains platform config | Yes for repo scan; push protection itself is external repo setting | Push protection setting: yes; repo scan: no | **Yes** for repo scan; note push protection external |
| RG16 | Container image scanning | **1**, **2**, **4** | PRD §11.8 | No container image build in CI and no production image artifact in repo | None | Need image build target and scanner results | Not until image build exists | Usually yes/deployment pipeline | No |
| RG17 | Pen-test evidence | **1**, **2**, **4** | PRD §11.8; §21.4 GA; §21.7 | None | Security tests are deterministic but not a pen test | Need annual third-party pen test and enterprise-GA pre-test, with findings remediated | No | Yes / vendor | No |
| RG18 | k6 load testing | **1**, **3**, **4** | PRD §19.1 reliability/performance; §19.4 performance | No k6 scripts/workflow | `scripts/perf-baseline.mjs`; M5 sync SLO harness | Need staging load test for API latency and reliability/fault behavior | Minimal smoke can be CI, but release criterion needs staging-like environment | Yes for authoritative gate | Not selected; future performance increment |
| RG19 | Lighthouse / web-vitals gate | **1**, **3** | PRD §19.1 performance; §19.4 web vitals budget | No Lighthouse CI | Playwright E2E and production build | Need stable browser performance budget and artifacts | Yes, but can be flaky and should be scoped | No for CI smoke; production RUM external | Not selected; future performance increment |
| RG20 | Feature flags / kill switches | **1**, **3** | PRD §12.5; §19.4 rollback readiness | No general feature-flag or kill-switch system | Some features gate on provider config; no platform-level flag system | Need concrete kill-switch behavior for risky features or a minimal flag contract | Yes if tied to specific path | No | Not selected; too open-ended without a target feature |
| RG21 | Canary deployment | **1**, **3**, **4** | PRD §12.5 | No deployment environment in repo | None | Need canary deployment procedure and proof | No | Yes | No |
| RG22 | Rollback procedure verified / deployment audit trail | **1**, **3**, **4** | PRD §12.5; §19.4 rollback readiness | Migration checksums and restore smoke exist; no deployment rollback drill | Migration integrity tests; M8-i7 restore smoke | Need deploy rollback runbook and timed verification in target environment | Runbook yes; verification no | Yes for verification | Not selected |
| RG23 | Production managed secrets/TLS/encryption-at-rest evidence | **1**, **2**, **4** | PRD §11.4 | App has secure coding patterns; production secrets manager/TLS/encryption evidence absent | OAuth envelope encryption tests; auth token hashing; signed URLs | Need managed secrets, TLS/HSTS deployment, infrastructure encryption proof | No | Yes | No |
| RG24 | Live provider verification (Google, billing, SMTP, S3/object store) | **1** for those surfaces, **4** | PRD §§6.6, 6.8, 16, 18; M8 audit X1–X3; M8-i5 | Fixture/unit/integration coverage exists; live Google remains blocked; live billing/SMTP/S3 also external | M8-i5 preflight; M6/M7 fixture evidence | Need provider credentials, egress, public hosts, provider accounts and deployment configuration | No | Yes | No; do not retry live Google |
| RG25 | Support documentation and response targets | **1**, **3**, partly **4** | PRD §§19.4, 21.4, 21.7 | Many milestone docs exist; no support runbook/targets package | Implementation log and milestones capture engineering evidence | Need support docs, known-issues/status process, response targets | Docs yes; enforcement/evidence external | Partly | Not selected |
| RG26 | Database restore acceptance after M8-i7 | **1**, **3**; no longer a remaining CI gap | PRD §19.2 #14; §19.4 migration safety | Implemented in M8-i7; workflow runs `pnpm db:restore-smoke` | CI runs `35464236805`, `35464738765`, `35465103463` green | Production PITR/verified backup restore remains external (see RG1–RG4) | Already implemented; do not modify | Production evidence yes | No; closed |

## 5. Selected M8-i8 proposal

### Exact selected scope

Recommended M8-i8 implementation, if separately authorized:

> **Security assurance CI baseline:** add a formal ASVS Level 2 mapping for implemented surfaces and a deterministic CI security scan that covers repo-local secret scanning plus a bounded static security rule set.

This selects **RG13, RG14 and RG15** only.

Proposed implementation shape for a later turn:

1. Add `docs/ASVS_L2_MAPPING.md` (or similarly named M8-i8 milestone doc section) mapping implemented controls to evidence:
   - authentication/session/MFA/account deletion;
   - authorization/object isolation;
   - input validation and request boundaries;
   - CSRF/origin/CORS/security headers;
   - password/token/OAuth storage;
   - attachment malware/download gating;
   - webhook verification/dedupe/fairness;
   - rate limits and audit logging;
   - backup/restore distinction and external controls explicitly marked.
2. Add a first-party deterministic scan script and root package command, for example `pnpm security:scan`, covering:
   - committed private keys/certificates and forbidden `.env` files;
   - high-confidence provider token patterns for Google/Stripe/Razorpay/SMTP/S3/VAPID/GitHub;
   - generic high-entropy assignment patterns with an allowlist for documented test fixtures and placeholders;
   - static security red flags such as `eval`/`new Function`, browser `innerHTML`/`dangerouslySetInnerHTML` without the existing sanitizer, unsafe shell/process usage outside documented server/script allowlists, and weak crypto patterns in production code.
3. Add unit tests/fixtures for the scanner so that it fails on planted sample secrets and passes documented placeholders.
4. Add the CI step after `pnpm audit --audit-level high` and before the expensive test/build/E2E steps.
5. Update documentation to state exactly what the scan does and does not prove.

### Why this is selected

- It is explicitly required by PRD §11.8 and §19.4.
- It is security-relevant and deterministically implementable in CI without production infrastructure.
- It complements the existing dependency audit; it does not duplicate M8-i7 restore smoke.
- It does not require live Google, billing, SMTP, S3, status-page, monitoring, on-call, production backup or pen-test vendors.
- It improves release evidence while honestly keeping external items external.
- It is narrower and less environment-sensitive than k6/Lighthouse/load/staging work.

## 6. M8-i8 acceptance criteria

A later M8-i8 implementation should be accepted only if all of the following are true:

1. A formal ASVS L2 mapping document exists and maps implemented controls to concrete code/tests/docs.
2. The mapping explicitly marks controls that remain external, deployment-only, legal/ops-only, Phase 2, or not implemented; it must not claim certification or a pen test.
3. A deterministic security scan command exists and is documented in `package.json`.
4. The scan fails on planted sample private keys/tokens/env files in test fixtures.
5. The scan passes the current repository without allowing broad exemptions.
6. Any allowlist entries are narrow, documented, and limited to synthetic fixtures, examples, or known safe test strings.
7. The scan covers both high-confidence secret patterns and bounded static security red flags.
8. The CI workflow runs the scan on every push/PR before expensive build/E2E work.
9. Existing `pnpm audit --audit-level high`, lint, typecheck, coverage, build, restore smoke and E2E gates remain intact.
10. No product behavior changes are introduced merely to satisfy the scan.
11. No real secrets or credentials are added to the repo or CI logs.
12. Documentation remains clear that third-party pen testing, GitHub push-protection settings, container image scanning, production secrets managers and production monitoring evidence remain separate external release gates.

## 7. Test and evidence strategy for the selected scope

| Layer | Evidence |
| --- | --- |
| Scanner fixture tests | Tiny fixture files that intentionally contain representative private-key/token/env patterns and unsafe static-code patterns; test asserts non-zero exit and stable finding codes. |
| Repository scan | `pnpm security:scan` passes on the clean repo and prints only file paths/finding IDs, not secret values. |
| ASVS mapping review | Each mapped ASVS area links to existing tests/milestones or explicitly marks external/not-applicable. |
| CI | Push/PR run shows `pnpm security:scan` green before full suite; existing audit/lint/typecheck/coverage/build/restore/E2E remain green. |
| Security posture | No claim of ASVS certification, no claim of third-party SAST equivalence if a custom scanner is used, and no claim of pen-test completion. |

## 8. Explicit non-goals for M8-i8

- No production PITR, backup service, encrypted backup bucket, backup IAM, monthly restore evidence, quarterly DR exercise, RTO/RPO measurement, or regional failover implementation.
- No changes to `scripts/db-restore-smoke.mts`, `pnpm db:restore-smoke`, or M8-i7 workflow behavior except that a new security scan step may run earlier in CI.
- No live Google verification retry and no T3 channel-token implementation.
- No billing/Stripe/Razorpay live verification.
- No SMTP/S3 production setup.
- No status-page/on-call/monitoring vendor setup.
- No third-party penetration test claim.
- No container image scanning unless a real production image build is introduced in a separate deployment milestone.
- No k6 or Lighthouse gate in M8-i8.
- No feature-flag/canary/rollback platform in M8-i8.

## 9. External blockers kept outside M8-i8

| Blocker | Why outside M8-i8 |
| --- | --- |
| Production backup/PITR/RTO/RPO/failover | Needs managed infrastructure and evidence windows; CI smoke already covers deterministic logical restore. |
| Status page, on-call rotation, 30-day SLO evidence | Needs operational systems and elapsed time. |
| Pen-test evidence | Needs third-party security engagement and remediation cycle. |
| GitHub push protection setting | Repository/org setting, not a code-only change; CI scan can complement it but not prove it. |
| Container image scanning | Requires a production image build target/pipeline. |
| Live Google/billing/SMTP/S3 | Requires credentials, egress/ingress and provider accounts; M8-i5 remains blocked. |

## 10. Expected operational impact if M8-i8 is implemented

- CI runtime: expected +10–90 seconds for first-party scanning; more if a third-party scanner is selected later.
- Developer workflow: new failures on committed secrets or high-risk static patterns; small allowlist maintenance cost.
- Runtime impact: none; no production code path needs to change for a scan-only increment.
- Release impact: improves security release-gate evidence for PRD §11.8/§19.4 while preserving honest external blockers.

## 11. Deferred candidates

Deferred to later, separately authorized increments:

- RG1–RG8: production backup/PITR/object-store/delete-window semantics.
- RG9–RG12/RG25: status page, monitoring, SLO evidence, incident/on-call/support docs.
- RG16–RG17: container image scanning and third-party penetration test evidence.
- RG18–RG19: k6 and Lighthouse performance gates.
- RG20–RG22: feature flags, canary and rollback/deployment verification.
- RG23–RG24: production managed secrets/TLS/infrastructure and live provider verification.

## 12. Stop point

This review stops here. No M8-i8 implementation has started. Do not implement M8-i8 without a separate authorization.
