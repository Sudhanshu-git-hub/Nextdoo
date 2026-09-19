# M5 cross-platform reliability — first bounded increment (sync protocol v1, offline capture, reconnect reconciliation)

Commit: `6ae9cf9` on `arena/01a085b7-nextdoo` (branched from `ba24998`, the
green M4 reporting state).

Scope: one bounded milestone — **server push/pull correctness,
version/tombstone protection, scoped IndexedDB queue primitives, Today
cached fallback/recovery, and the safe enqueue/reconcile semantics required
by PRD §10**. No Windows/desktop, provider, AI, or billing work was started.

This increment builds on (and does not rework) the existing protocol v1
implementation: the `/v1/sync/push` and `/v1/sync/pull` routes,
`pushMutations`/`pullChanges`/`listConflicts`/`resolveConflict`, the
`sync_changes`/`sync_tombstones`/`sync_mutations`/`conflict_snapshots`
tables, `mergeEntity` conflict semantics, and the pre-existing scoped
`offline-queue.ts` primitives.

## PRD requirements completed

- **Roadmap item 7 — sync protocol v1 scenario matrix SY-01 through SY-05
  green** (explicit, named, DB-backed scenarios in
  `sync-scenarios.integration.test.ts`):
  - **SY-01** offline create: a create with a client-generated UUID is
    applied with that exact server id and is visible to the other device
    via `pull` from cursor 0.
  - **SY-02** replay: re-pushing an identical batch returns `duplicate`
    and never creates a second entity (row count and version unchanged);
    replaying an update returns the original outcome without advancing
    state.
  - **SY-03** different fields: concurrent edits to different fields on
    two devices are both retained.
  - **SY-04** same field: a same-field (title) conflict is surfaced as
    `conflict`, both contents are preserved (server value kept, local value
    retained in `conflict_snapshots`), and `resolveConflict('local')`
    applies the local value and clears the open conflict.
  - **SY-05** delete wins: a remote delete propagates through `pull` as a
    `delete` operation, a pending stale edit is rejected with its payload
    preserved (30-day retention), a tombstone row exists, and
    `restoreTask` resurrects the task and removes the tombstone.
- **Push/pull ordering:** same-entity mutations in one batch apply in FIFO
  order (each acknowledgement reflects the state at its position; final
  version = base + N), and `pull` returns strictly ascending sequence with
  monotonic cursor continuation across pages.
- **Tombstone protection:** delete-of-deleted is a `duplicate`; edits to a
  deleted task are rejected and preserved in a snapshot with a >29-day
  `expiresAt`; completion outranks a concurrent stale status edit
  (completion preserved, refused edit retained for review).
- **Tenant isolation:** a second account cannot write another account's
  entities (scoped `NOT_FOUND`), cannot relabel a push as another workspace
  (rejected), and its `pull` stream contains none of the first account's
  changes; client caches are scoped the same way (E2E).
- **PRD §10.4 client stores:** the client now stores cached entities,
  pending mutations, **received server changes applied to the cache
  (updates and tombstone deletions)**, a **per-workspace sync cursor
  (IndexedDB `meta` store)**, and a device identifier — every store keyed
  by workspace provenance.
- **PRD §10.3 safe enqueue:** offline capture via the deterministic local
  parser (same grammar the server route wraps — no model), client-generated
  entity id, durable enqueue, optimistic cached row. Enqueue happens only
  on network failure or 5xx — never on 4xx — and the same client id goes
  into the online request as `clientMutationId`, so a create whose response
  was lost dedupes to `duplicate` on the later push (no twin task).
  Recurrence captures are refused offline without losing the user's text
  (recurrence commands can only be applied online).
- **PRD §10.3/§10.8 reconcile semantics:** the app-global loop recovers on
  mount (a reload/crash does not strand the queue), drains on reconnect,
  on new work arriving while online, on tab visibility, and per the stored
  1 s → 5 min jittered backoff; quarantined items never auto-retry; after
  a pass that applied mutations or pulled changes, views refresh.
  Quarantine is surfaced (PRD §10.8 "needs attention") in the shell badge.
- **Today cached fallback/recovery** (PRD §6.9 warm cache): on fetch
  failure Today shows the last saved copy with a stale banner (existing,
  retained); the loop now recovers the queue on mount/reconnect and applies
  pulled tombstones, so a cached copy can never resurrect a task another
  device deleted, and recovery to live data clears the stale state.

## Files / architecture changed

| File | Change |
|---|---|
| `apps/web/src/app/api/v1/tasks/route.ts` | Honors the reserved `clientMutationId` as the create's entity id (replay-safe creates; existing online API otherwise unchanged) |
| `apps/web/src/lib/offline-queue.ts` | DB v3 `meta` store; per-workspace sync cursor; `cacheTask` (provenance-checked single row); `applyPullPage` (update/create apply, delete removes — tombstone semantics, idempotent, cursor advanced only after durable apply); `pullSync` (bounded pagination); `pendingSummary` (waiting vs needs-attention); `earliestRetryAt`; `reconcileOnce` (flush then pull); queue-changed event; SSR-safe `getDeviceId` |
| `apps/web/src/lib/use-sync-reconcile.ts` | **New** — app-global reconcile loop (mount recovery, online/visibility/grew triggers, stored-backoff scheduling, no hot loops, `nextdoo-synced` event) |
| `apps/web/src/components/OfflineBadge.tsx` | Owns the reconcile loop (app shell, every view); event-driven counts (replaces 1.5 s poll); surfaces queued count + needs-attention count (PRD §10.8) |
| `apps/web/src/components/QuickCapture.tsx` | Offline capture: local deterministic parse fallback, client-UUID create, durable enqueue + optimistic cache row, "Saved offline" acknowledgement; 4xx never enqueued; recurrence refused offline without losing text |
| `apps/web/src/components/views/TodayView.tsx` | Refreshes on `nextdoo-synced`; per-view flush listener removed (loop is now global) |
| `packages/core/package.json` | Client-safe `./nl-parse` subpath export (root barrel pulls server-only `node:crypto` via totp) |
| `apps/web/src/server/services/sync-scenarios.integration.test.ts` | **New** — explicit SY-01..SY-05 + ordering/tombstone/tenant/completion scenarios |
| `apps/web/src/lib/offline-queue.test.ts` | +8 unit tests: cursor scoping, provenance-checked cache, pull application + tombstones, pagination, summary split, retry scheduling (quarantine excluded), reconcile drain+pull, offline no-pull |
| `apps/web/e2e/sync-offline.spec.ts` | **New** — real-browser offline mode (no mocked fetches): offline capture → reconnect → reconciliation with canonical-id match; cached Today fallback + recovery; cross-account isolation of queue/cache/server |
| `apps/web/e2e/online.spec.ts` | Lost-ack capture test updated to the durable-enqueue behavior (server dedupes by entity id; assertions strengthened — one task, one tag, queue drained) |

## Offline/sync invariants verified

1. **Nothing typed is lost:** offline captures are acknowledged
   ("Saved offline…"), visible immediately from the local cache, and
   durable (IndexedDB) before any sync.
2. **No silent discard:** 4xx surfaces the server's answer and never
   enqueues; 5xx/network enqueues; refused/conflicted server payloads are
   retained in 30-day snapshots; quarantine is surfaced, not hidden.
3. **No twin tasks:** one client entity id for the whole lifetime of a
   capture; online create, lost response, and sync re-push all resolve to a
   single server row (E2E + scenario test).
4. **Server is authoritative:** pull applies the server's changes —
   including deletions — to the cache; a stale cached copy cannot
   resurrect deleted work; the cursor only advances after durable apply
   (crash → re-apply, never skip).
5. **Tenant boundaries at every layer:** push (entity scope + workspace
   relabel rejection), pull (per-workspace stream), queue (workspace key
   + identity index), cache (provenance-checked writes and reads), device
   identity (per browser profile).
6. **Ordering:** FIFO per entity within a batch and across the pull
   stream; each batch acknowledgement reflects the state at its position.
7. **Backoff per PRD §10.8:** 1 s base, 5 min cap, ±20% jitter, 4xx
   quarantines immediately (no blind retries), network failures never
   count toward quarantine, and the loop never hot-polls (event + stored
   retry times only).

## Test / E2E / coverage / build / CI results

- **Unit + integration:** 568/568 across 57 files (baseline 550/55: +18 —
  10 sync scenarios + 8 queue-primitive tests).
- **E2E (real Chromium, real offline mode):** 121/121 (baseline 118: +3 in
  `sync-offline.spec.ts`, 1 updated in `online.spec.ts`).
- **Coverage:** 88.63% statements (baseline 88.41%); no threshold failure.
- **Lint** 0 warnings; **typecheck** clean (web + all packages);
  **`next build`** green (client bundle verified free of server-only
  imports via the `./nl-parse` subpath).
- **Migrations:** none added — the increment reuses existing tables
  (client-side `meta` store is IndexedDB, not a schema change).
- **CI:** reported at milestone closure on `6ae9cf9`.

## Remaining M5 gaps (later increments)

- Conflict **resolution view** (browse/resolve `conflict_snapshots` in the
  UI) — currently surfaced by count only; server-side
  `listConflicts`/`resolveConflict` already exist.
- SY-06 through SY-10 and multi-device cross-device scenarios in the
  matrix (SY-06 timer overlap exists only at the core `resolveTimerOverlap`
  level; SY-07/08/09/10 not yet scenario-tested).
- 5,000-mutation drain / queue-depth instrumentation and SLO qualification
  (99% ack < 5 s, 99.9% integrity) under load.
- Full offline mode breadth: offline capture today covers quick capture
  (create); offline edits/deletes via the task editor, offline timers, and
  other views are not yet enqueued.
- Windows Tauri/SQLite/WebView2 client, desktop notifications, packaging,
  signing, update and rollback.
