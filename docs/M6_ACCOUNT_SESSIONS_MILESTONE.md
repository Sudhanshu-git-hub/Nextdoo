# M6 — increment 5: account & session management

Date: 2026-09-11 (closed 2026-09-12) · Branch: `arena/01a085b7-nextdoo` · Status: **complete, CI-verified on `205133f`**

Bounded M6 slice per PRD §6.1 (MVP behavior "session listing/revocation"),
§11.2, §14.3 and the §6.1 acceptance criterion *"Sessions can be revoked
individually and globally; revocation takes effect within 60 seconds
everywhere."*

## Decision recorded

Per the milestone approval, **"Sign out everywhere" revokes EVERY active
session of the caller, INCLUDING the caller's own session.** The calling
client is logged out by the call (UI moves to sign-in; the next API request
from that client is 401).

## API (all owner-scoped, all audit-logged)

| Route | Behavior |
| --- | --- |
| `GET /api/v1/me` | Caller's own profile only: `id, email, name, timeZone, mfaEnabled, createdAt`. Nothing else is ever returned (no password/MFA-secret/session fields). |
| `PATCH /api/v1/me` | Strict update of `name` (1–120 chars or explicit `null` to clear) and `timeZone` (validated against IANA names via `Intl`). Requires `Idempotency-Key` (PRD §10.7). Replays return the stored response; key reuse with a different body is 409. Audit: `account.profile_updated` with changed fields. |
| `GET /api/v1/me/sessions` | Caller's ACTIVE sessions only (unrevoked, unexpired), most recently seen first: `id, deviceLabel, lastSeenAt, createdAt, current`. Raw tokens and IP digests are stored as one-way hashes in the database and never returned in any shape. |
| `DELETE /api/v1/me/sessions/:id` | Individual, owner-only revocation. Revoking the caller's own session is allowed and immediately ends that client. Unknown or foreign ids are a uniform 404 (no existence leak); malformed ids are 400. Audit: `account.session_revoked`. |
| `POST /api/v1/auth/logout-all` | Revokes all active sessions of the caller, including the caller's. Returns `{ revoked }`. Idempotent no-op on repeat. Audit: `account.sessions_revoked_all` with the count. |

No schema migration was required — the `sessions` table (token hash,
device label, IP hash, expiry, revocation, last-seen) and the `users`
profile fields (`name`, `timeZone`) already existed from earlier milestones.
Auth, MFA, password-reset, verification, session-rotation-on-privilege-change
(PRD §11.2, already implemented and regression-covered), entitlement and
billing behavior are untouched.

## Settings UI (`/settings`)

- **Account card** gains a profile form: display name + time zone, with
  saving state, success status and server error display.
- New **Sessions card**: lists each active session (device label, last seen,
  created, "This device" marker) with per-session **Revoke** (native
  confirmation dialog; the current device's button reads "Revoke & sign out"),
  and a **Sign out everywhere** action (confirmation dialog). Both destructive
  actions move the client to sign-in when the calling session was revoked.
  Loading, error and success states are explicit (`role="status"` /
  `role="alert"`); the card is keyboard-operable and axe-clean.

## Verified session-security behavior (measured, not assumed)

Revocation is a database flag checked on **every** request
(`resolveSession` requires `revokedAt IS NULL` and `expiresAt > now`), so a
revoked session fails its very next request. Measured end-to-end through the
production server (`next start` + curl, two cookie contexts):

| Scenario | Measured latency to effect |
| --- | --- |
| Individual revocation → revoked device's next request 401 | **59 ms** |
| Sign out everywhere → caller's AND other device's next requests 401 | **53 ms** |
| Same, service-level (integration tests, real PG) | **4 ms / 2 ms** |

PRD bound: 60 000 ms. Asserted in tests with a 5 s margin; actual values
logged to the test output each run.

Also verified through the production server: anonymous 401 on all five
endpoints; a stranger's revoke of a foreign session id is 404 with the
victim's session still alive; wrong `Origin` on a mutation is 403; missing
`Idempotency-Key` on `PATCH /v1/me` is 400; empty patch, unknown time zone,
over-long name are 400; idempotent replay returns the identical response and
key reuse with a new body is 409; the session list contains no token/IP
material.

## Tests

- **`apps/web/src/server/services/account-sessions.integration.test.ts`** —
  13 DB-backed tests: profile read shape and 404, strict profile update
  (persistence + audit), validation rejections, owner-scoped listing with the
  current-session flag, exclusion of revoked/expired sessions, individual
  revocation (measured latency, sibling unaffected), current-session
  revocation, foreign-id 404 with no audit leak, malformed-id 400, logout-all
  including the caller (measured latency, audited count, safe no-op repeat),
  cross-user non-interference, and the full audit trail.
- **`apps/web/e2e/sessions.spec.ts`** — 6 real-browser specs (two
  independent device contexts): listing + individual revocation (measured),
  current-session revocation, sign out everywhere (measured), profile editing
  UI (save, persistence, invalid value), HTTP contracts (auth, ownership,
  strict fields, origin, idempotency), and axe + keyboard accessibility of the
  sessions card. E2E total: **144** tests (138 before this milestone).

Note: at milestone commit time the local sandbox could not launch the
bundled Chromium (missing NSS libraries, no egress for a system install),
so the browser specs were demonstrated by GitHub CI (real Chromium +
production server + provisioned PostgreSQL), the same pattern as every
prior milestone. During closure (see below) the sandbox was proven to run a
real Chromium 149 from the npm-bundled `@sparticuz/chromium` package
(self-contained native libraries), and that real local browser was used to
reproduce and verify the exports regression fix.

## Validation

Full local validation passed: 705/705 unit+integration tests, lint
(0 warnings), typecheck, production build, migration replay (idempotent),
E2E discovery (144 tests), plus the production-server smoke test.

## Closure: exports E2E regression — root cause, fix, final CI

After this milestone's first commit, CI failed 5 consecutive runs with the
pre-existing data-export E2E test timing out (30 s, at
`page.waitForEvent('download')`). It was reproduced with a real Chromium
149 against a local production build and root-caused **before any change**:

- The new Sessions card made the settings `grid grid-2` (3 columns at
  1280 px) hold 8 cards, moving the DataExport card from the rightmost
  column to a column whose right neighbour is the audit-log card.
- The export table's min-content width (four columns of dates/status)
  exceeds the card's `1fr` width, so the plain `<table>` overflowed the
  card edge; the Download link in the ACTION column rendered **under the
  neighbouring card**, which paints on top.
- `toBeVisible()` passes (Playwright does not check occlusion), but the
  click's actionability ("receives pointer events") never passes —
  `elementFromPoint` at the link's center returned the neighbouring
  `<section class="card">` — so the click hung and the 30 s test timeout
  fired at `waitForEvent('download')`. The download never started. CI
  annotations from the diagnostic replica confirmed the same signature:
  its `download-click` step hung past its 24 s guard.

**Fix (`9e6ca88`)**: the table is wrapped in a `.table-scroll`
(`overflow-x: auto`) container so it scrolls inside the card instead of
overflowing it. No assertion was weakened or removed; with a real local
Chromium the export E2E test passes in ~1 s (was a deterministic 30 s
timeout), the full local E2E suite is green (138/139; the one skipped
suite requires a real ClamAV engine, which the sandbox cannot install —
CI provides it), and 705/705 unit+integration tests, lint, typecheck and
the production build are green. The temporary diagnostic spec
(`exports-diag2.spec.ts`) was deleted with the fix.

**Pre-existing test race fixed along the way (disclosed)**: the push run
of `9e6ca88` hit a flaky assertion in
`export-workflow.integration.test.ts` (`expected 2 to be 1` at the
`pass.retrying` check), unrelated to the UI fix. The generation batch is
global over all due PENDING exports, and
`entitlements.export.integration.test.ts` leaves a due PENDING row in the
shared scratch database; when its creation lands in the retry loop's
window the batch counts 2. This is the same shared-DB race class the file
already documents and mitigates in its first test, so the identical
lower-bound pattern was applied to the retry/exhaustion assertions
(`205133f`); every product-behavior guarantee (attempts 1/2/3, error
text, backoff into the future, FAILED status, failure notification) stays
pinned at row level for the suite's own export.

**Final CI (verified green on the closed tip `205133f`)**: push run
`34645716502` and pull-request run `34645719988` — full pipeline green,
including the complete 144-test real-browser E2E suite and the
production-server smoke test.

## Remaining account/security work (not in this scope)

- Live provider verification (M6-i4) remains blocked on test-mode
  credentials + egress — see `M6_BILLING_CORE_MILESTONE.md`.
- SMTP is still the logged stub; real email delivery (verification,
  password-reset) needs the mail provider milestone.
- Device labels are the existing constant (`web` from login/register);
  UA-based labeling was deliberately not invented in this milestone.
- ASVS L2 assessment, log-platform retention and the §19.4 operational
  release gates remain operational-milestone items.
