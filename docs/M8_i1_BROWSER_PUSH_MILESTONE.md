# M8-i1 Milestone — Browser Push Notification Channel

**Status:** COMPLETE (local battery green; CI verification pending — see §9)
**Scope source:** `docs/M8_ROADMAP_AUDIT.md` §4.2 (bounded channel, no Phase-2 promotion)
**PRD anchors:** §6.6 (channels, delivery status), §9.3 (channel abstraction), §11.1 (integrity), §12.4 (retry/idempotency), §13.2 (registrations), §14.8 (rate limits)

---

## 1. Architecture

Push is a **new channel inside the existing reminder dispatch path** — no parallel
engine. Scheduling, CANCELED/EXPIRED gating, versioning, audit and the
notification center are all the existing ones.

```
UI (opt-in, /sw.js)                 Worker (push.deliver, 10 s)
   │  POST /api/v1/push/subscriptions        │
   ▼                                        ▼
push_subscriptions ───── dispatch ───► push_deliveries (one row per
 (user, endpoint) UNIQUE      │           (reminder_id, subscription_id) UNIQUE)
                              ▼
              reminder status = SENT (durable queueing recorded)
                              │
                              ▼
              deliverPushDeliveries(db, limit, transport|null)
              lease claim (skip-locked) → transport.send(endpoint, payload)
                 2xx → SENT (payload scrubbed)
                 404/410 → subscription deleted + FAILED 'SUBSCRIPTION_GONE'
                 else  → PENDING backoff min(300, 2^attempts) s; 5th → FAILED
              refreshReminderPushErrors → reminder.last_error (notification-center surface)
```

Key decisions:

1. **Dedicated tables, not `device_registrations`.** `device_registrations`
   (PRD §13.2) is a device *inventory* (device_id/platform/last-seen heartbeat
   for the desktop channel). Web Push subscriptions are user-scoped
   endpoint+key pairs with provider semantics (410 lifecycle, 24 h expiry) —
   different schema and lifecycle. Mixing them would couple two channels that
   must evolve independently.
2. **No double delivery per `(reminder_id, channel)`.** The unique
   `(reminder_id, subscription_id)` key on `push_deliveries` is the
   crash-retry guarantee; dispatch inserts with `onConflictDoNothing`, and a
   single in-app `notifications` row (unique per reminder) is the durable
   center record independent of device count.
3. **Bounded, honest retries.** 5 attempts, backoff `min(300, 2^attempts)` s,
   10-minute leases (same lease pattern as mail delivery), 24-hour payload
   expiry with content scrubbing (payload is notification text — scrubbed on
   every terminal state so no sensitive content outlives delivery).
4. **Registration is gated on VAPID configuration.** Without VAPID keys the
   public-key and subscribe endpoints answer 503 `PROVIDER_UNAVAILABLE`,
   PUSH reminders are rejected at creation, and worker delivery is a no-op
   (null transport). No undeliverable registrations accumulate; the UI shows
   the unconfigured state. This mirrors the billing/SMTP "no stub fallback"
   posture.
5. **PUSH coexists with WEB.** A PUSH reminder also records one in-app
   notification (the center's delivery-status surface); a WEB reminder never
   touches the push queue. Both channels can be scheduled on the same task.
6. **Terminal outcomes surface through the existing reminder history**
   (`last_error`): `NO_PUSH_SUBSCRIPTIONS`, `PUSH_DELIVERY_FAILED`,
   `PUSH_SUBSCRIPTIONS_GONE`; any successful send clears it.

## 2. Files, routes, schema

### Schema (migration `packages/db/migrations/0022_push_notifications.sql`)

- `reminder_channel` enum += `PUSH` (idempotent `ALTER TYPE`).
- `push_subscriptions(id, user_id, endpoint, p256dh, auth, created_at, updated_at)`,
  `UNIQUE(user_id, endpoint)` (dedupe), FK cascade to users.
- `push_deliveries(id, reminder_id, subscription_id, user_id, workspace_id,
  task_id, payload, status[PENDING|PROCESSING|SENT|FAILED|EXPIRED], attempts,
  next_attempt_at, lease_token, lease_until, sent_at, last_error, expires_at,
  …)`, `UNIQUE(reminder_id, subscription_id)`, claim index
  `(status, next_attempt_at, id)`.

### Contracts (`packages/contracts`)

- `REMINDER_CHANNEL += 'PUSH'`.
- `pushSubscriptionSchema` (strict): `endpoint` URL ≤ 2048,
  `expirationTime` number|null|absent (real `toJSON()` shape),
  `keys.p256dh` base64url 40–255, `keys.auth` base64url 16–64.

### DB engine (`packages/db`)

- `push-subscriptions.ts` — register (idempotent on conflict) / list / remove,
  all strictly user-scoped.
- `push-delivery.ts` — `deliverPushDeliveries(db, limit, transport|null)`
  (lease hygiene, skip-locked claim, outcome handling, backoff, expiry/scrub,
  410 subscription removal) + `refreshReminderPushErrors` (reminder
  `last_error` aggregation). `PushTransport` is dependency-injected: the
  worker supplies `web-push`; tests supply deterministic stubs.
- `reminder-delivery.ts` — PUSH branch in the dispatch transaction:
  user's active subscriptions (limit 50) → one `push_deliveries` row each +
  one in-app notification → reminder `SENT`; zero subscriptions → `FAILED
  'NO_PUSH_SUBSCRIPTIONS'`.
- `purge.ts` — account purge deletes subscriptions and deliveries (no orphan
  keys or payloads).
- `schema.ts` / `index.ts` — table definitions and exports.

### Web app (`apps/web`)

- `src/server/env.ts` — optional `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`;
  `features().browserPush` gate (both keys required).
- `src/app/api/v1/push/public-key/route.ts` — `GET` (authed) →
  `{ vapidPublicKey }`; 503 when unconfigured.
- `src/app/api/v1/push/subscriptions/route.ts` — `GET` list (own only),
  `POST` register (idempotent, rate-limited 60/min, schema-validated),
  `DELETE` `{endpoint}` (idempotent, own only).
- `src/server/services/push-subscriptions.ts` — service layer: VAPID gate
  (503 `PROVIDER_UNAVAILABLE`), re-validation at service level (direct
  callers cannot persist malformed keys), user-scoped DB calls.
- `src/server/services/reminders.ts` — `createReminder` accepts `PUSH`
  (rejected when push unconfigured: no guaranteed-failure reminders);
  `snoozeReminder` works for `PUSH` like `WEB`.
- `src/lib/push-client.ts` — browser helper: capability detection,
  `/sw.js` registration, permission (only inside the explicit click),
  subscribe/unsubscribe via the app's `api` helper (idempotency + origin
  headers consistent with the rest of the app).
- `public/sw.js` — push handler (display, tag, data) + notificationclick
  (focus existing window at the payload URL, else open it). No caching, no
  other responsibilities.
- `src/components/views/NotificationsView.tsx` — "Browser push" card
  (available / not configured / not supported / blocked states, enable &
  disable on this device), Delivery selector (In-app / Browser push — PUSH
  enabled only with a registered subscription), copy updates.
- `playwright.config.ts` — E2E web server receives a fixed **test-only**
  VAPID pair (committed; override via env).

### Worker (`apps/worker`)

- `push-transport.ts` — `web-push` (VAPID signing, payload encryption);
  reports the provider HTTP status; null when unconfigured.
- `jobs.ts` — `push.deliver` job (10 s cadence, batch 10).
- New deps: `web-push` (runtime), `@types/web-push` (dev) — worker-only.

### Tooling

- `eslint.config.mjs` — ignores `apps/web/public/**` (service worker is
  worker-scoped JS, not app code).

## 3. Acceptance criteria (M8 audit §4.2) → evidence

| # | AC | Evidence (deterministic, CI-verifiable) |
|---|----|------------------------------------------|
| 1 | Opt-in → due reminder delivered via stub push → center shows `SENT` | E2E `push-notifications.spec.ts` "explicit opt-in…" (real SW, real API, real dispatch → `SENT`, center history shows `PUSH`); integration "delivers to every registered device exactly once" (stub transport → `SENT`, payload scrubbed) |
| 2 | Task completion cancels pending reminders; no further push | Integration "respects completion, cancellation and the 24h expiry window" (CANCELED, 0 delivery rows) |
| 3 | No double push per `(reminder_id, channel)`; replay is a no-op | Integration "dispatches a PUSH reminder durably per subscription… without doubling" (concurrent dispatch → 1 in-app record, re-run no-op, unique key rejects a duplicate queueing attempt) |
| 4 | >24 h overdue → `EXPIRED`, no push | Integration "respects completion…" (EXPIRED, 0 rows) + "expires undelivered push payloads after 24h" (queue-level EXPIRED + payload scrub) |
| 5 | Unsubscribe/410 removes registration; remaining channels still deliver | Integration "removes a gone subscription on 410, keeps siblings delivering" + "exposes all-gone as PUSH_SUBSCRIPTIONS_GONE"; E2E opt-out (server registration gone, channel re-locked) |
| 6 | Tenant isolation (user A's subscription never used for user B) | Integration "registers, validates, dedupes and removes user-scoped push subscriptions" (cross-user list/remove are no-ops); E2E "subscription lifecycle routes enforce authentication, ownership and payload validation" (401s, foreign user cannot remove) |
| 7 | Unsupported browser degrades silently; in-app unaffected | E2E "unsupported browsers degrade cleanly" (capabilities removed pre-load → degraded card, PUSH option disabled, WEB reminder works end-to-end); unconfigured integration file (503s, PUSH creation rejected, WEB green) |
| 8 | No test weakened/deleted; full suite, coverage, typecheck, lint, build, CI green | Measured in §4 (CI: §9) |

## 4. Validation battery (local, 2026-09-14)

| Check | Result |
|-------|--------|
| Vitest (full, `nextdoo_test` DB) | **815/815 passed** (two consecutive full runs; an initial run had one non-reproducing clock-drift flake, fixed by widening the test scheduling margin 1 s → 60 s and re-verified) |
| New push integration tests | 18/18 (`push-notifications` 14, `push-unconfigured` 4) |
| Playwright E2E (full) | **151/151 passed** (+4 new push specs). The attachments suite's `beforeAll` refuses to run without ClamAV (`ATTACHMENT_SCAN_ENGINE_MISSING`) — pre-existing environmental refusal, by design, file untouched by this milestone |
| Coverage | statements **88.88 %**, branches 81.22 %, functions 92.85 %, lines 92.73 % (baseline 88.89 % stmts — new push code is test-covered) |
| Typecheck | contracts, db, worker, web — all clean |
| Lint | clean (`--max-warnings=0`) |
| Build | clean |

**Honest scope of the E2E (labeled in the spec header):** real browser, real
service worker, real permission/opt-in flow, real HTTP API, real dispatch.
The browser↔push-service handshake is doubled at the browser boundary
(`PushManager.subscribe` stubbed with a well-formed subscription) because the
sandbox/CI have no egress to a Web Push provider, and this headless build
cannot be granted real notification permissions (also stubbed, labeled).
**No real push provider delivery is claimed anywhere**; server-side delivery
is exercised deterministically with the injected stub transport.

## 5. Degradation matrix (all tested)

| Condition | Behavior |
|-----------|----------|
| VAPID unconfigured (server) | 503 `PROVIDER_UNAVAILABLE` on public-key/subscribe; PUSH reminder creation rejected; worker delivery no-op; UI "not configured"; WEB unaffected |
| Browser without Web Push APIs | UI "not supported"; no SW registration beyond feature detection; PUSH option disabled; WEB unaffected |
| Notification permission denied | UI "blocked" card, no opt-in button, no forced prompt |
| Push service unreachable from browser | Opt-in fails with a clear message; state preserved; retry on demand |
| Provider 404/410 | Subscription deleted (idempotent); delivery terminal `SUBSCRIPTION_GONE`; siblings keep delivering; all-gone → reminder `PUSH_SUBSCRIPTIONS_GONE` |
| Transient provider failure (429/5xx) | Backoff `min(300, 2^attempts)` s; terminal `PUSH_DELIVERY_FAILED` after 5 attempts; payload scrubbed; reason in reminder history |
| >24 h undelivered | `EXPIRED`, payload scrubbed |
| Account purge | Subscriptions + deliveries removed with the account (no orphan keys/payloads) |

## 6. Security

- Every lifecycle route is authenticated and user-scoped (own registrations
  only; cross-user read/remove are no-ops); unauthenticated → 401; malformed
  payloads → 400 without persistence; rate limits per §14.8 (60/min).
- Only `endpoint/p256dh/auth` are stored — no user-agent, no client secrets,
  nothing logged.
- Payload scrubbing on every terminal state; 24 h expiry.
- VAPID keys are env-configured (never committed except the labeled
  test-only pair); the worker is the only component holding the private key.

## 7. Production external dependencies (required ONLY to enable push)

1. **VAPID keypair** — generate once
   (`node -e "import('web-push').then(m=>console.log((m.default??m).generateVAPIDKeys()))"`),
   set `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` (base64url) in the **web**
   (public key served + subscription API) and **worker** (signing)
   environments; optional `VAPID_SUBJECT` (mailto:/https: VAPID claim).
2. **Egress from the worker host** to push-service endpoints
   (the per-subscription `endpoint` URLs — e.g. the push service chosen by the
   subscribing browser). Without egress, deliveries stay PENDING/FAILED
   honestly; nothing is faked.
3. **Browser-side egress** on each user device (subscribe + delivery).
4. No new DB, no new service, no new queue infra — PostgreSQL + the existing
   worker.

## 8. Known environment limitations (not defects)

- This sandbox/CI has no push-provider egress → real browser delivery cannot
  be verified here (spec doubles the handshake, labeled).
- Headless build cannot grant real notification permissions → permission API
  stubbed in the opt-in E2E (labeled).
- ClamAV absent → attachments E2E suite refuses to run (by design, pre-existing).

## 9. CI

Local battery green. GitHub push/CI verification is **pending**: the sandbox's
GitHub token expired mid-session (401 on all API + git fetch/push); the
recovered local tree is committed on `arena/01a085b7-nextdoo` and will be
pushed + CI-verified as soon as the GitHub connection is re-established.
