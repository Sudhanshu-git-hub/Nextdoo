# M8-i5 — Google Calendar live-unblock path — PREFLIGHT (planning/review only)

**Status: PREFLIGHT COMPLETE — M8-i5 BLOCKED at preflight (measured
2026-09-19, fourth probe of this environment). No live Google flow was
attempted, no live result was manufactured, and no product code was
changed.**

Per the M8-i5 directive this increment is the Google Calendar
**live-unblock path**: (a) the bounded 16-point live verification
carried over from M7-i3 (`docs/M7_GOOGLE_CALENDAR_SYNC_MILESTONE.md`
§7.3) and the M8 audit (X1), and (b) — only if the live pass or
PRD/security requirements justify it — **T3**, the dedicated random
push-channel verification token (audit L4 deferral). M8-i4 is fully
CLOSED and CI-verified at `90e6992`; its offline hardening (T1 token
re-seal, T5 invalid-sync-token recovery, T4 rate-limit backoff, T6a
logging) is already in place and changes what the live pass would
observe, not what it must verify.

## 1. Preflight results (measured 2026-09-19)

| # | Prerequisite | Requirement source | Result |
| --- | --- | --- | --- |
| 1 | Local/remote branch state | M8-i5 directive | local HEAD = remote HEAD = `90e6992`, tree clean (after recovering a 7th sandbox partial reset via the established refspec-fetch + `reset --mixed FETCH_HEAD` procedure; tree byte-verified against the tip) |
| 2 | GitHub authentication | M8-i5 directive | **OK** — `gh` authenticated (GH_TOKEN) |
| 3 | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | code: `apps/web/src/server/env.ts`, `calendar-connections.ts` `googleConfig()` | **ABSENT** — no env vars set; no `.env`/`.env.local` exists; `.env.example` carries empty template values only |
| 4 | `APP_URL` / public HTTPS redirect URI | code: redirect URI = `${APP_URL}/api/v1/calendar/connections/google/callback` | **ABSENT** — `APP_URL` not set (template default `http://localhost:3000` is not public HTTPS); this sandbox exposes no long-lived public HTTPS host |
| 5 | Outbound to `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com` | M7 §7.3 egress requirement | **BLOCKED** — fresh probe: all three → `000` (connection failure). Only `github.com`, `codeload.github.com`, `registry.npmjs.org` remain reachable. Identical to the M7 (2026-09-14) and M8-i4 (2026-09-19) probes |
| 6 | Inbound public reachability for `POST /api/v1/calendar/webhook` | PRD §16.1 push channel; audit L4 | **NOT AVAILABLE** — no public ingress for server-to-server POSTs; the sandbox preview proxy is browser-facing and ephemeral (M7 §7.3 recorded the same). Cannot be verified without a long-lived public HTTPS host |

**4 of 6 prerequisites unavailable (3, 4, 5, 6).** Per the directive:
STOP at preflight. Nothing live is simulated or faked; no
speculative provider-specific behavior is implemented.

## 2. The 16-point live verification (recorded for the unblock)

Defined in the M7-i3 directive / M8 audit X1; re-stated here as the
exact checklist M8-i5 will execute once unblocked (each point records
**observed** provider behavior, distinguished from the existing
fixture-based tests):

1. **OAuth authorization** — real consent flow from
   `POST /api/v1/calendar/connections/google/authorize` (mode chosen
   before auth, PKCE S256, single-use state) through the browser to the
   callback.
2. **Token exchange** — `completeAuthorization` against
   `oauth2.googleapis.com/token`; `externalAccountId` + tokens stored
   sealed (verify via the DB row, never via logs).
3. **Scope/mode correctness** — READ_ONLY connection carries only
   `calendar.readonly`; READ_WRITE carries `calendar`; an existing
   connection cannot silently change mode without re-consent.
4. **Token refresh** — force-expired access token refreshes on demand
   during a real pass (M8-i4 T1: the refreshed set is re-sealed;
   observe `tokenUpdates` and the new `token_expires_at`).
5. **Token rotation** — Google re-issues the refresh token on refresh
   for the test account (if it does): the rotated value replaces the
   stored one (M8-i4 T1); if Google does not rotate for this account,
   record that observation.
6. **Recurring-series import** — a real Google recurring series
   (e.g. daily standup) imports as per-occurrence instances with
   distinct instance keys (M7-i2 G1) inside the 24 h sync window.
7. **Per-occurrence identity** — rescheduling one occurrence in Google
   moves exactly that occurrence (same original slot → same key);
   siblings untouched.
8. **Occurrence update/cancel** — cancel one occurrence in Google: the
   task unschedules + notifies (AC-3) and the mirror row is removed;
   the sibling occurrence survives.
9. **Series cancellation** — cancel the whole series in Google: one
   series-level deletion is reported; every instance's mirror is
   removed, other series untouched.
10. **Deleted-event mirror cleanup** — a non-mapped and a mapped
    externally deleted event: stale availability blocks removed
    idempotently (M7-i2 G2).
11. **Two-way task export** — a due-time task becomes a timed event on
    the NEXTDOO calendar; re-runs never duplicate; task deletion
    removes the event; external move of the exported event applies back
    through the task invariants.
12. **Push-channel delivery** — `ensureChannel` creates a real
    `web_hook` channel; a Google notification actually POSTs
    `POST /api/v1/calendar/webhook` with the connection token; the
    triggered import lands the change; 7-day renewal before lapse.
13. **Polling fallback** — with the channel unhealthy/absent, the
    10-minute incremental polling imports the same changes; the M8-i4
    T5 recovery is exercised if (and only if) Google invalidates the
    stored sync token — otherwise record the token's live behavior.
14. **Rate-limit/backoff behavior** — on a real 429/403 quota
    response (including the real `Retry-After` form Google sends), the
    M8-i4 T4 window is stored, cycles inside the window make zero
    provider calls, and the cycle logs `calendar.sync.rate_limited`
    (T6a).
15. **Reconnect/auth-failure handling** — revoke/expire the credential:
    the connection pauses with the reconnect prompt (AC-5), no silent
    failure; reconnect re-exchanges and resumes.
16. **Disconnect/revoke + tenant isolation** — `disconnectConnection`
    revokes best-effort and wipes tokens; 30-day retention holds; a
    second user's connection/conflicts/mirrors are never touched by
    any of the above.

## 3. T3 evaluation (deferred to the live pass)

T3 = dedicated random push-channel verification token column (audit
L4: today the channel token is the connection id — a UUID Google
echoes back; it scopes the import to that connection, so there is no
cross-tenant effect, but it is not independently revocable/rotatable
per channel).

Decision rule (per the M8-i5 directive): **T3 is implemented only if
the live pass or a PRD/security requirement justifies it.** The
evaluation will cover: storage/rotation/revocation semantics, webhook
validation/replay resistance (PRD §11.1 dedupe context), and
tenant/connection binding. With the live pass blocked, no live
evidence exists to justify the change, so **T3 remains deferred** —
exactly as the M8-i4 review closed it.

## 4. Exact unblock requirements (one line per gap)

1. **Credentials**: provision a Google Cloud **Web application** OAuth
   client (id + secret) with
   `<public-host>/api/v1/calendar/connections/google/callback`
   allow-listed and a consent screen (external, or restricted to the
   test account); a test Google account with Calendar.
2. **Configuration**: set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   and `APP_URL=<public-host>` (public HTTPS) for the deployment under
   test.
3. **Egress**: allow outbound HTTPS from the test environment to
   `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`.
4. **Ingress**: make `<public-host>` long-lived and inbound-reachable
   by Google for `POST /api/v1/calendar/webhook` (push-channel
   delivery, point 12).

Steps 1–3 alone would make points 1–11, 13–16 executable (polling is
the sync path in this environment); step 4 is required only for point
12. The feature already gates on presence and degrades to
503 `PROVIDER_UNAVAILABLE` until configured — no code change is
required to be unblocked.

## 5. Non-goals (per directive)

No RRULE/series editing; no Outlook/CalDAV; no multi-calendar
selection; no new Calendar UI; no optional hardening not required by
PRD/security evidence; no simulated Google behavior; no reopening of
closed milestone behavior (M7, M8-i1…i4).

## 6. Status and stop point

**M8-i5: BLOCKED at preflight** (externally: no credentials, no
public HTTPS host, no egress to Google, no verifiable inbound webhook
host). Next increment starts with the same six-check preflight; if any
gap from §4 is closed, the 16-point pass (§2) runs first, then the T3
decision (§3). Per directive, STOP after this preflight — no
implementation.
