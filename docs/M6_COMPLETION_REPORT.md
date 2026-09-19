# M6 — commercial readiness: completion report

Consolidated status of the M6 program. Source of truth: `docs/PRD.md` +
`docs/IMPLEMENTATION_LOG.md` (completion ledger). Every increment below
was closed behind a full validation gate (unit/integration tests, real-
browser E2E, lint, typecheck, coverage, production build, migration
replay, GitHub CI) and is CI-verified at the listed commit.

## Increments

| # | Increment | Status | Closing commit |
|---|---|---|---|
| M6-i1 | Server-side entitlement enforcement + authenticated export path | CLOSED, CI-verified | `f2fff2c` |
| M6-i2 | Attachment pipeline — plan-based storage, max-file-size gating, real ClamAV scan-before-download | CLOSED, CI-verified | `49b1c6b` |
| M6-i3 | Multi-provider billing core (Stripe + Razorpay, provider-agnostic) | CLOSED, CI-verified | `89b5624` |
| M6-i4 | Live test-mode verification (Stripe + Razorpay) | **BLOCKED (externally)** — stopped at pre-flight; requires a provider-accessible environment with real test-mode credentials; never to be retried in this sandbox | `d771424` (attempts logged) |
| M6-i5 | Account & session management | CLOSED, CI-verified | `6286e66` |
| M6-i6 | Retention & purge pipeline | CLOSED, CI-verified | `4e0592f` |
| M6-i7 | Account-deletion end-to-end | CLOSED, CI-verified | `c04df57` |
| M6-i8 | Final closeout — policy decisions + Account-card a11y fix | CLOSED, CI-verified | this tip |

M6 is **complete** except M6-i4, which is blocked on external credentials,
not on this codebase.

## What M6 delivered (PRD mapping)

- **Entitlements & export (i1):** plan quotas enforced server-side on
  every gated mutation; authenticated, quota-metered data export with
  24-hour artifact expiry.
- **Attachments (i2):** plan-based storage caps and per-file size limits
  enforced server-side; files are scanned by a **real ClamAV engine
  before any download** (EICAR verified in CI); signed, expiring
  download URLs; foreign-account isolation.
- **Billing core (i3):** provider-agnostic billing core with Stripe and
  Razorpay adapters — subscription lifecycle, webhooks with signature
  verification, plan state machine, provider reconciliation; no provider
  logic leaks into the app.
- **Account & sessions (i5):** session listing/revocation (single and
  revocation-everywhere, measured), password reset + email verification
  with durable mail delivery, optional TOTP MFA with recovery codes,
  login-throttle with exponential backoff, credential-stuffing
  hardening, audit of security events.
- **Retention & purge (i6):** plan-based audit retention (FREE 0 d / PRO
  30 d / TEAM 365 d / ENTERPRISE 2555 d) with a 1-year security-floor for
  security-critical events (§13.5), deleted-task 30-day purge with full
  cascade + tombstones + files, tenant-fair bounded sweep, protected
  records (in-flight exports, no-action references, security rows)
  retained by design.
- **Account deletion (i7):** re-authenticated typed-confirmation
  deletion request; 30-day grace (final product rule, M6-i8 §1); ALL
  sessions revoked at request (measured); sign-in restore path with
  visible notice; durable `accounts.purge` worker job meeting the PRD
  §12.4 contract (4 attempts, 60 s/5 m/15 m backoff, dead-letter
  alert); crash-safe idempotent `purgeAccount`; `account.purged` /
  `account.purge_failed` security-floor audit events; post-purge the
  credentials are uniformly dead and the email is released.
- **Closeout (i8):** the four M6 policy questions resolved and
  documented (grace 30 d · email suppression from grace expiry ·
  password-only deletion re-auth · `DELETE /v1/account/deletion` cancel
  contract); the Account card's last WCAG AA contrast violation fixed
  (`--warn-text` token) and pinned in E2E.

## Final verification state (M6 tip)

- 741/741 unit + integration tests · lint 0 warnings · typecheck clean
  (web/worker/db) · coverage thresholds met (core 97.91% lines; overall
  89.4% statements) · production build green · full real-browser E2E
  suite (incl. ClamAV attachment specs) green in CI.

## Remaining externally blocked items

1. **M6-i4 live provider verification** — needs Stripe + Razorpay
   test-mode credentials in an environment with network access to the
   provider APIs. Everything verifiable in-sandbox (state machines,
   signature verification, reconciliation, webhook ingress) is done and
   frozen; the increment resumes where it stopped (pre-flight) when
   credentials exist.

## Recommended next milestones (post-M6)

1. **M6-i4 resume** (the moment provider access exists) — live
   test-mode checkout → webhook → entitlements round-trip on both
   providers.
2. **M7: Google Calendar two-way sync** — the largest remaining PRD
   feature block (PRD §7.x calendar, §10 conflict rules already built
   for the sync engine).
3. Small follow-ups if desired: the documented `.offline-badge`
   sub-AA text contrast, an MFA challenge at deletion time (hardening
   candidate from M6-i8 §3), Windows desktop app, and the Phase-2
   items the PRD explicitly defers (passkeys, custom fields,
   workspace-level auth policies).
