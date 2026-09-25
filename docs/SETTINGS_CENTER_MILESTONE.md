# PC7 — Settings, Account and Personalization

## Audit before implementation

Verified clean `main` at `5197e9d6de266a8396063fe08df8c83bc1cdbeef`, fetched origin and verified zero divergence. No applicable AGENTS.md found. Reviewed PRD personal-core boundaries, §§6.1–6.2, 7.9, 8.8, 10, 11, 16 and 18; M6 session/deletion milestones; workspace settings; account, preference, sync, push, Calendar, billing and attachment code.

| Capability at baseline | Classification | Decision |
|---|---|---|
| Profile name, account timezone, identity, verification, sign out | IMPLEMENTED + UI COMPLETE | Reuse `/me`, verification and logout; organize under Account/Profile |
| Workspace name/timezone/week start/workday | IMPLEMENTED + UI COMPLETE | Reuse versioned workspace component under Productivity |
| MFA/recovery codes, sessions/revoke/all-session logout, audit | IMPLEMENTED + UI COMPLETE | Reuse security components; preserve reauthentication and confirmations |
| Export, deletion/grace cancellation/purge | IMPLEMENTED + UI COMPLETE | Reuse lifecycle and exports; no second retention or export engine |
| Light/dark system CSS | PARTIAL | Persist explicit light/dark/system choice and apply throughout the app |
| Contrast/reduced motion | PARTIAL | Existing browser state resets; persist through existing user-preference storage |
| Accent, density, sizing, sidebar, landing and view defaults | MISSING | Add validated preferences with real consumers, no arbitrary URLs or colors |
| Default task list | MISSING | Owned active-project default for capture; explicit parsed project wins |
| Push enable/disable; WEB/PUSH reminders | IMPLEMENTED + UI COMPLETE | Reuse browser controls centrally and in Notifications; persist reminder form defaults |
| Global email/category notification toggles | MISSING | Do not fabricate controls for an absent policy engine; email delivery remains purpose-specific |
| Wellbeing scores, overload, Insights streak/comparison | IMPLEMENTED + UI COMPLETE | Preserve exact existing semantics and defaults |
| Celebration/audio gates | FUTURE | Stored gates have no active feature; explain rather than offer ineffective controls |
| Offline queue/reconcile, quarantine/conflicts | IMPLEMENTED + UI MISSING | Read existing queue/status in Settings; keep one shell reconcile loop |
| Storage quota | IMPLEMENTED + UI MISSING | Read the same nondeleted attachment bytes and authoritative plan limits |
| ICS import, Tracker templates/reports | IMPLEMENTED + UI COMPLETE | Link to source-module controls; no generic import/backup restore fiction |
| Google connect/reconnect/disconnect/conflicts | IMPLEMENTED + UI COMPLETE | Reuse CalendarSettings; expose only implemented integration |
| Billing subscription/entitlements and provider checkout | IMPLEMENTED + UI MISSING | Show authoritative state and only configured provider handoffs |
| Provider/email configuration | EXTERNAL | Status only; never expose credentials; no fake checkout or messaging delivery |
| Help/onboarding/tutorial/changelog/support entry | PARTIAL | Add lightweight in-product guidance and verified repository links |
| Avatar upload, translated languages, native/AI/team/plugin features | FUTURE | No unsupported controls; English and locale-aware browser formatting remain explicit |

## Implementation boundary

Settings has focused section navigation plus an All settings view. Existing components remain the source of truth. Personalization extends `user_preferences` with namespaced validated keys, participates in existing export/purge, and does not change the existing six-key wellbeing API contract. No second authentication, billing, sync, notification delivery or security engine.

Validation, limitations and CI evidence are documented below and in the delivery report, which includes the exact changed files. PC8 is out of scope.

## Implemented behavior

- One focused Settings section at a time; All settings remains available for a comprehensive review. Existing workflow browser tests now open that supported view, retaining their assertions.
- Appearance applies throughout the authenticated shell and is initialized from the server. Preset accents retain readable light/dark colors; compact sidebar links keep accessible names. Contrast and motion controls use the same account preference persistence.
- Home and ordinary sign-in follow the saved start page. Quick capture and its existing offline payload use the default active project unless capture explicitly names another. Project Board/List, Calendar and Insights consume their defaults on opening; explicit report periods win.
- Notification defaults prefill new task reminder forms. Shared browser-push controls retain explicit permission prompts and compare this device endpoint with the existing account subscriptions. No new delivery engine or automatic reminder scheduling.
- Sync & Data reads the existing queue, pending attention and connectivity, links existing imports/conflicts, reuses exports/deletion and shows the same attachment-byte sum used by upload quota enforcement.
- Billing reads existing effective/recorded plan, period/grace/pending state and limits. Configured Stripe checkout uses the existing API; callback pages require provider-confirmed state. Provider secrets are never included in Settings responses.

## API and persistence

`GET/PATCH /api/v1/preferences/personalization` uses the existing authenticated actor, strict contract, mutation idempotency/rate limits and workspace transaction lock. Fourteen `personal.*` keys reuse the account's `user_preferences` rows. Partial updates preserve omitted values. Reads validate stored values and fall back per field; clearing the nullable default project removes its override. Foreign/inactive projects are rejected, and a later unavailable default falls back on read. These rows already participate in account export and cascade purge; no new migration/table/export engine.

`GET /api/v1/settings/status` composes entitlements, subscription state, attachment storage and boolean checkout availability. Both GET endpoints use private/no-store caching. Existing six-key wellbeing, authentication, deletion, sessions, sync, provider and billing contracts remain intact.

## Boundaries

**PARTIAL:** English-only UI, no avatar backend, project-only Board default, module-specific imports/report delivery, no cross-tab preference broadcast, metadata-only attachment export. Settings requires a connection. Help links the actual repository documentation, history and issues; repository access may be required.

**EXTERNAL:** Google authorization, VAPID/browser permission, email delivery, configured Stripe checkout and payment confirmation. Razorpay's existing backend is disclosed without an unsupported embedded UI. Billing management and backup restore remain provider/deployment operations.

**FUTURE:** Global notification category/mute policies, translations, avatar uploads, self-service restore, new integrations, AI, native applications, collaboration and marketplace. PC8 is not started.

## Validation evidence

New service/route tests cover defaults without writes, exact partial updates, invalid values, account isolation, foreign/inactive projects, clearing/fallback, corrupt stored values, unchanged wellbeing, authoritative status, authentication, cache policy and idempotent replay. Nine browser flows cover appearance/accessibility persistence, home redirect, Calendar/Insights defaults, project Board and quick capture, reminder defaults, wellbeing, sync/integration/billing/security navigation, failed saves and mobile accessibility in light/dark themes. Existing push regressions also pass.

Local validation: all 1,065 tests in 91 files pass, with 94.23% overall line coverage (90.17% statements, 82.83% branches, 93.94% functions); existing coverage thresholds pass unchanged. Lint and all seven package type checks pass. The nine new Settings browser flows and four existing browser-push flows pass together. Final production-build, broader browser regression and remote CI evidence are recorded in the delivery report.

The final production build also passes. The existing CI workflow is unchanged: dependency audit, migrations twice, lint/types, full coverage, production build, backup/restore smoke, real ClamAV/EICAR verification and the full browser suite remain required.

The broader browser run exposed pre-hydration input loss: a profile name and workspace draft could be edited before handlers attached, and a saved default could appear to change without sending a request. Settings now disables its form controls until hydration completes. Existing persistence/retry assertions remain unchanged; an additional browser check verifies server-rendered controls cannot accept unhandled input.

Final local browser evidence: all 67 existing/new interactive regression scenarios pass after the hydration fix, including profile persistence, workspace lost-acknowledgement/conflict handling, default task-list capture and mobile accessibility. The added server-rendered readiness scenario passes separately after its selector was corrected to inspect Next.js's hidden streamed markup. Total: 68 covered browser scenarios. The final production build passes with the readiness guard; full remote CI remains the publication gate.
