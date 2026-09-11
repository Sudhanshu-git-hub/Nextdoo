# M6 increment 3 — Multi-provider billing core (PRD §10.7, §18)

Bounded M6 slice: the **provider-agnostic billing core** — an internal
billing domain (subscription state machine, normalized event model,
entitlement synchronization) with **Stripe and Razorpay** adapters behind one
`PaymentProvider` interface. No provider concept leaks into the application:
web app, worker, DB layer and entitlements only ever see the internal model.
Webhooks are treated as untrusted (signature verification with replay
protection, per-provider event-id dedup, out-of-order tolerance, version
fencing). Entitlements come exclusively from server-normalized state through
the existing `readEffectivePlan()` source of truth. No Calendar/AI/desktop/
retention/portal work. No existing test weakened or deleted; no architecture
rewrite.

## Binding decisions (user-approved for this milestone)

- **Currency**: Stripe prices are USD, Razorpay plans/prices are INR; both
  map onto the same internal Nextdoo plans PRO / TEAM / ENTERPRISE.
- **Trials**: the internal state machine models the PRD `TRIALING` state
  (trial-ready); M1 checkout is **direct paid subscription** — no trial
  subscriptions are offered by the checkout endpoint.
- **`POST /v1/billing/portal`** is deferred to a later milestone; no
  Razorpay equivalent is invented.
- **Test/sandbox mode only** — production credentials are never required by
  the implementation or test suite, and none were used.

## What was built

### Internal model (`packages/billing` — new package, zero app dependencies)

- `types.ts` — provider-independent domain: `SubscriptionStatus`
  (ACTIVE / TRIALING / PAST_DUE / GRACE_PERIOD / PAUSED / CANCELED / EXPIRED),
  `PurchasablePlan` (PRO / TEAM / ENTERPRISE), `BillingEventType`,
  `BillingEvent` (normalized), `ProviderSubscriptionSnapshot`,
  `PaymentProvider` interface (`isConfigured`, `prepareCheckout`,
  `verifyWebhook`, `normalizeEvent`, `getSubscription`).
- `state-machine.ts` — the PRD transition table as pure functions:
  version-fenced state, `pendingPlan` + `pendingPlanEffectiveAt` for
  **deferred downgrades** (PRD §18.3: limits apply at the next period),
  immediate upgrades, 7-day grace clock on first failed payment
  (`PAST_DUE`), dunning (`GRACE_PERIOD`), illegal transitions refused with a
  `skipReason` (never silent).
- `normalize.ts` — shared safe extraction + `razorpayStatusToInternal`
  (e.g. `cancelled` ⇒ CANCELED while the paid period still runs, else
  EXPIRED; `halted` ⇒ GRACE_PERIOD vs EXPIRED by period).
- `plans.ts` — plan↔provider-reference mapping (Stripe price id per plan;
  Razorpay plan id + paise amount per plan) and amount-based plan
  resolution for Razorpay payments.
- `signature.ts` — pure signature verifiers: Stripe `t.`/`v1` pairs with a
  5-minute replay window (any out-of-window pair poisons the header);
  Razorpay raw-body HMAC with event `created_at` age ≤ 15 min + 5 min clock
  skew (Razorpay stamps no header timestamp). Constant-time comparison.
- `reconcile.ts` — field-level drift comparison between the local row and the
  provider's current snapshot (alert-only; the job never self-rewrites state).
- `config.ts` — `buildBillingProviders(env)`: each provider is either fully
  configured or **absent**; `requireProvider` fails loud with
  `PROVIDER_UNAVAILABLE` (503) — never a silent stub, never a fallback to
  the other provider.

### Adapters

- **Stripe** (`adapters/stripe.ts`): REST (customers, checkout sessions,
  subscription fetch), `prepareCheckout` → hosted-checkout redirect
  (`REDIRECT`), webhook verification, normalization of
  `checkout.session.completed`, `customer.subscription.*`,
  `invoice.payment_failed`, `invoice.paid`, `charge.refunded`.
- **Razorpay** (`adapters/razorpay.ts`): REST (customers, orders,
  subscription fetch), `prepareCheckout` → order + embedded checkout
  parameters (`EMBEDDED_CHECKOUT`, INR paise), webhook verification,
  normalization of `payment.captured` (activation, plan from `notes.plan` or
  amount), `payment.failed`, `refund.*`, `subscription.charged` (renewal +
  period end), `subscription.cancelled`, `subscription.completed`,
  `subscription.halted` (dunning), paused/resumed.

### DB layer (`packages/db/src/billing-sync.ts`, migration 0020)

- Migration 0020 (idempotent): `billing_provider` enum;
  `subscriptions.provider` / `provider_plan_ref` / `pending_plan` /
  `pending_plan_effective_at` / `last_event_at`; `billing_events.provider` /
  `user_id` / `received_at`; **per-provider** event-id uniqueness
  (the same id in two providers is not a duplicate); partial index on
  `(provider, provider_subscription_id)`.
- `startCheckout` — idempotent customer upsert per (user, provider),
  provider handoff, `billing.checkout_started` audit; a user already bound to
  a different provider cannot silently switch (`VALIDATION_FAILED`).
- `handleBillingEvent` — one transaction per event: persist + **dedup first**
  (same (provider, event id) applied exactly once), tenant resolution
  strictly through **this provider's** stored mapping (subscription id, then
  customer id), stale-provider-subscription guard, **event horizon**
  (`lastEventAt` − 60 s tolerance ⇒ `stale_event` skip), state machine,
  version-fenced write (`FOR UPDATE` + version compare, retry ×3),
  audit on every resolved event (applied, skipped, unresolved), event row
  linked to its owner.
- `applyBillingDeadlines` — the sweep: trial end → EXPIRED, grace
  exhaustion → EXPIRED, canceled + paid period over → EXPIRED,
  pending downgrade due → plan swap (data preserved). Idempotent.
- `reconcileBilling` — per-provider `getSubscription` comparison, drift
  reported with field diffs + `billing.reconciliation_drift` audit
  (alert-only).
- `getBillingSubscriptionState` — the server-authoritative view
  (`plan`, `effectivePlan` via `readEffectivePlan`, status, provider,
  period/grace/trial/pending fields) served to the client; it displays, it
  never grants.

### Web (`apps/web`)

- `server/billing.ts` — the only place providers are constructed
  (HMR-safe singleton) and the fail-loud `requireProvider`.
- `GET /api/v1/billing/subscription` (120 rpm) — the authoritative view.
- `POST /api/v1/billing/checkout` (12 rpm, idempotent) — plan + provider;
  returns a **handoff only** (redirect URL / embedded parameters);
  entitlements change exclusively via verified webhooks. Unconfigured
  provider ⇒ 503 `PROVIDER_UNAVAILABLE`.
- `POST /api/v1/billing/webhooks` (600 rpm, public) — provider selected by
  the **signature header's presence** (never a client claim); empty body ⇒
  400, no signature ⇒ 400, both signatures ⇒ 400 (ambiguous); then
  verify → normalize (unrelated events acked + ignored) → dedup → resolve →
  apply; 200 once accepted with `{ received, ignored, duplicate, applied,
  unresolved }`.
- Env (`server/env.ts` + `.env.example`): `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `STRIPE_PLANS` (price ids JSON),
  `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`,
  `RAZORPAY_PLANS` (plan ids + paise JSON). All optional — absent ⇒ that
  provider is unavailable (503), the app otherwise runs normally.

### Worker (`apps/worker/src/jobs.ts`)

- `billing.sweep` (5 min) — `applyBillingDeadlines` over the whole DB.
- `billing.reconcile` (24 h) — `reconcileBilling` per configured provider,
  drift logged as `billing.reconciliation_drift`.

## Security model (webhooks are untrusted)

1. Signature verification **before** any JSON parsing of the body
   (Stripe: header timestamp + HMAC; Razorpay: raw-body HMAC + event-age
   window). Forged / tampered / replayed / unsigned ⇒ 401, no state, no row.
2. Normalization to the internal model; events without subscription meaning
   are acked and ignored.
3. Per-provider event-id dedup — the same delivery (or a re-send with a new
   payload under the same id) is applied exactly once.
4. Tenant resolution scoped to the event's provider only — foreign, unknown
   and cross-provider customers can never touch another tenant's row.
5. Version-fenced application; illegal transitions and out-of-order events
   are skipped **with audit** (`billing.event_skipped`), never corrupting.
6. The checkout round-trip grants nothing; entitlements move only on
   verified webhooks or the deadline sweep, always through
   `readEffectivePlan()`.

## Tests (all hermetic — generated secrets, stubbed provider REST)

- `packages/billing` unit suites — **62 tests**: signature verification
  (valid/forged/tampered/replayed/future/rotated secrets, both schemes),
  state machine (full PRD table incl. illegal-transition refusals), plan
  mapping, reconciliation drift, adapter normalization for BOTH providers.
- `billing-lifecycle.integration.test.ts` (web, real PG) — **31 tests**
  running the **same 12-area matrix for Stripe and Razorpay** through the
  real sync service: unconfigured 503 + checkout handoff/customer reuse/
  audit; activation → entitlement flip via `readEffectivePlan`; forged/
  tampered/replayed/unsigned rejection; duplicate idempotency (id, not
  payload, is the key); upgrade immediate / downgrade deferred with data
  preserved and limits re-evaluated; cancellation grace (access through the
  paid period, then EXPIRED); failed payment (7-day grace, recovery,
  dunning, exhaustion); version fencing + illegal-transition audit; stale
  out-of-order skip → reconciliation drift (alert-only) → fresh re-delivery
  converges; tenant isolation (foreign / unknown / cross-provider); refunds
  audited without state change; clean reconciliation + unconfigured
  no-op; plus cross-provider checkout conflict, a 5-case deadline-sweep
  idempotency test, and expiry-to-FREE enforcement (over-limit data
  preserved, new creates blocked at the FREE caps).
- `e2e/billing.spec.ts` (real HTTP, API-only — these endpoints have no
  browser surface) — **3 tests** against the unconfigured deployment:
  subscription view auth-gated + server-normalized FREE; checkout 503
  `PROVIDER_UNAVAILABLE` for BOTH providers with no state change; webhook
  ingress untrusted (no/ambiguous signature ⇒ 400, forged signature for an
  unconfigured provider ⇒ 503) with entitlements untouched.

**Live sandbox checkout and live webhook delivery are OUT of scope and are
explicitly NOT claimed** — every provider interaction above is a generated
test secret or a stubbed REST call.

## Verification (local, PG 18)

- Lint 0; typecheck clean in all 6 packages; production build green.
- Full suite: **65 files / 692 unit + integration tests, all passing**
  (incl. the 62 package tests, 31 lifecycle tests and the pre-existing
  suites — no regressions).
- E2E billing spec: **3/3 passing** locally against `next start`.

## CI outcomes (recorded as verified)

(Updated after the CI run — see the implementation log entry for this
milestone.)

## What is still required for live sandbox verification (exact list)

Everything below is **test-mode / sandbox only**. Nothing in this milestone
requires live credentials to build, test or deploy.

| Item | Stripe | Razorpay |
| --- | --- | --- |
| API credential | `STRIPE_SECRET_KEY` = `sk_test_…` (test-mode secret key) | `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET` = test-mode key pair (`rzp_test_…`) |
| Webhook secret | `STRIPE_WEBHOOK_SECRET` = `whsec_…` from the test-mode webhook endpoint | `RAZORPAY_WEBHOOK_SECRET` = webhook secret from the test-mode dashboard |
| Plan/price mapping | `STRIPE_PLANS` = JSON of **test-mode price ids** `{"PRO":"price_…","TEAM":"price_…","ENTERPRISE":"price_…"}` (USD prices for the PRO/TEAM/ENTERPRISE amounts) | `RAZORPAY_PLANS` = JSON of **test-mode plan ids + paise** `{"PRO":{"id":"plan_…","amountPaise":…},"TEAM":{…},"ENTERPRISE":{…}}` (INR plans) |
| Webhook endpoint | Deliver to `{APP_URL}/api/v1/billing/webhooks`, enabled events: `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.payment_failed`, `invoice.paid`, `charge.refunded` | Deliver to the same URL; events: `payment.captured`, `payment.failed`, `refund.completed`, `subscription.charged`, `subscription.cancelled`, `subscription.completed`, `subscription.halted` |

With those set, a live sandbox pass would verify: checkout handoff →
payment in the provider's test console → real webhook delivery → entitlement
flip, plus reconciliation against the live provider view. That pass is the
**next milestone's verification step**, not part of this one.

## Known limitations / next

- `POST /v1/billing/portal` (self-serve management) — deferred by decision;
  no Razorpay portal equivalent invented.
- Trial checkout (offering `TRIALING` at purchase) — state machine is
  trial-ready; the M1 checkout offers direct paid subscriptions only.
- Live sandbox verification — blocked on the test-mode credentials above.
- Razorpay plan change (upgrade/downgrade) is modeled through
  `subscription.charged` with the new plan id; provider-side change-of-plan
  API usage is out of scope (webhook-driven convergence covers it).
- Invoices/receipts, tax and dunning email cadence are out of scope
  (PRD §18.4+ later increments).
