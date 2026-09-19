# M5 conflict resolution and multi-device reliability — report

Date: 2026-09-10 (Asia/Calcutta). Scope: the next bounded M5 increment from
the [PHASE1_COMPLETION_PLAN.md](PHASE1_COMPLETION_PLAN.md) milestone table:
the conflict-resolution surface and the remaining multi-device sync scenarios.
**Explicitly not included** (deferred): the 5,000-mutation drain load test
(SY-10 — operational qualification), offline task editing/deletion via the
task editor and offline timers (only quick capture enqueues today), and the
Windows Tauri client. All M5 increment 1 behavior (sync protocol v1,
reconciliation, offline capture, cached Today fallback) is preserved
unchanged; the server-authoritative model is untouched.

## PRD requirements addressed

- **§8.6 System states — Conflict:** "Side-by-side local vs server values
  with per-field choose action." The `/conflicts` view renders each
  unresolved `conflict_snapshots` row as a card with a per-field table
  (Your version | Server version), the originating device id, capture time
  and 30-day recoverability expiry, and two explicit choose actions
  ("Keep my version" / "Keep server version"). Empty, loading and error
  states follow the §8.6 rows (explain + one primary action; human-readable
  error with retry affordance).
- **§10.6 Conflict resolution (table):** `server` keeps the canonical row
  and marks the snapshot resolved; `local` re-applies the preserved payload
  through the *same task command path* the online API uses (invariants,
  version bump, sync-change emission identical to an online edit) — verified
  to advance the version exactly once and emit a pullable change.
  Resolution of a snapshot whose task was deleted in the meantime is
  rejected with a clear 409 and the snapshot is left recoverable — no
  silent loss, no ghost resurrection.
- **§10.7 Idempotency:** the resolve endpoint runs under the shared
  `Idempotency-Key` ledger (unchanged retry with the same key replays the
  original acknowledgement with `Idempotent-Replay: true`; a changed body
  under the same key is `IDEMPOTENCY_CONFLICT`). The client holds one stable
  key per (conflict, choice) so a lost resolve acknowledgement can be
  retried without double-applying. Re-resolving an already-resolved snapshot
  is a safe no-op (no second write — version asserted unchanged).
- **§10.8 Ordering, retry, partial failure — "needs attention" surface:**
  quarantined local mutations are listed in the same view with their full
  saved raw payload and a **Retry now** action (resets the failure counters,
  re-queues the identical mutation; the mutation id dedup makes the retry
  duplicate-safe; nothing is ever deletable from the surface — no discard).
  The offline badge's "N changes need attention" text now links to the
  review surface, and the fixed badge chip is `pointer-events: none`
  (only the link is interactive) so it can never intercept clicks on page
  controls it overlaps.
- **§10.9 / §19.3 sync scenario matrix:** SY-06 through SY-09 are now
  explicit DB-backed scenarios (see Verification below); SY-01–SY-05 remain
  green. Multi-device ordering, conflict preservation, resolution, retries,
  reconnects and tenant isolation are covered by both the integration
  matrix and the new browser E2E (two real browser contexts as two devices
  of one account — separate localStorage device ids and IndexedDB
  queues/caches).
- **§8.8 / §19.2(13) accessibility:** the conflict view passes axe
  (wcag2a/aa/21aa/22aa) with a proper table (caption, `scope`d headers),
  labelled actions and live-region status/error announcements; the choose
  action is keyboard-operable (real button, Enter activation asserted).
  Two pre-existing light-theme token gaps were fixed while this surface
  exposed them: light `--accent` was 4.35:1 on the page background
  (sub-AA for link text — now `#1a5fd0`, 5.5:1) and the fixed offline
  badge could overlay page controls.
- **§11 security/privacy (touched areas):** conflict list/resolve are
  scoped to the authenticated workspace at the service layer (structural
  tenant isolation — a foreign id resolves to 404, and a foreign resolve
  attempt is a no-op that leaves both the snapshot and the task untouched);
  audit/observability follow the existing conventions (snapshot row is the
  durable, user-visible record of the decision).

## Files / architecture changed

| File | Change |
|---|---|
| `packages/contracts/src/schemas.ts` | `conflictSnapshotSchema`, `syncConflictResolveSchema` (+ types) |
| `apps/web/src/app/api/v1/sync/conflicts/route.ts` | New `GET /v1/sync/conflicts` — unresolved snapshots of the authenticated workspace |
| `apps/web/src/app/api/v1/sync/conflicts/[id]/resolve/route.ts` | New `POST /v1/sync/conflicts/:id/resolve` — idempotent, 404 for foreign/unknown ids, 409 when the target was deleted |
| `apps/web/src/server/services/sync.ts` | Added `loadConflictSnapshot` (workspace-scoped read). `listConflicts`/`resolveConflict` semantics unchanged |
| `apps/web/src/components/views/ConflictsView.tsx` | New view: side-by-side per-field conflict cards with choose actions; quarantined-mutation section with raw payload + retry; stable per-(conflict, choice) idempotency keys; event-driven refresh on `nextdoo-synced`/`nextdoo-queue-changed` |
| `apps/web/src/app/(app)/conflicts/page.tsx` | New route (auth-guarded) |
| `apps/web/src/components/Sidebar.tsx` | "Sync conflicts" entry |
| `apps/web/src/components/OfflineBadge.tsx` | Attention text links to `/conflicts` |
| `apps/web/src/lib/offline-queue.ts` | Added `requeueMutation` (user-directed re-attempt: resets counters, never deletes the payload) |
| `apps/web/src/app/globals.css` | Conflict-view styles; badge `pointer-events` fix; light-theme accent contrast fix |
| `apps/web/src/server/services/sync-scenarios.integration.test.ts` | SY-06, SY-07, SY-08, SY-09 + conflict-resolution/isolation scenarios (5 new tests) |
| `apps/web/e2e/conflict-resolution.spec.ts` | New: two-device conflict browse/keyboard-resolve; offline capture cross-device + tombstone propagation incl. cache cleanup; lost-ack idempotent retry + quarantine/retry UI; axe + navigation |

Architecture notes: no schema/migration changes (the snapshot store already
existed for increment 1); the resolve endpoint deliberately reuses
`resolveConflict` so the UI and the service-level path cannot diverge; the
client never resolves conflicts locally — the server is always the
adjudicator and every decision is pullable to other devices.

## SY-06–SY-10 verification

| ID | Scenario | Result |
|---|---|---|
| SY-06 | Complete on A, reschedule on B | **Green** — scalar due-date change applies (LWW), the completion and its `completedAt` survive the stale base; the earlier "completion outranks stale status edit" scenario remains green |
| SY-07 | Timer running on two devices | **Green** — second device start closes the first session `OVERLAPPED` (accumulated seconds preserved, `timer-overlap` tracking event), the newer session is canonical; a chronologically older third session records as `OVERLAPPED` without re-opening the canonical one; **no session row is ever deleted** |
| SY-08 | Clock skew of 10 minutes | **Green** — a +10-min skewed client cannot reorder the pull stream (server processing order wins); `sync_changes.createdAt` for its mutations is server time (asserted within 5 min of server now, far outside a 10-min skew) |
| SY-09 | Batch with one invalid mutation | **Green** — the invalid mutation (edit of a remotely deleted task) is `rejected` while its batch-mates apply; its content is preserved in a recoverable snapshot and the mutation is ledgered: exact replay returns the original rejection, a changed payload under the same id is `IDEMPOTENCY_CONFLICT`, and the deletion stands |
| SY-10 | 5,000 queued offline mutations | **Deferred** (explicitly out of this increment — operational load/SLO qualification) |

Conflict resolution extras (integration): `server` resolution changes
nothing but marks the snapshot; `local` resolution re-applies through the
task path with exactly one version bump and a pullable sync change;
re-resolve is a no-op; the second tenant neither lists nor resolves the
first tenant's snapshot and cannot touch its task.

## Verification evidence

- **Unit/integration (real Postgres):** 57 files / **574 tests** (569 +
  5 new scenarios), including the full SY-01–SY-09 matrix, conflict
  resolution semantics and cross-tenant isolation.
- **Browser E2E:** **125/125** (121 + 4 new) in ~3.4 min, including the new
  `conflict-resolution.spec.ts`: two-device same-title conflict browsed
  side-by-side and resolved by keyboard with axe-clean markup; offline
  capture on device A appearing on device B then deleted and
  tombstone-propagated to B's IndexedDB cache (no resurrection); lost
  acknowledgement (reset connection) retried to exactly one server entity;
  five 5xx failures quarantining the change with its full raw payload shown
  and a successful UI retry; and an axe (wcag2a/aa/21aa/22aa) pass on the
  conflicts screen.
- **Local gates:** lint 0 warnings; typecheck 5/5 packages; coverage
  **88.56%** statements overall (core **97.91%** vs the 85% threshold);
  production build green.
- **CI:** verified on the pushed commit (see commit log).

## Remaining M5 gaps

- **SY-10 / SLO:** 5,000-mutation drain under load with the §10.9 SLO
  measurements (99% ack < 5 s, integrity 99.9%) — operational
  qualification, explicitly deferred.
- **Offline breadth:** task editing/deletion through the task editor while
  offline, and offline focus timers (quick capture is the only enqueueing
  surface today).
- **Windows Tauri client:** local SQLite store, WebView2 shell,
  notifications, packaging/signing/update/rollback.
- **Conflict UX depth:** per-field mixed choices are applied
  per-snapshot (a snapshot's rejected set is chosen as a unit); finer
  per-field adjudication of multi-field snapshots, and conflict
  instrumentation dashboards (PRD §18 "conflict frequency"), remain.
