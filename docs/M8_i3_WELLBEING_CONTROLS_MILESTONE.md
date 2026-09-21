# M8-i3 — Wellbeing preference controls (PRD §7.9) — implementation

**Status: IMPLEMENTED (this milestone).** Design authority:
`docs/M8_i3_WELLBEING_CONTROLS_REVIEW.md` (committed at `0cd370a`, CI-verified
at `5c8eede`), PRD §§7.9, 7.2, 7.8, 7.3, 14.3 (PD-03/PD-04, TR-07).

M8-i3 completes the user-reachable §7.9 settings surface: the six
independently-disableable wellbeing preferences are now persisted, returned,
audited and (for `disableScores`) visibly effective. Per the review doc, the
scope is deliberately bounded: **`disableScores` is the only new
user-visible control** in this milestone; the other four keys are **forward
gates** — stored, returned and audited, with zero visible behavior change —
because the MVP ships none of the features they would gate.

## What was built

| File | Kind | Purpose |
| --- | --- | --- |
| `packages/contracts/src/preferences.ts` | extended | Six-key contract: `WELLBEING_PREFERENCE_KEYS`, `WellbeingPreferences`, `WELLBEING_PREFERENCE_DEFAULTS`, strict non-empty `wellbeingPreferencesPatchSchema` |
| `apps/web/src/server/services/preferences.ts` | extended | `getWellbeingPreferences` seeds PRD-derived defaults for absent keys; `setWellbeingPreferences` unchanged (per-key upsert, `account.preferences_updated` audit naming exactly the changed `preferences.*` fields) |
| `apps/web/src/app/api/v1/preferences/route.ts` | unchanged | `GET`/`PATCH /v1/preferences` — auth, origin check, rate limit, idempotent PATCH, strict body all already in place from M8-i2 |
| `apps/web/src/components/views/SettingsView.tsx` | touched | Wellbeing card: new "Hide numeric scores" checkbox (`disableScores`) above the existing overload-warning toggle |
| `apps/web/src/app/api/v1/tracking/summary/route.ts` | **defect fix** | Strip top-level `averageScore` when scores are disabled (see §5) |
| `vitest.config.mts` | touched (test-enabling) | Added the `@` → `apps/web/src` alias so vitest can import real `/v1` route handlers for HTTP-level tests; no behavioral effect on any existing suite |
| `apps/web/src/server/services/preferences.integration.test.ts` | rewritten | 7 service tests (see §7) |
| `apps/web/src/server/services/preferences-route.integration.test.ts` | new | 5 route tests: 401, exact default vector, 400 malformed (unknown key / empty / non-boolean), idempotent replay (one row, one audit), and the `disableScores` strip/restore round trip through the real tracking-summary route |
| `apps/web/e2e/wellbeing.spec.ts` | new | 5 browser tests (see §7) |

No new tables, migrations, workers, endpoints, or external services. The
`user_preferences` pattern established in M8-i2 is reused unchanged.

## 1. The six-key contract

`GET /api/v1/preferences` returns all six keys (computed = stored rows
overlaid on defaults; a fresh user has zero rows):

| Key | Meaning | Default | Default source |
| --- | --- | --- | --- |
| `disableScores` | hide numeric score figures (TR-07) | `false` | **PRD** — TR-07/PD-03 make score hiding an opt-out; scores are shown by default |
| `disableStreaks` | hide streak displays | `false` | **PRD** — §7.9 "streaks on" |
| `disableCelebrations` | hide celebration moments | `true` | **PRD** — §7.9 "celebrations off" |
| `disableSounds` | mute sounds | `false` | **Implementation decision** — PRD states no default; "independently disable" framing (sounds are a feature the MVP would add later, shown/enabled by default when present) |
| `disableComparativeMetrics` | hide comparative metrics | `true` | **PRD** — §7.9 + PD-04: comparisons are absent from the MVP; the gate defaults closed |
| `disableOverloadWarnings` | hide the Today overload banner + S2 suggestions | `false` | **Implementation decision** — PRD silent on the default; M8-i2 established warnings shown by default (the key itself is PRD-anchored) |

`PATCH /api/v1/preferences` accepts a strict, non-empty, booleans-only
partial body of those six keys: unknown keys, missing/extra fields,
non-booleans and empty bodies are rejected with `400 VALIDATION_FAILED`.
Only provided keys are written (per-key upsert, including toggling back to
the default value). Every write produces exactly one
`account.preferences_updated` audit record whose `metadata.fields` names
exactly the changed `preferences.*` keys. All reads/writes are scoped to the
authenticated user; no cross-user read or write is possible (the endpoint
has no workspace or foreign-user parameters).

## 2. `disableScores` — the only new user-visible control (TR-07)

- **Settings**: "Hide numeric scores" checkbox in the Wellbeing card.
- **On (disabled scores)**: every covered surface strips score figures from
  the response/UI — task tracking detail returns the 403-free empty shape
  (`{scoresEnabled:false, result:null, events:[], history:[]}`), the tracking
  summary omits the per-day `score` and the top-level `averageScore`, and the
  Analytics page shows "Numeric scores are hidden by your stored preference."
  instead of the Execution score stat and the per-day Score column.
- **Off (re-enabled)**: scores return **from the same stored results** — no
  recalculation, no correction, no re-evaluation.
- **Never touched**: `tracking_results` rows (score, outcome, components,
  input hash), score calculation logic, corrections, recalculation, and data
  export. Verified row-for-row across the toggle in both the service and
  route tests, and in the E2E round trip.
- The toggle is reflected immediately (next read) with no worker or cache.

## 3. The four forward gates (inert by construction)

`disableStreaks`, `disableCelebrations`, `disableSounds` and
`disableComparativeMetrics` are **persisted, returned by the API, and
audited** — and nothing else. The MVP contains no streak display, no
celebration surface, no audio system, and no comparative/leaderboard surface,
so there is nothing for them to change; they exist so a future feature reads
the stored preference on day one. Verified in the E2E: flipping all four (and
flipping them back) leaves the tracking-summary figures — days, insights,
`averageScore`, `plannedMinutes` — byte-identical, and the Analytics page
renders the same content.

**No features were invented** to satisfy the gates: no streak counter, no
confetti, no sound player, no leaderboard, no team comparison.

## 4. `disableComparativeMetrics` never hides personal trends

The gate is a guard for future **cross-user/team** comparison surfaces only.
The user's own §7.8 trend reporting (day/week summaries, per-day trends,
insights, own-task stats) is computed from the user's own data and is
**unaffected by the key at either value** — verified by the service test
(identical `days`/`insights`/`averageScore` for `false` and `true`) and the
E2E (own-trend figures identical before/after toggling the gate to `false`).
The MVP prohibition on cross-user comparison (PD-04) is unchanged: no
comparison data is produced or exposed anywhere.

## 5. Defect found and fixed while verifying: summary `averageScore` leak

The M8-i3 route test caught a genuine, reproducible TR-07 serialization
defect in the M8-i2 code: `GET /api/v1/tracking/summary` spread the full
`getSummary` result (which always includes `averageScore`) and its
"strip when disabled" conditional spread was therefore a no-op — **the
average score number was shipped in the JSON even with scores hidden**. The
route's own comment states the strip intent, the sibling locked
project-analytics route strips via destructuring
(`const { averageScore, ...summary } = await getSummary(...)`), and its
locked test codifies the stripped shape
(`expect(summary).not.toHaveProperty('averageScore')`). The fix mirrors that
locked pattern exactly (one-line destructuring in
`apps/web/src/app/api/v1/tracking/summary/route.ts`); no score logic,
response semantics (enabled case), or other route changed. This is the only
product-code change touching a closed milestone, and it is disclosed here
and in the final report per the standing defect-disclosure rule.

## 6. Explicitly out of scope (unchanged)

- `/v1/me` response shape — untouched; the locked sessions/profile tests
  pass unchanged in the full run.
- Overload-warning behavior — exactly M8-i2 (Today banner + S2 suggestions);
  no duplication or redesign.
- Score calculation / corrections / recalculation / export — untouched.
- Streak, celebration, sound, comparative-metric, or leaderboard features —
  not built.

## 7. Test evidence

**Service** (`preferences.integration.test.ts`, 7 tests): exact PRD-derived
default vector; partial patch + audit naming exactly the changed fields
(including back-to-default upsert); empty-patch no-op; owner scoping across
accounts; zero planning-data mutation (task/event/result/reminder/sync
counts); `disableScores` TR-07 round trip (detail empty shape, summary
window data survives, stored rows row-for-row identical, re-enable restores
the stored score 90); `disableComparativeMetrics` inert to own trends at
both values.

**Route** (`preferences-route.integration.test.ts`, 5 tests, real route
handlers via a mocked auth boundary): 401 unauthenticated (GET and PATCH);
exact default vector for a fresh user + 400 on unknown key / empty body /
non-boolean values with no rows written; idempotent replay (same
`Idempotency-Key` + body → `200` + `Idempotent-Replay: true`, exactly one
preference row, exactly one audit record); `disableScores` strip/restore
through the real summary route (top-level `averageScore` and per-day `score`
absent when hidden, own trend data present throughout, stored rows
unchanged); second-account isolation at the route.

**E2E** (`wellbeing.spec.ts`, 5 browser tests): fresh-user default vector +
malformed-patch 400s over real HTTP; Settings → Analytics score round trip
(toggle hides the Execution score stat and Score column with the TR-07 note,
untoggle restores); forward gates persist + audit while leaving summary
figures and Analytics content identical (comparative key keeps own trends);
cross-account isolation via separate request contexts; Wellbeing card axe
(wcag2a/wcag2aa/wcag21aa/wcag22aa) + keyboard operability (Tab + Space).

**Locked regression surfaces preserved and green in the full run**: `/v1/me`
sessions/profile suites, TR-07 detail tests (`tracking-workflow`), export
suites, project-analytics score-strip test, the entire 79-file suite.

## 8. Validation

- Targeted: `preferences.integration.test.ts` + `preferences-route.integration.test.ts` — 12/12 pass.
- Full unit+integration: `pnpm test:coverage` — **79 files, all pass**, coverage thresholds met.
- Typecheck (`pnpm typecheck`) and lint (`pnpm lint`, 0 warnings) — clean.
- Production build (`pnpm build`) — clean.
- E2E (`playwright test --retries=2`): **162 passed**; the only failures are the
  five ClamAV-dependent `attachments.spec.ts` tests, which refuse to run
  without the `clamscan` binary (sandbox has no package-manager egress; CI
  installs ClamAV and runs the suite for real — established environment
  limitation, unchanged by this milestone).
- GitHub CI: see below (verified on the pushed commit).

## 9. Next recommended milestone

M8-i4: **Google Calendar two-way sync reliability hardening** (or, if the
team prefers closing the remaining §7.9 wording gap first, a review of the
§7.9 "sounds" surface). Details and rationale were recorded in the M8-i2
close-out; the M8 audit (`docs/M8_ROADMAP_AUDIT.md`) remains the ordering
authority. No M8-i4 work was started in this milestone.
