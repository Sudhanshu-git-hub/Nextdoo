# M6 increment 2 — Attachment pipeline (PRD §6.8, §11.4, §12, §14)

Bounded M6 slice: the full attachment lifecycle with plan-based storage and
maximum-file-size gating, **real** malware scanning before any file becomes
downloadable, safe download authorization, tenant isolation, metadata
lifecycle, cleanup, and task/workspace ownership integration. No billing,
Google Calendar, AI, desktop, or retention-destruction/anonymization work.
No existing test weakened or deleted; no architecture rewrite.

## Scanner decision (per the milestone guardrail)

The PRD requires malware scanning before download but names no provider.
Decision: **self-hosted ClamAV** (open-source engine, `clamscan`), no
external provider, no credential. The stop-condition ("if a provider decision
or credential is genuinely required, stop and report") is therefore not
triggered. The engine is behind a small `AttachmentScanner` interface
(`packages/db/src/attachment-scanner.ts`) — the switching point if a managed
scanner is ever chosen — but every code path in this milestone uses the real
engine, and the E2E suite **refuses to run without it** (fails loudly, never
fakes or skips). Integration tests inject a deterministic scanner purely to
assert workflow semantics (state machine, backoff, quarantine, idempotency);
the real-engine proof is the E2E suite in CI (which installs ClamAV and
verifies EICAR detection before any test step).

## What was built

### API (all under `/api/v1`, session-authenticated)

| Route | Purpose |
| --- | --- |
| `GET /attachments?taskId=` | List the task's attachments (uploader-scoped), 600 rpm |
| `POST /attachments` | Upload authorization: task tenant check → content-type allowlist → plan max-file check → workspace storage-quota check → row insert → **signed 15-minute upload URL** (server-generated object key; no storage credentials ever reach the client), 120 rpm, idempotent |
| `PUT /attachments/:id/upload-data?token=` | Raw file bytes; token-gated (purpose/user/size-bound, timing-safe compare); **exactly the declared size** (over → 400, under → 400), 60 rpm |
| `POST /attachments/:id` | Complete: stored bytes must match the declared size; stamps `uploadedAt` (scan queued); **idempotent** (lost-ack safe), 120 rpm |
| `GET /attachments/:id/download` | Signed 15-minute download URL (PRD §11.4 ≤ 15 min); **409 `ATTACHMENT_NOT_CLEAN`** with a state-specific message when PENDING / INFECTED / FAILED, 600 rpm |
| `GET /attachments/:id/download/file?token=` | The only path from store to bytes: session + CLEAN status + valid token; `Content-Disposition: attachment` + `nosniff` + `no-store`; audit-logged |
| `DELETE /attachments/:id` | Soft delete + object removal + audit; releases quota |

### Plan gating (server-side, at authorization)

- Max file size per plan (FREE 10 MB / PRO 100 MB / TEAM 250 MB /
  ENTERPRISE 1 GB) — rejected before any row or bytes exist.
- Workspace storage quota (FREE 100 MB / PRO 5 GB / TEAM 10 GB /
  ENTERPRISE 100 GB) — sum of `sizeBytes` over undeleted rows; a rejected
  authorization consumes nothing.
- Content-type allowlist with a fixed extension set (no user-controlled path
  segments anywhere — object keys are `attach-<workspaceId>/<id>.<ext>`,
  regex-validated at the store boundary).

### Scan state machine (migration 0019)

`PENDING → CLEAN | INFECTED | FAILED` with `attempts` (initial + 2 retries,
PRD §14), backoff `nextAttemptAt`, claim lease (`claimToken` +
`leaseExpiresAt`) and stale-claim recovery. A verdict is committed only while
the claim token is still held. **A file is never CLEAN without a successful
engine scan**: ClamAV exit 0 → CLEAN, exit 1 → INFECTED (quarantined: row and
object retained, never served, `attachment.infected` audit with the signature
name), exit 2/other or crash → retry with backoff; after the third attempt →
FAILED (quarantined, still counts against quota, deletable).

### Worker + health

- `attachment.scan` job (10 s) in `apps/worker/src/jobs.ts`: bounded batch
  (5, 20 s budget), per-workspace fairness via `row_number() partition by
  workspace`, quarantine/retrying/deferred log lines.
- `purgeAccount` now removes attachment objects after the row cascade
  (PRD §11.9: no private file outlives the account).
- Health route reports `checks.attachmentScanner` (30 s probe cache;
  reported, **not** probe-fatal — downloads fail closed, so an unavailable
  engine must not mask a running, safe API).

### UI

`TaskAttachments` in the task editor: upload via file input → PUT → complete
→ poll to verdict; status pills (Scanning / Ready / Blocked — unsafe file
detected / Scan failed) announced via `aria-live`; download link appears only
when CLEAN (signed URL); confirmed delete. A11y: labelled control, axe-clean.

### Data rights

`buildExport` includes attachment **metadata** (never bytes) in the
account-export bundle.

## Tests

**Integration** — `apps/web/src/server/services/attachment-workflow.integration.test.ts`
(12 tests, deterministic injected scanner for workflow semantics): upload
success + metadata lifecycle; over-size rejection (nothing stored); allowlist
rejection; exact declared size (over/under); quota at the exact boundary
(10 × 10 MB = 100 MB cap, +1 byte rejected, rejected authorize consumes
nothing, deletion releases); infected quarantine (object retained, 409
blocked, UI state, audit); retry/backoff/exhaustion (attempt 1 → backoff, no
rescan before due, recover-within-budget → CLEAN at attempt 3, never-recovers
→ FAILED with `scanError`, still quota-counted, deletable); download token
binding (missing / malformed / tampered / wrong-purpose / foreign-user all
403); deletion + cleanup; lost-ack (re-PUT after complete clearly reported,
re-complete idempotent); tenant isolation (foreign task 404s, foreign row
access 404s, foreign-session token 404, per-workspace object prefixes,
purge removes only the purged account's files); data-rights bundle metadata.

**E2E** — `apps/web/e2e/attachments.spec.ts` (6 tests, **real engine**,
worker-driven per the exports precedent): browser upload in the task editor →
scan gate → download with byte equality → confirmed delete + storage cleanup;
over-size / allowlist / exact-size via API; **EICAR file quarantined by the
real ClamAV engine** (INFECTED row, 409 download, UI blocked state); download
token security (200 with `attachment` + `nosniff`, 403 missing/tampered);
tenant isolation (401 unauthenticated, 404 foreign, foreign-session URL 404);
axe on the attachments section. `beforeAll` calls
`attachmentScannerHealthy()` and **throws without a working engine** — no
mock, no skip.

**CI** — `quality.yml` installs ClamAV + fresh signature DB, stops the
package's auto-started freshclam timer (DB-lock race), verifies EICAR
detection (exit 1) as a step before any test step; timeout 20 → 25 min.

## Verification (local, PG 18)

- Unit + integration: **60 files / 599 tests** (587 → 599; +12 attachment
  tests), all passing.
- E2E: **129/129** of the pre-existing specs (no regressions, including the
  4 task-editor axe specs after adding the missing file-input label); the
  6-test attachment spec fails loudly locally with
  `ATTACHMENT_SCAN_ENGINE_MISSING` (no ClamAV installable in this sandbox —
  the engine proof is the CI step above).
- Lint 0; typecheck 5/5; production build green.
- Coverage **93.48% lines / 89.52% statements** overall (no overall gate;
  core-only 85% gate untouched).

## CI outcomes (recorded as verified)

Final tip **`64fb5e5`**: **push and pull_request runs both green** (all 18
steps: ClamAV install + EICAR verification, audit, migrate ×2, lint,
typecheck, `test:coverage` 599/599, build, and all 135 E2E tests including
the 6 real-engine attachment tests). Run history on this milestone:

1. `401bb4f` — install step failed (~20 s). Root cause: `freshclam` runs as
   the package's service user with the DB locked by the auto-started
   freshclam timer; the step ran it unprivileged. Fixed in `a88fe4f`
   (root freshclam, timer stopped first, log-tail annotations on failure —
   added because run logs are unreachable from the session's results
   receiver).
2. `a88fe4f` — EICAR verify step "failed". Root cause: the default Actions
   shell uses `set -e`, and `clamscan` exits **1 when it detects** the file —
   the correct outcome — aborting the step before the exit code could be
   captured. The engine was working; the step logic wasn't. Fixed in
   `1da177a`.
3. `1da177a` — E2E: 2 of 6 attachment tests failed on assertion bugs in the
   new spec (over-size status asserted as 403; the contract maps
   `ENTITLEMENT_LIMIT_REACHED` to 402 — the integration suite asserted the
   code and passed; and one stale `.chip` selector where the app renders
   `.pill`). The real-engine tests (EICAR quarantine, token security, tenant
   isolation, a11y) all passed. Fixed in `bd773f9`; `bd773f9` PR run green.
4. `818a364` — push run failed in the pre-existing M2
   `task-bulk.integration.test.ts` rollback test (identical-code PR run
   green). Root cause found from the full diff: the same four
   `tracking_events` rows in before/after snapshots, **only the row order
   differed** — `snapshot()` selects without `ORDER BY` and compares with
   order-sensitive `toEqual`; under parallel load Postgres returned the
   same heap rows in a different order. No application defect. Fixed in
   `818a364` itself (ORDER BY in all seven snapshot selects; same rows
   asserted, stable order).
5. `818a364` — a second, separate flake: push run failed in the pre-existing
   M6-i1 `export-workflow.integration.test.ts` on
   `expect(result.processed).toBe(1)` (received 2). Root cause:
   `runExportGeneration` is a global batch (all due PENDING exports, limit
   5); a parallel suite's PENDING row was legitimately co-processed, and the
   assertion encoded incidental shared-DB state. Row-level assertions
   (the suite's own export READY with correct key/size/TTL) were unchanged.
   Fixed in `64fb5e5` (processed ≥ 1; terminal-state assertions for the
   stale-claim pass kept). PR run of `818a364` was fully green, confirming
   both flakes were load-timing races, not deterministic breaks.

No application code was changed to compensate for any CI condition; the
only post-milestone changes are (a) the CI workflow steps and (b) two
test-harness assertions in locked-milestone suites that over-asserted
incidental shared state, each with a recorded root cause and no weakened
substantive assertion.

## Known limitations / next

- Local object store is the default; managed object storage (S3 or
  equivalent) is the documented switching point (`AttachmentObjectStore`),
  not yet wired.
- Scans run inline in the worker batch (5/batch, 20 s); large-burst
  backpressure is the PRD §14 deferred "queue depth" item.
- Multi-workspace teams: attachments are uploader-scoped within the owning
  task (no cross-member visibility invented beyond the PRD).
