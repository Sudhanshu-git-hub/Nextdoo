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
