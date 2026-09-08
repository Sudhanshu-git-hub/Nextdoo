# Audit remediation execution log

## Account-security boundary

10 new regressions reproduced failures before repair; all pass after. Account row
locks serialize credential issuance/consumption, MFA state changes, login and
account-deletion cancellation. Reset TTL is 30 minutes; audit-failure injection
proves password/token/session rollback. MFA invalidates old sessions and its HTTP
routes rotate the current session. Expired deletion cannot authenticate or cancel.
Unsafe browser origins are rejected at route boundaries; wildcard Server Actions
origins removed. Dynamic HTML carries per-request CSP script nonces; inline styles
remain allowed for inherited UI. HSTS is present (HTTPS deployment still required).
Production credential URLs and driver-error strings are redacted; missing email
transport fails honestly rather than logging reset credentials.

Migration 0007 adds durable HMAC-keyed account/IP login backoff. Browser regressions
reproduced missing throttling and headers before repair. Full verification passed:
243 tests, 7 real-browser E2E, lint/typecheck/coverage/build. Evidence under
`/home/user/nextdoo-remediation`: auth-red/green/verify, backoff-red, headers-red.
External breach-password checking, provider delivery and deployment qualification
remain open, not implied by this milestone.

## Offline queue safety

Eight regressions failed before repair (six IndexedDB tests, two real DB sync
regressions). Versioned IndexedDB storage now has workspace provenance and local
FIFO order; legacy unscoped records remain stored but cannot be guessed/replayed.
Writes acknowledge transaction completion, not request success. Failed heads block
followers; independent entities progress. Network failures retry without quarantine;
4xx/conflicts/rejections retain raw content for attention; hard failures back off.
Only submitted IDs can be acknowledged. Push explicitly carries workspace identity,
and replay of a rejected/conflicted server mutation cannot become a success ack.
Full verification passed: 251 tests, seven browser E2E, all other gates. New storage
tests use fake-indexeddb; existing real browser cache-isolation regression still
passes. Full offline capture/pull/recovery UI is deliberately not activated.

## Honest delivery and worker recovery

Five delivery regressions failed before repair. WEB reminders now write a durable
in-app notification and status in one transaction; simultaneous passes cannot
produce two records. Inactive tasks cancel; unsupported EMAIL/DESKTOP reminder
channels fail explicitly (no claim of web push/native delivery). The alternate
web dispatcher shares the worker implementation. Unhandled outbox events remain
unpublished with a durable blocked reason rather than being discarded as sent.

Configured auth email now queues encrypted durable messages. Migration 0008 stores
leases, retry deadlines, expiry and failure state; account purge cascades messages.
The worker uses Nodemailer 10.0.1, certificate verification and required TLS in
production, bounded timeouts, stable Message-ID and five attempts. Three real TCP
SMTP tests cover acknowledgement/concurrent passes, expired-lease recovery and
terminal failure. This is at-least-once SMTP: an ACK followed by process failure
before the ledger update can duplicate delivery; external exactly-once is not
claimed. Production provider/domain/inbox delivery still needs qualification.

A failing shutdown regression proves the pool was closed before in-flight jobs;
shutdown now drains them. Two additional failing notification-boundary regressions
prevent account enumeration when SMTP is missing and prevent provider failure from
denying account deletion. Secret-bearing payloads/errors are not logged by worker.
Full verification passed: 262 tests, seven E2E, all gates; full dependency audit 0.
Node type definitions updated to 22.20.1 to resolve the inherited Vite peer warning.
Evidence: delivery-red/verify, smtp-tests, drain-red, notification-failure-red,
delivery-audit. No later provider/product integrations were fabricated.

## Remaining resource/export boundaries

Five new integration regressions exposed guest-membership access/export disclosure,
omitted account-level audit/preferences, project-limit races and ignored filters.
MVP authorization now requires the actual personal-workspace owner, not any role
string; export selects only owned workspaces and uses a repeatable-read snapshot.
Exports include existing preferences/recurrence/dependencies/corrections/notifications
and non-secret session/device metadata. Credentials remain excluded. The existing
synchronous download is not represented as an expiring hosted-file feature.

Project creates share workspace locking and quota checks. The initial quota fixture
mistakenly assumed five projects; corrected to the contract's Free limit of three,
and the corrected regression was rerun against the unchanged pre-fix service and
failed before restoring the repair. No assertion was relaxed to bypass a requirement.
Tag filtering and explicit boolean parsing now work. HTTP path IDs fail with 400,
not SQL errors. Timer/task/reminder writes now opt into atomic idempotency, and the
API client supplies a key while preserving explicitly provided retry identity.
Two real HTTP E2E regressions also cover timer replay and request-ID/no-store/durable
export quotas. Full verification passed: 267 tests, 9 E2E/API scenarios, all gates.
Evidence: boundaries-red/verify, contracts-red/additional, project-cap-red-corrected.

## Migration deployment integrity

Two failing real-PostgreSQL regressions demonstrated concurrent-runner races and
silent acceptance of changed applied SQL. The runner now takes a session advisory
lock before touching the ledger, verifies every applied file before applying new
ones, and stores SHA-256 checksums transactionally. Existing checksum-less ledgers
bootstrap only against the checked-in audited 0000–0008 legacy manifest, not an
arbitrary current file. Missing files or unknown/mismatched legacy sources stop
deployment. Legacy metadata upgrade and the full verification passed: 269 tests,
9 E2E/API scenarios, all gates. Evidence: migrations-red/verify, checksum-upgrade.
This does not replace backup/restore, rollback rehearsal or hosted PG16 CI gates.

## Duration precision, calculation evidence and final housekeeping

Four short 30-second timer sessions previously credited zero minutes. Two failing
timer regressions now preserve fractional seconds across sessions and retain manual
annotations in tracking history. Migration 0009 adds a bounded seconds remainder;
existing whole-minute data remains intact. Task versions/sync and scoring use the
precise total. Historical discarded time is **not** invented or silently backfilled.
A failing provenance regression now stores immutable input snapshots for new scores;
legacy hashes remain without fabricated inputs. Source-event UI, corrections and
backfill workflows are still separate incomplete PRD features.

Additional regression-first hardening: expired mail ciphertext is scrubbed even
when SMTP is disabled; bounded housekeeping removes expired authentication quota
records; API keys survive all three HeadersInit forms/casing; health responses carry
request IDs. A qualification test confirms delete/restore already increments versions
and stale PATCH still conflicts. No new DELETE CAS rule was invented: the PRD's
explicit CAS requirement is PATCH, and sync's delete-wins policy remains intact.
Full verification: 278 tests and 9 E2E/API scenarios passed, all gates. DB-free core
subset remains 157 passing. Evidence: precision-red/verify, provenance-red,
disabled-provider-red, housekeeping-red, health-red, final-unit.

## Capture intent preservation

Two real browser regressions reproduced silently discarded `#tag` and `+project`
intent. Capture now explicitly refuses those unsupported structured saves and keeps
the original input, rather than pretending the fields were persisted. Help text
no longer advertises unsupported saving. This does not implement a tag/project
selection workflow. During implementation, typecheck caught the nullable ParsedField
shape; the error locator was narrowed to exclude Next's unrelated route announcer,
without relaxing the expected error, original-input or zero-created-task assertions.
Final full verification passed: 278 tests and 11 E2E/API scenarios, all gates.
Evidence: structured-capture-red/verify.
