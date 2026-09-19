# Asynchronous expiring data exports — acceptance report

Date: 2026-09-09 (Asia/Calcutta). Scope: execution-order item 3 of
[PHASE1_COMPLETION_PLAN.md](PHASE1_COMPLETION_PLAN.md) — "Deliver asynchronous,
expiring exports only with reviewed storage/expiry design and real integration
evidence" (PRD §7.10, §12.4, §13, §14). **This is not full M6:** commercial
readiness work (billing/webhooks, Google Calendar two-way, attachment scanning,
support dashboards) remains open, as do retention/backup-deletion and
distributed-limit operational resources.

## Delivered workflow

1. A user (or a signed-in session) requests an export with
   `POST /api/v1/exports` (`format` = `json` or `csv`). The command is
   authenticated, origin-checked, idempotent (existing `Idempotency-Key`
   ledger), rate limited (120/min route limit plus a durable 3-per-hour
   reservation) and plan-gated (FREE: 1 export per rolling day, paid:
   unlimited, via the existing entitlement limits). A 402/429 rejection creates
   no export row.
2. The request persists a `PENDING` row with `next_attempt_at = now`. Nothing is
   generated synchronously; the response is the row summary with
   `downloadUrl = null`.
3. The standalone worker runs `export.generate` every 10 seconds
   (`packages/db/src/export-work.ts::runExportGeneration`):
   - It first reclaims stale claims (`recoverStaleExportClaims`): a `PROCESSING`
     row whose lease expired and whose token is gone/foreign becomes `FAILED`
     with `error = STALE_EXPORT_CLAIM` when its attempt budget is exhausted, or
     returns to `PENDING` with backoff otherwise. Recovery happens **before**
     candidate selection, so a crash during generation consumes the same retry
     budget as a caught failure.
   - It then selects up to 5 due `PENDING` rows in per-user round-robin (one
     candidate per user per pass, `attempts < 3`, 20-second pass budget) and
     claims each row under a per-user advisory lock with a random `claim_token`
     and a 2-minute `lease_expires_at`. The attempt counter is incremented in
     the claim itself.
   - Generation reads the user's tasks, ordered tracking events, non-superseded
     tracking results, corrections and exact per-bucket rollups (90 daily UTC
     buckets; 8 contiguous 7-day weekly windows) across all owned workspaces,
     and writes one artifact: `json` = `gzipSync` of
     `{formatVersion: 1, kind: 'nextdoo-tracking-export', generatedAt, account,
     tasks[], events[], results[], corrections[], rollups: {daily, weekly}}`;
     `csv` = gzip of a 36-column typed union with `record_type` discriminator
     (`event` / `result` / `correction` / `rollup_daily` / `rollup_weekly`).
   - Commit is fenced: the row only becomes `READY` when
     `claim_token` still matches the claimed token. `READY` rows carry
     `object_key` (`export-<userId>/<exportId>.<format>.gz`), `size_bytes`,
     `completed_at` and `expires_at = now + 24 hours` (PRD §13.5), plus an
     `export_ready` in-app notification.
   - Failures persist the error (first 300 chars), clear the claim and schedule
     backoff (1 min, 2 min). The third attempt fails terminally to `FAILED`
     with an `export_failed` notification. A 20-second pass defers remaining
     candidates rather than starving the loop.
4. `GET /api/v1/exports` (keyset cursor pagination) lists the user's own rows
   only; `GET /api/v1/exports/:id` returns one row. `READY` rows include a
   short-lived `downloadUrl`.
5. `GET /api/v1/exports/:id/download?token=…` streams the artifact. The token is
   `b64url({v,e,u,f,x}) . b64url(HMAC-SHA256)` keyed by
   `sha256('nextdoo/export-download/v1:' + AUTH_SECRET)`, verified with
   constant-time comparison and bound to export id, user, format and expiry
   (row expiry plus 60 s clock skew). Responses are
   `application/gzip`, `Content-Disposition: attachment` with a
   `nextdoo-tracking-export-<id8>.<format>.gz` filename, `Cache-Control:
   no-store`. States map to `EXPORT_NOT_READY` (409) and `EXPORT_EXPIRED` (410);
   malformed/unbound tokens map to `FORBIDDEN` (403); foreign rows are invisible
   (404), never 403.
6. `exports.expire` runs every 60 seconds (`expireExports`): past-expiry `READY`
   rows become `EXPIRED` and their artifact files are deleted from the store.
7. Durable file store: `createDurableFileExportStore()` writes to
   `EXPORT_STORAGE_DIR` (default `<cwd>/var/exports`), `fsync`s the artifact
   then renames it into place (atomic; a crash leaves no partial object) and
   rejects path escape via key validation. Account purge
   (`purgeAccount`, unchanged cadence) now enumerates the user's export
   `object_key`s under the account lock and best-effort deletes the artifact
   files after the row cascade, so a purged account leaves no export bytes.
8. UI: Settings → **Data export** (`DataExport.tsx`): format select, request
   button, status table (Preparing/Ready/Failed/Expired with 24-hour expiry
   line and error text), Download link, plan hint ("Free plan: 1 export per
   day"). The panel polls every 10 s only while a row is in flight and the tab
   is visible, announces changes via `aria-live`, and is axe-clean.

## API and transaction boundaries

- `POST /api/v1/exports` — authenticated, origin-checked, `idempotent: true`,
  120/min, body `{ "format": "json" | "csv" }`.
- `GET /api/v1/exports?cursor=…` — keyset pagination over
  `(created_at, id)`; page ≤ 50.
- `GET /api/v1/exports/:id` — tenant-scoped by `user_id` in every query.
- `GET /api/v1/exports/:id/download?token=…` — token-bound; no bearer session
  required beyond the token (signed URLs are the access boundary).
- Worker jobs: `export.generate` (10 s), `exports.expire` (60 s), both sharing
  one `ExportArtifactStore`; `purge.accounts` passes the same store to
  `purgeAccount`.

Nothing AI/billing/desktop/offline was touched; AI, billing integration,
desktop and full offline mode remain excluded per the execution order.

## Storage and expiry design (reviewed)

- Objects are keyed per user (`export-<userId>/…`) and stored gzip-compressed;
  size is bounded by the user's own history plus fixed 90+56 rollup rows.
- The 24-hour window is enforced twice: token `x` claim (rejects before now)
  and row `expires_at` (sweep deletes files and flips the row to `EXPIRED`).
  A token minted for a row that is later expired is refused because it is
  verified against the **row's** current state.
- Retry budget is 3 total attempts (initial + 2 retries, PRD §12.4) with
  1/2-minute backoff and a 2-minute lease; lease recovery is fenced by the
  claim token, so a delayed worker can never publish over a reclaimed row.
- Rollups are computed per bucket in SQL (exact distinct counts), not summed
  from daily rows.

## Verification (all executed in this environment)

- `packages/db/migrations/0015_export_generation_state.sql` applied via
  `pnpm db:migrate`; replay is a no-op.
- New regression suite
  `apps/web/src/server/services/export-workflow.integration.test.ts` (9
  tests, real PostgreSQL): JSON lifecycle (READY, 24 h TTL, scoped object key,
  artifact contents incl. 90 daily / 8 weekly rollups, ready notification);
  CSV typed-union contents; retry → backoff → terminal failure with
  `export_failed` notification and recovery after the fault clears; stale
  claim reclaim without double counting and exhausted-stale-claim terminal
  failure; tenant isolation (foreign list/get/download all refused, signed
  token bound to owner); token/state/expiry matrix (409/403/410, tamper,
  wrong export id, wrong format, file deletion on sweep); FREE 1/day vs paid
  unlimited; durable 3-per-hour limit; purge removes rows **and** artifact
  files. **9/9 pass.**
- New browser E2E `apps/web/e2e/exports.spec.ts` (4 tests against the real
  production build and PostgreSQL): full request → generate → list → download
  round trip with artifact re-parsing, idempotent replay, response headers
  (attachment/no-store), axe-clean panel; foreign-account invisibility and
  untrusted-origin refusal; tampered/malformed token refusal; expiry → 410 in
  API and UI. **4/4 pass.**
- Full gates re-run green after the change: lint, typecheck, `test:coverage`
  (47 test files, 86.15% statements overall), production build, and the
  complete E2E suite (79 passed, including the 4 new tests).
- Defects found and fixed during verification (recorded per the ledger):
  `generate_series(date, date)` does not exist in PostgreSQL (rewrote the
  daily rollup window as an integer series); `extract(epoch from integer)`
  invalid (weekly window index uses integer day arithmetic); parameterised
  `interval '$n minutes'` is not typable (switched to `make_interval`);
  drizzle sql templates expand JS arrays into scalar parameters (workspace
  predicates now use `IN (…)` lists); failure backoff must be a valid SQL
  expression or the row is stuck `PROCESSING` (caught because the outer
  catch surfaced it); error column stores the failure message, not the JS
  error class name.

## Known limitations (unchanged scope)

- The artifact store is local-disk in this deployment; object storage (S3)
  remains a deployment concern and the `ExportArtifactStore` interface is the
  seam. Retention beyond the 24-hour window, backup deletion and distributed
  rate limiting remain operational work per the execution order.
- Exports reflect data at generation time; they are snapshots, not live views.
- CSV payloads embed task titles and event payloads as-is (they are the
  user's own data; no cross-tenant content is included).
