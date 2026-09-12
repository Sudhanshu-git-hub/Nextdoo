# M6 — increment 7: account-deletion end-to-end

PRD scope: §6.1 acceptance criteria ("Account deletion requires explicit
confirmation and re-authentication"; "Deleted accounts enter a defined
retention period before permanent purge"), §11.1 risk table ("Account
deletion … Re-authentication, retention window, audit, restore path"),
§13.5 retention, §14.3 `POST /v1/account/deletion` +
`POST /v1/account/deletion/cancel`, §12.4 job contract.

## State found (MVP, preserved as-is where correct)

The deletion feature already existed end-to-end and was audited line by
line before any change:

- **UI** (`SettingsView`): typed `DELETE` confirmation + password form,
  "Delete my account" (disabled until both are present), scheduled-deletion
  banner with the purge date and "Keep my account" button, and the
  "Welcome back — the scheduled deletion of your account has been
  cancelled" notice after a restore sign-in. Because scheduling revokes
  every session of the user, the client sends the browser to `/login`
  immediately after a successful request: a pending account never sees an
  authenticated page again until the sign-in that cancels the deletion
  (the banner is the server-side state for that path, preserved as-is).
- **API** (`/api/v1/account/deletion`): `GET` status · `POST` request
  (rate-limited, re-authenticated password, `confirm: 'DELETE'` contract
  literal) · `DELETE` cancel. (The PRD's `…/deletion/cancel` path is
  realised as the `DELETE` method on the same resource — the existing
  contract was preserved.)
- **Service** (`data-rights.ts`): 30-day grace (`DELETION_GRACE_DAYS`),
  idempotent requests (re-request never extends the deadline),
  `revokeAllSessions` on request, audit events
  `account.deletion_requested` / `account.deletion_cancelled`, notice
  email.
- **Restore path**: the login route cancels a pending deletion when the
  owner signs back in during the grace window (the PRD's "restore path")
  and reports `deletionCancelled`, which the login form turns into the
  settings notice.
- **Purge** (`purgeAccount`, `packages/db`): single transaction — recheck
  `deletion_requested_at <= cutoff` under the user-row lock (crash-safe,
  idempotent, cancellation-proof), full FK cascade of user- and
  workspace-scoped data, explicit cleanup of the FK-less private tables
  (`idempotency_keys`, `outbox`), and removal of export-artifact and
  attachment files from object storage after the commit.
- **Auth-state boundaries**: `deletionExpired` blocks login, session
  resolution, token issuance, and cancellation once the grace window has
  elapsed; `requestPasswordReset` treats an expired/purged address as
  unknown (no credential, no email, no enumeration).
- **Worker** (`accounts.purge`, every 6 h): candidate scan + `purgeAccount`
  per account.

## Gaps found and fixed in this milestone

1. **The worker job lacked the PRD §12.4 job contract** (max retry count,
   exponential backoff, dead-letter behavior, structured error code).
   `accounts.purge` now runs `sweepDueAccounts` through
   `runAccountPurgeWithRetries`: initial attempt + 3 bounded retries
   (60 s / 5 m / 15 m), loud `accounts.purge.dead_lettered` error on
   exhaustion, full accounting in the job result. Per-account failures
   never abort the run and are retried by the next pass; whole-run
   failures (e.g. the database) take the retry path.
2. **No audit trail for the destructive step.** `account.purged` is now
   written inside the purge transaction (with `deletionRequestedAt` +
   `purgedAt`); `audit_logs` has no FK to users, so the record outlives
   the account. Failed attempts write `account.purge_failed`
   best-effort (the audit insert never masks the original failure). Both
   events are security-floor events: they enter M6-i6's
   `SECURITY_AUDIT_ACTIONS` and therefore keep the one-year §13.5 minimum
   even for FREE accounts.
3. **`purgeDueAccounts` (web service) did not isolate per-account
   failures** even though its own comment claimed it did — one failure
   aborted the run. It now catches, logs, and continues; the failed
   account stays eligible for the next pass.

No schema migration was required (`users.deletion_requested_at` existed).
No retention policy changed. M6-i6's retention sweep and read-side
behavior are untouched.

## Deletion lifecycle (as verified)

```
register ──► active
   │  POST /v1/account/deletion {password, confirm:"DELETE"}
   │    · password re-authenticated under the account lock
   │    · deletionRequestedAt set (re-requests keep the original deadline)
   │    · ALL sessions revoked (takes effect on the very next request)
   │    · account.deletion_requested audited; notice email sent
   ▼
pending deletion (30-day grace)
   · owner can sign in, export, cancel (DELETE … or simply log in)
   · reset/verification credentials still issuable (account is live;
     the PRD does not mandate suppression while pending — see Open items)
   · login during the window → cancellation + settings notice
   · account.deletion_cancelled audited
   ▼ (grace elapsed, before the next purge pass)
terminal pending
   · login, session resolution, token issuance, and cancellation all
     refuse (uniform errors)
   ▼
accounts.purge (every 6 h; initial + 3 retries, dead-letter alert)
   · sweepDueAccounts: due = deletionRequestedAt <= now − 30 d (<=,
     boundary inclusive), max 50 per pass
   · purgeAccount per account under lock: cascade + private-table
     cleanup + object-file removal + account.purged audit row
   · a poisoned account fails audited (account.purge_failed), never
     blocks others, is retried on the next pass
   ▼
purged
   · user, workspace and all workspace-scoped rows gone (tasks, projects,
     sections, tags, reminders, timers, tracking, sync, conflicts,
     attachments + files, calendar, notifications, exports + artifacts,
     subscriptions, entitlements, preferences, devices, sessions,
     auth tokens, recovery codes, mail deliveries, idempotency keys,
     outbox)
   · KEPT: audit_logs (workspace + account-level, incl. the
     account.purged record) and billing_events (provider evidence,
     §13.5 "as required by tax and accounting obligations")
   · login with the old credentials → uniform "Email or password is
     incorrect"; the email is released and can register a new account
```

## Tests (all DB-backed)

- **13 web integration tests**
  (`apps/web/src/server/services/account-deletion.integration.test.ts`):
  re-auth success/failure · exact 30-day boundary (inclusive `<=`,
  +1 ms not due) · cancel/restore before purge · repeated requests keep
  the deadline · session invalidation (both sessions revoked,
  unresolvable) · reset/verification email behavior at the three
  lifecycle points (issuable while pending — documented, not mandated;
  suppressed once expired; dead after purge) · complete account-data
  removal (15 tables asserted zero) · protected records remain (all prior
  audit rows + exactly one new `account.purged`; billing_events) ·
  export/attachment row + file cleanup via fake stores · billing/
  entitlement cascade · tenant isolation with a genuine FK partial
  failure (cross-tenant `review_notes.updated_by` no-action reference) —
  healthy account purged, poisoned one survives audited, next pass
  catches up through the real worker sweep · idempotent rerun (second
  `purgeAccount` = no-op; next sweep finds nothing) · email re-use
  refused while pending, allowed after purge.
- **6 worker tests**
  (`apps/worker/src/account-purge.integration.test.ts`): retry contract
  constants · first-attempt success accounting + per-failure error logs ·
  retry with documented backoff · dead-letter after 4 attempts (exact log
  sequence) · real sweep (purge + `account.purged` audit row + idempotent
  rerun) · end-to-end registered job run.
- **1 Playwright spec** (`apps/web/e2e/account-deletion.spec.ts`, 2
  tests) — the full visible lifecycle in a real browser:
  - *schedule with typed confirmation, then sign in again to restore the
    account*: typed-confirmation + password gating (button disabled until
    both are present), axe-clean deletion block (WCAG AA tags, scoped to
    the deletion surface), submit → the real product outcome (redirect to
    `/login`, because every session is revoked), then the sign-in restore
    path: auto-cancellation + `?deletion=cancelled` notice, and the state
    verified through the API (`scheduled: false`, `/me` 200).
  - *scheduling kills the session, and after the purge the credentials
    are dead with the email released*: scheduling response verified
    (`scheduled: true`, `purgeAfter − requestedAt = 30 d` ± 1 min), the
    session kill measured (the next `/me` is 401, within 5 s of the
    scheduling call), the 30-day wait simulated by backdating, the real
    UI sign-in gets the uniform "Email or password is incorrect"
    rejection, and the email is released — a brand-new account on the
    same address registers and signs in (honouring the login-throttle
    Retry-After that the pre-purge failed attempt can leave).
- **Updated** `purge.integrity.integration.test.ts`: the audit-equality
  assertion now expects the pre-purge rows intact plus exactly one new
  `account.purged` row (stronger than before).

## Validation (all executed)

- Full local suite: **741/741 passed** (70 files), exit 0.
- Lint (`--max-warnings=0`) and typecheck (web/worker/db): clean.
- Coverage thresholds met (core 97.91% lines; overall 89.4% statements /
  93.25% lines; collection scope unchanged).
- Production build (Next.js, all pages): success.
- Migration replay: fresh database → 21 migrations → real `purgeAccount`
  → `account.purged` audit row + zero users, verified.
- Local real-browser E2E (Chromium against the production build):
  **141/141 runnable specs passed**, including both account-deletion
  tests; the only local failure is the attachments spec, which refuses to
  run without the ClamAV engine (not installed in the dev sandbox;
  installed in CI, where the suite passes).
- GitHub CI (full pipeline incl. the real-browser E2E suite):
  - push run **34683332831** (tip `404e65a`): every step green except the
    two tests of the new E2E spec. Both failures were defects in the new
    spec, not the product: (1) axe was scoped to the whole pre-existing
    Account card, which carries pre-existing contrast violations outside
    this milestone — fixed by scoping axe to the deletion block
    (`data-testid="delete-account"` wrapper); (2) `getByRole(
    'alert'/'status', { name })` can never match (those roles do not
    compute an accessible name from content) — fixed with text filters.
    The spec was additionally re-aligned to the real product flow
    (scheduling redirects to `/login`; the 30-day window and the measured
    session kill moved to the API-driven test) — disclosed here and in
    the commit message, no product behavior changed. Fixed at **`b12fef8`**.
  - verification run on `b12fef8`: see the implementation-log entry for
    the final run id.

## Open policy decisions (not invented)

1. **Suppression while pending**: the PRD does not require suppressing
   verification/reset emails *during* the grace window; current behavior
   (issuable while the account is live, suppressed from the moment the
   window expires, dead after purge) is exactly what the PRD implies and
   was preserved + tested. If product wants suppression from request
   time, that is a one-line guard — decision required, not made.
2. **Re-auth strength for MFA accounts**: the deletion gate verifies the
   password (the pre-existing MVP contract). For MFA-enabled accounts a
   second factor is not required — the PRD says "re-authentication"
   without specifying strength. Changing the gate would alter verified
   MVP behavior; product decision required.
3. **Grace length**: the PRD says "a defined retention period" without a
   number; the codebase defines 30 days (MVP, unchanged here). Confirm
   30 days is the intended product value.
4. **`account.purged` / `account.purge_failed` in the security list**:
   added so the compliance evidence keeps the §13.5 one-year floor;
   confirm these events belong there.
