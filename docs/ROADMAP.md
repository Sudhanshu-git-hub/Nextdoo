# NEXTDOO Roadmap

This roadmap is derived from the authoritative PRD ([docs/PRD.md](PRD.md)), the Phase 1 completion ledger ([PHASE1_COMPLETION_PLAN.md](PHASE1_COMPLETION_PLAN.md)), the M8 scope audit ([M8_ROADMAP_AUDIT.md](M8_ROADMAP_AUDIT.md)), and the milestone reports in this directory. It reflects the actual repository state as of the current commit.

**Status legend**

- **Shipped** — implemented in the repository and verified by the project's gates (lint, typecheck, database-backed tests, browser E2E where applicable)
- **Implemented, external verification outstanding** — code and tests are complete; real provider or deployment acceptance is not possible without external evidence
- **In progress** — work started, not complete
- **Planned** — accepted but not started
- **Deferred** — deliberately sequenced later or explicitly out of scope for the first release

No dates are assigned here. Dates require maintainer approval and are recorded in the milestone reports when work is authorized.

---

## 1. Current project status

The repository contains a working personal-workspace web application: authentication and accounts, tasks and projects, goals, trackers, knowledge databases, calendar (native + ICS), cross-module insights, settings and personalization, a durable worker pipeline, offline capture with sync, and a complete CI/quality gate chain. The personal core (PC1–PC7) is implemented and the shared-workspace increment is complete.

**The project is not release-complete.** Outstanding work includes live provider acceptance (Google, billing, SMTP, push, S3), production operations evidence (backups, monitoring, load), native clients, AI features, and community growth. See [docs/MAINTENANCE.md](MAINTENANCE.md) for the release policy.

## 2. Completed milestones

| Milestone | Status | Evidence |
|---|---|---|
| M1 Foundation (auth, migrations, HTTP conventions, gates) | Shipped | Milestone tests; CI |
| M2 Core task management (capture, projects, board, relations, bulk, virtualization, descriptions, instrumentation) | Shipped | `TASK_*` milestone docs; CI |
| M3 Planning and execution (calendar, capacity, focus, reminders, recurrence) | Shipped (bounded) | `CALENDAR_MILESTONE`, `M3_*` docs |
| M4 Tracking and analytics (events, scoring, corrections, reports) | Shipped (bounded) | `INSIGHTS_MILESTONE`, `M4_*` docs |
| M5 Cross-platform reliability (sync protocol, offline capture, conflict resolution, SLO harness) | Shipped (bounded; offline scope limited) | `M5_*` docs |
| M6 Commercial readiness (entitlements, exports, deletion, billing scaffolding) | Shipped (scaffolding; no live provider) | `M6_*` docs |
| M7 Google Calendar sync (provider track) | Implemented, external verification outstanding | `M7_GOOGLE_CALENDAR_SYNC_MILESTONE.md` |
| M8-i1…i8 hardening (push, suggestions, wellbeing, calendar hardening, webhook ingress, CI restore smoke, release-gate review) | Shipped (bounded) | `M8_i*` docs; CI |
| PC1 Goal Center | Shipped | `GOAL_CENTER_MILESTONE.md` |
| PC2 Configurable Tracker | Shipped | `TRACKER_MILESTONE.md` |
| PC3 Knowledge & Data | Shipped | `KNOWLEDGE_DATA_MILESTONE.md` |
| PC4 Shared personal workspace (palette, shared search, task relationships, Home) | Shipped | `SHARED_PERSONAL_WORKSPACE_MILESTONE.md` |
| PC5 Calendar Center (native events, ICS, providers gated) | Shipped (native/ICS); provider track gated | `CALENDAR_CENTER_MILESTONE.md` |
| PC6 Insights, Summary and Reports | Shipped (bounded periods) | `INSIGHTS_MILESTONE.md` |
| PC7 Settings, Account and Personalization | Shipped | `SETTINGS_CENTER_MILESTONE.md` |
| Task Center daily workflows (Home cards, Today/Tomorrow/Upcoming, Focus, quick capture) | Shipped (bounded offline scope) | `TASK_DAILY_WORKFLOWS_MILESTONE.md` |
| Security & release hardening (M8-i8) | Shipped (repository increment); deployment gates open | `SECURITY.md`, control matrix |
| Pre-launch correctness closure (Google withheld from first release) | Shipped (decision + gating) | `PRELAUNCH_CORRECTNESS_CLOSURE.md` |

## 3. Current development priorities

Priorities are the maintainer's accepted next work, ordered by dependency and risk. No priority is assigned a date.

1. **Release hardening gates for the first release** — complete the open release-readiness register items that are code-addressable: breached-password screening, session policy review, Google webhook channel credentials, and the bounded security assurance baseline (ASVS mapping for implemented surfaces). See [SECURITY.md](../SECURITY.md).
2. **Provider acceptance tracks** — live Google OAuth/sync/webhook acceptance, SMTP production delivery, browser push delivery, S3 storage adapter, and billing test-mode activation. These are externally blocked pending credentials and deployment.
3. **Offline scope completion** — extend the offline command protocol beyond quick capture (task editor, lifecycle, relationships, recurrence) with durable queues, replay identities, and conflict coverage.
4. **Production operations evidence** — encrypted backups/PITR, restore rehearsals, RTO/RPO, monitoring/alerting, load testing (k6), and a rollback drill. Documented as external/deployment dependencies.
5. **Issue triage and community readiness** — process incoming issues, review the new templates, and publish the project for public contribution.

## 4. Next planned milestones

### M8-i8 security assurance baseline (bounded)

- **Objective:** Convert the reviewed release-gate hardening plan into a deterministic, repository-local security assurance baseline.
- **Scope:** ASVS 4.0.3 Level 2 mapping for implemented surfaces; extend the existing deterministic secret/static scanner where justified; wire into CI before expensive build/E2E work.
- **Expected outcome:** A documented, tested security gate with explicit "implemented vs. external" boundaries.
- **Dependencies:** Maintainer authorization; no production credentials.
- **Test and validation requirements:** Scanner fixture tests; allowlist staleness checks; CI must fail on prohibited findings.
- **Actual status:** Review complete (`M8_i8_RELEASE_GATE_HARDENING_REVIEW.md`); implementation **not started** as of the current commit.

### Offline task command protocol (M5 continuation)

- **Objective:** Move task editing/lifecycle beyond quick capture into the offline queue with explicit replay identities.
- **Scope:** Editor draft persistence, queued mutations, version conflicts on reconnect, reconciliation UI expansion.
- **Expected outcome:** Offline-supported capture + edit + lifecycle with server-authoritative conflict resolution.
- **Dependencies:** Offline scope decisions from the PRD §10 contract; conflict UI already exists.
- **Test and validation requirements:** Two-device browser E2E (offline edit → online reconcile), lost-ack idempotent retry, tombstone propagation, tenant isolation.
- **Actual status:** **Planned.** Only quick capture and Today cache are offline-capable today.

### Native clients — Windows first (PRD platform sequence)

- **Objective:** Deliver the Windows client (Tauri/WebView2 per the PRD).
- **Scope:** Desktop packaging, offline-first local storage, secure updates, signing.
- **Expected outcome:** A downloadable Windows client with the same sync protocol.
- **Dependencies:** Offline scope completion; security review for desktop privilege controls.
- **Test and validation requirements:** Cross-device sync tests, update/rollback rehearsal, platform-specific security assessment.
- **Actual status:** **Planned.** No native client code exists.

### Public release preparation

- **Objective:** Publish the first public release once the release checklist in [docs/MAINTENANCE.md](MAINTENANCE.md) passes.
- **Scope:** Versioning, changelog, release notes, deployment configuration, demo availability.
- **Expected outcome:** A tagged release with verified deployment.
- **Dependencies:** All release gates in [SECURITY.md](../SECURITY.md) and [PRELAUNCH_CORRECTNESS_CLOSURE.md](PRELAUNCH_CORRECTNESS_CLOSURE.md).
- **Test and validation requirements:** Full CI on the release commit; hosted CI evidence; acceptance re-run.
- **Actual status:** **Not started.** No release date is committed.

## 5. Long-term direction

- **Android and iOS/macOS clients** following Windows, using the same sync protocol and offline queue design.
- **AI and voice** — deterministic parsing exists today; LLM-backed suggestions remain opt-in and budgeted per the PRD; voice capture is future.
- **Collaboration and teams** — the PRD positions teams as a secondary customer in later phases; role matrices and shared workspaces require a fresh security assessment.
- **Plugin platform and marketplace** — explicitly future; no runtime exists today.
- **Advanced analytics** — full historical reconstruction, wellbeing controls expansion, and routed alerting.
- **Integrations** — provider-agnostic storage adapters, notification channels, and calendar providers beyond the current gated Google track.

## 6. Deferred features

| Feature | Status | Reason |
|---|---|---|
| Passkeys (WebAuthn) and social login | Deferred | PRD Phase 2; requires fresh security assessment |
| Multiple workspaces / teams | Deferred | Single personal workspace is the current scope |
| Custom task fields / custom states | Deferred | PRD Phase 2 |
| Break intervals for Pomodoro | Deferred | Optional PRD item; never built |
| PDF report generation | Deferred | Browser printing is current; server-generated PDFs are future |
| Wearable/watch apps | Deferred | Requires supported ecosystem APIs and consent |
| Task EMAIL reminders | Not supported | Explicitly unsupported even when SMTP is configured |
| Google Calendar in first release | Withheld | Default-off gate; live acceptance outstanding |
| Offline task editing | Not supported today | Offline capture + Today cache only |
| Native desktop notifications | Not supported | Requires desktop client |
| S3-compatible production storage | Partially wired | Local disk is current; S3 adapter not production-qualified |

## 7. Known limitations

- **No public deployment or demo exists.** A local demonstration procedure is documented in [docs/SHOWCASE.md](SHOWCASE.md).
- **Offline scope is limited.** Only quick capture, Today cache read, and supported focus/time commands queue offline. Task editing, lifecycle, relationships, recurrence, and other modules require connectivity.
- **Provider integrations require external acceptance.** Google, Stripe/Razorpay, SMTP, browser push, and S3 have code or scaffolding; none has live production acceptance.
- **Security qualification is bounded.** The repository has deterministic secret/static scans and an ASVS-oriented control matrix; there is no independent penetration test, managed secrets evidence, or production TLS/backup proof. See [SECURITY.md](../SECURITY.md).
- **Operational evidence is absent.** Backups/PITR, RTO/RPO, monitoring/SLO windows, load tests, and rollback rehearsals are not established.
- **Native clients do not exist.** The web app is the only deliverable.
- **Coverage is strong but bounded.** Server-service coverage is reported including untouched files; it is not disguised as complete route coverage. Browser axe checks are scoped, not full WCAG certification.
- **Some tests are time-sensitive.** A disclosed date-dependent anchor defect was fixed in this increment; see [CHANGELOG.md](../CHANGELOG.md) and [docs/QUALITY_AND_TESTING.md](QUALITY_AND_TESTING.md).

## 8. Acceptance criteria for major milestones

### First public release

- All existing gates pass on the release commit: security scan (0 prohibited findings), `pnpm audit --audit-level high` (no high findings), migrations applied + replayed, lint zero warnings, typecheck all packages, coverage thresholds green, production build succeeds, real ClamAV/EICAR malware gate, restore smoke, repeated focus acceptance, and complete first-attempt browser acceptance.
- Release checklist in [docs/MAINTENANCE.md](MAINTENANCE.md) reviewed and signed off by the maintainer.
- Google remains `GOOGLE_CALENDAR_ENABLED=false` unless its separate acceptance track passes.
- No provider integration is claimed without provider acceptance evidence.

### Offline task command protocol

- Offline edits and lifecycle mutations durably queue with client mutation identities.
- Server dedupes lost-response retries to a single row.
- Conflict resolution UI handles offline-vs-online snapshots for edited tasks.
- Two-device E2E covers offline edit → reconnect → reconcile, tombstones, and tenant isolation.
- No silent data loss: rejected offline mutations are surfaced with their original input preserved.

### Windows client

- Client installs, starts, and signs in against a real deployment.
- Local SQLite/WebView2 storage syncs through the existing protocol; offline queue drains on reconnect.
- Update, rollback, and signing are rehearsed; desktop privilege controls are assessed.
- The web application remains the system of record; the client is a synced surface.

### AI/voice

- LLM features remain opt-in, budgeted, schema-validated, and log-minimal.
- Deterministic paths remain the default; AI output is never stored as authoritative without user confirmation.
- A separate privacy and security assessment precedes any model integration.
