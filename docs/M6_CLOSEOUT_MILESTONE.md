# M6 — increment 8: final closeout (policy decisions + accessibility)

PRD scope: §6.1 (account deletion acceptance criteria), §8.8 (accessibility:
WCAG 2.2 AA, 4.5:1 text / 3:1 UI contrast), §11.1 risk table, §13.5
retention, §14.3 core endpoints.

M6-i8 closes M6. It makes no product-feature change: it (1) resolves and
documents the four M6 policy questions that M6-i7 left open, and (2) fixes
the one remaining WCAG AA contrast violation on the Account card that
M6-i7's E2E axe run surfaced.

## Policy decisions (final)

Each decision below quotes the PRD and states what the code does. Where the
PRD is silent, the existing verified behavior is adopted as the final
product rule and recorded here — nothing was invented, nothing was
silently changed.

### 1. Account-deletion grace period — **30 days is final**

- PRD §6.1: "Deleted accounts enter a **defined** retention period before
  permanent purge." No number is given anywhere in the PRD (§13.5's
  retention table lists deleted *tasks* at 30 days but has no row for
  deleted *accounts*).
- **Decision: the 30-day grace implemented in the MVP
  (`DELETION_GRACE_DAYS = 30`, boundary-inclusive `<=`) is the final
  product rule.** It is now verified at the exact boundary (13 web
  integration tests + 2 E2E tests assert `purgeAfter − requestedAt =
  30 d`).
- If product later wants a different number, it is a one-constant change
  (`packages/db` / data-rights) plus the boundary tests — deliberately
  not made now.

### 2. Verification/password-reset email suppression — **suppression begins when the grace window expires**

- The PRD says nothing about suppressing verification or password-reset
  emails while a deletion is pending. Its only relevant statements are the
  deletion acceptance criteria (§6.1) and the §13.5 retention table
  (audit/security/billing records are what must *survive*).
- **Decision (final): a pending deletion does not suppress
  verification/reset emails — the account is live during the grace window
  and can be restored, so its credential flows keep working. Suppression
  (uniform "unknown account": no token, no email, no enumeration) begins
  the moment the grace window expires and remains in effect after
  purge.**
- Verified at all three lifecycle points by the M6-i7 integration suite
  (issuable while pending · suppressed once expired · dead after purge).

### 3. Re-authentication for account deletion — **password re-authentication alone is final for the MVP**

- PRD §6.1: "Account deletion requires explicit confirmation and
  **re-authentication**." The risk table (§11.1) repeats "Re-
  authentication, retention window, audit, restore path." Neither
  specifies strength; §5.x/§12 make TOTP MFA **optional** per user, and
  the PRD never ties MFA challenges to specific privileged operations.
- **Decision (final): the deletion gate re-authenticates the password
  under the account lock (plus the typed `DELETE` confirmation) — no
  additional MFA challenge, for MFA-enabled accounts included.** This is
  the verified MVP contract and is preserved.
- An MFA step at deletion time (when the account has MFA enabled) is a
  sensible **future hardening candidate**, not an MVP requirement —
  recorded as such; implementing it now would change verified behavior
  without a PRD mandate.

### 4. Deletion-cancellation API — **`DELETE /v1/account/deletion` is the final public contract**

- PRD §14.3's endpoint sketch lists `POST /v1/account/deletion` (request)
  and `POST /v1/account/deletion/cancel` (cancel).
- **Decision (final): cancellation is `DELETE /v1/account/deletion` on
  the same resource — the existing, verified MVP contract is kept as the
  final public contract.** Rationale: the MVP shipped and was verified
  with this shape across five milestones (the sign-in restore path and
  the programmatic cancel share the same service); the PRD endpoint table
  is a behavior sketch, and REST semantics make `DELETE` on the
  resource-state endpoint the less surprising contract. No alias
  (`POST …/cancel`) is added — that would widen the surface beyond
  verified behavior for no product need.
- Both cancellation paths remain: `DELETE /v1/account/deletion` and
  signing back in during the grace window (auto-cancel + the
  `?deletion=cancelled` notice).

## Accessibility fix (PRD §8.8)

**Violation found (M6-i7 E2E, reproduced and scoped in M6-i8):** the
email-confirmation banner on the Settings Account card rendered its text
in the light-theme `--warn` token — `#9a6700` on `--bg-elev-2`
(`#f0f2f6`) = **4.34:1**, below the 4.5:1 minimum for 13.5px normal text
(axe `color-contrast`, serious — the only violation on the card,
light or dark theme).

**Why not a token change:** `--warn` is also the `.offline-badge`
background (with `#101216` text). No amber satisfies 4.5:1 both as text
on `#f0f2f6` (needs L ≤ 0.158) and as a background under `#101216` text
(needs L ≥ 0.201). The offline badge is outside the identified scope, and
changing its text color would be an unrelated UI change.

**Fix (`b833652`):** a theme-aware `--warn-text` design token — light
`#8a5a00` (**5.28:1** on `--bg-elev-2`, 5.93:1 on white), dark
`#f0b849` (unchanged; 8.5:1 on `#1f232c`) — used for `.banner-warn` text
only. The banner border keeps `--warn` (non-text UI, 3:1 satisfied). This
follows the existing `--accent` sub-AA fix pattern in the same token
block (PRD §8.8 comment). No other element changed.

**Out of scope, documented:** other `--warn` text usages (`.pill-medium`,
`.pill-scan-pending`, `.cal-over-mark`, audit-log notable actions) sit on
white/light backgrounds where `#9a6700` already passes 4.5:1 (4.84:1 on
white); the `.offline-badge` text (`#101216` on `#9a6700` ≈ 3.9:1) is a
pre-existing sub-AA case on an element outside the Account card — recorded
for a future a11y pass, not touched here.

**Regression pin:** the account-deletion E2E now runs axe (WCAG AA tags)
over the **whole Account card** in the exact state that exposed the
violation (unverified user → banner visible), in addition to the existing
deletion-block check. Verified locally in both light and dark themes:
0 violations.

## Validation (all executed)

- Full local suite: **741/741 passed** (70 files), exit 0.
- Lint (`--max-warnings=0`) and typecheck (web/worker/db): clean.
- Coverage thresholds met (core 97.91% lines; overall 89.4% statements /
  93.25% lines; collection scope unchanged).
- Production build (Next.js, all pages): success.
- Local real-browser E2E (Chromium against the production build): full
  suite green except the attachments spec, which refuses to run without
  the ClamAV engine (not installed in this sandbox; installed in CI).
- GitHub CI: full pipeline on tip — see the implementation-log entry for
  the run id.

(No migration, no API change, no retention-policy change in this
milestone.)
