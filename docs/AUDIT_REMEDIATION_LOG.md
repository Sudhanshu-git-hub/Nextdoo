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
