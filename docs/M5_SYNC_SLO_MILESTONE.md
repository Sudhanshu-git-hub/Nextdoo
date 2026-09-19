# M5 increment 3 — SY-10 5,000-mutation drain and §10.9 SLO qualification

Date: 2026-09-10 (Asia/Calcutta). Scope: measurement and reliability
qualification only — **no new product features**. The harness exercises the
existing sync/offline implementation exactly as the client would (same
service calls, same batch size, same queue state machine) and verifies the
PRD §10.9 SLOs plus the integrity properties named in the milestone brief.
All M5 increments 1–2 behavior is preserved unchanged (full suite green,
zero regressions).

## PRD requirements qualified

- **§10.9 "99% of connected mutations acknowledged within 5 seconds"** —
  measured with a 200-mutation connected burst (single-mutation pushes, as a
  connected client sends them): **100% under 5 s** (p50 10 ms, p95 12 ms,
  p99 13 ms, max 31 ms). The full offline drain also stays under the
  envelope: the largest 200-mutation batch acknowledged in 3.0 s.
- **§10.9 "99.9% of successful sync operations preserve data integrity"** —
  every acknowledged mutation was verified against a reference model:
  **100.0%** (3,685/3,685 entities exact on status, version, title,
  description, priority and due-at; zero mismatches).
- **§10.9 "No known silent data loss"** — zero: no duplicate entities, no
  lost mutations, every rejected mutation retained (client-side quarantine
  or recoverable conflict snapshot with the exact preserved payload),
  ledger reconciliation exact (one row per unique mutation id).
- **§10.9 "Conflict resolution must be observable and testable"** — 50
  same-field conflicts and 75 update-of-deleted rejections each produced a
  recoverable `conflict_snapshots` row (125 total, payload byte-equal to the
  client's preserved content), surfaced by the increment-2 review surface.

## Workload and harness

New files (repeatable — the exact code path that produced the recorded
numbers now runs in every CI verify):

- `apps/web/src/server/services/sync-slo-harness.ts` — workload generator,
  faithful client-queue drain simulator (200-mutation batches, per-entity
  head-of-line eligibility, applied/duplicate dequeue, conflict/rejected
  quarantine, 2s→300s backoff, auto-quarantine after 5 server failures,
  simulated connection-level 500 injection), reference-model builder and
  integrity verifier.
- `apps/web/src/server/services/sync-slo.integration.test.ts` — the
  qualification test (2 tests) asserting every hard property and printing
  the measurement summary.

Workload: **5,000 mutations, 4 devices, one tenant** (plus a 5-mutation
quarantine device and a 200-mutation connected burst, reported separately):

| Device | Mutations | Mix (hard cases included) |
|---|---|---|
| A | 2,500 | 1,900 creates · 30 create-then-complete · 300 title updates · 100 completes · 50 deletes · 50 updates-of-deleted (tombstone) · 40 stale-base scalar updates (LWW) · 20 lost-ack replays (same mutation id) · 10 invalid creates (poison isolation) |
| B | 1,245 | 800 creates · 200 description updates · 100 completes · 50 deletes · 25 lost-ack replays · 25 same-entity re-creates under new ids · 30 `timer_session` (unsupported entity — poison isolation) · 10 stale-base scalar updates · 5 creates with a missing project reference (poison) |
| C | 1,000 | 600 creates · 50 **same-field conflicts** against device A's tasks (stale base, diverged title) · 50 cross-field merges (stale base, scalar-only → LWW) · 300 self updates |
| D | 255 | 150 creates · 55 deletes · 25 delete-of-deleted (duplicate) · 25 updates-of-deleted (tombstone) |

Devices drain sequentially (A→B→C→D, as reconnecting clients would), so
cross-device conflicts are deterministic: C's stale edits meet A's
already-applied writes. The main workspace runs on an unlimited (PRO) plan
because §10.9 qualifies the *sync engine*, which is plan-independent — the
§18.1 plan cap is a separate, asserted property (below), not a hidden
exclusion. Simulated failures: device A's first four drain passes and all
five of device Q's attempts are dropped as connection-level 500s (825
failed mutation-attempts), exercising the real backoff and the
auto-quarantine threshold.

## Measured SLO results (local PG 18, qualification run)

| Metric | Result | SLO | Verdict |
|---|---|---|---|
| Connected mutations ack < 5 s (n=200) | **100%** (p99 13 ms, max 31 ms) | 99% | **Pass** (56× p99 margin) |
| Sync-operation data integrity (n=3,685 entities) | **100.0%** exact | 99.9% | **Pass** |
| Silent data loss | 0 lost, 0 duplicate entities, 0 unaccounted rows | none allowed | **Pass** |
| Per-entity ordering + version monotonicity | 0 violations (4,970 sync-change ops) | correct ordering | **Pass** |
| Tombstone/version protection | 155 deletes hold; 75 updates-of-deleted rejected **and preserved**; 25 delete-of-deleted deduplicated | no resurrection | **Pass** |
| Conflict preservation | 125/125 snapshots, payload byte-equal to client content | observable + testable | **Pass** |
| Tenant isolation | 0 violations (10 foreign updates → rejected NOT_FOUND, targets' versions unchanged; 5 foreign creates confined to foreign workspace; cross-workspace push → FORBIDDEN) | none | **Pass** |
| Quarantine/retry | 825 simulated failures → 995 retries; 5/5 auto-quarantined after 5 attempts; user requeue applied exactly once (duplicate-safe); 170 final quarantines all payload-intact | no loss, no hot retry | **Pass** |
| Pull-side convergence | each device pulled 4,815 changes + 155 deletions; reconstructed local cache == server live state (3,530 == 3,530); cursor monotonic | no stale resurrection | **Pass** |

Performance: full 5,000-mutation drain **56.0 s** (89.3 mutations/s;
per-device A 28.4 s / B 13.8 s / C 11.5 s / D 2.2 s), 200-mutation batch
ack latency p50 2,057 ms / p95 3,012 ms / max 3,035 ms, connected burst
93.6 mutations/s. (Service-level measurement; client-side pacing — the
1 s loop delay, 60 push/min rate limit and 429 backoff — adds bounded
delays but is designed behavior that loses nothing, per increments 1–2.)

## Integrity results (per property)

- **No duplicate entities:** 3,685/3,685 client entity ids map to exactly
  one row; replayed creates (ledger path and entity path) deduplicated to
  the original (95 duplicates observed, 0 extra rows).
- **No lost mutations:** every one of the 5,000 reached a terminal,
  recorded-or-quarantined outcome (applied 4,735 · duplicate 95 · conflict
  50 · rejected 120); rejected content is recoverable (125 snapshots with
  exact local payloads + client quarantine).
- **Correct ordering:** per-entity `sync_changes` sequences match the
  client's send order and versions increase by exactly 1 per write,
  including create-then-complete (v1→v2) and cross-device sequences.
- **Tombstone/version protection:** deletions hold under later updates and
  re-deletes; the delete wins, the edit is preserved (PRD §10.6).
- **Idempotency ledger:** 5,115 ledger rows reconcile exactly with
  observed outcomes (applied 4,940 · duplicate 50 · conflict 50 · rejected
  75; the 45 invalid/unsupported mutations are rejected before recording,
  replays of recorded ids keep their single original row).

## Defects found and fixes

**No implementation defects.** The drain exposed two *harness* mistakes,
each of which the server handled exactly as designed — evidence the hard
cases work, not bugs:

1. **Free-plan cap is real and enforced (PRD §18.1):** a fresh FREE
   workspace caps at 200 active tasks; the first un-capped run had 3,355
   over-limit creates rejected with `ENTITLEMENT_LIMIT_REACHED`. The cap
   counts *active* tasks and is a commercial gate, so the pure-sync
   qualification runs on an unlimited plan, and a **new permanent test**
   asserts the interaction: over-limit creates are rejected with a clear
   code, not ledgered, and once the cap lifts the preserved payloads apply
   exactly once (210/210 tasks, no duplicates, no loss).
2. **Changed replays are caught, not silently re-applied:** the first
   version of the generator re-stamped replays with fresh `createdAt`
   values; the server rejected all 45 as `IDEMPOTENCY_CONFLICT` (hash
   mismatch under the same mutation id) — correct, safest behavior. The
   harness now replays byte-identical records (as a real client does) and
   they dedupe to the original.

No production code was changed in this increment — the implementation
passed the qualification as built.

## Verification

- Unit + integration (real Postgres): **58 files / 576 tests** (574 +
  2 new SY-10 tests, ~60 s of the suite), including the full 5,000-mutation
  qualification and the plan-cap interaction test.
- E2E: **125/125** (3.3 min) — zero regressions.
- Lint 0 warnings · typecheck 5/5 packages · coverage **89.24%** statements
  overall (up from 88.56% — the harness exercised the sync/entitlement
  paths), core **97.91%** vs the 85% gate · production build green.
- CI: verified on the pushed commit (see commit log).

## Remaining M5 gaps

- **Windows Tauri client** (SQLite store, WebView2 shell, notifications,
  packaging/signing/update/rollback) — the only remaining M5 delivery line.
- **Offline breadth:** task editing/deletion through the task editor while
  offline, and offline focus timers (quick capture remains the only
  enqueueing surface).
- **Operational scale-up:** the qualification covers 5,000 mutations on a
  single node; multi-node/replica drain behavior and sustained-hourly
  throughput remain unmeasured (no infrastructure for them in this
  environment).
