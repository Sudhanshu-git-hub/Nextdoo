# NEXTDOO — Repository Audit, World-Class Roadmap & Open-Source Strategy

**Date:** 2026-11-03
**Repo:** `Sudhanshu-git-hub/Nextdoo` (branch `ui-ux-overhaul` for UI work; `main` at `4583981`)
**Method:** Read-only audit of the repository + public competitor research (Todoist, TickTick, Sunsama).

---

## Part 1 — Repository Audit

### What is genuinely perfect (world-class, rare for a young OSS project)

1. **Architecture is not a toy.** pnpm/Turborepo monorepo, 5 shared packages (`contracts`, `core`, `db`, `calendar`, `billing`), 111 API routes, 19 views, 46 E2E specs, ~58k LOC. The domain logic lives in pure-TypeScript packages (`core/`) that are unit-tested independently of the web app. This is the single hardest part to build correctly, and it's solid.

2. **Security posture is serious.** Argon2id passwords, TOTP MFA + recovery codes, hashed session/reset tokens, owner-scoped isolation on every query, transactional outbox, idempotent request identities, CSP nonces, credential redaction in logs, ClamAV malware scanning on uploads, generic error responses. The `security-allowlist.json` + deterministic scanner in CI is a practice most projects skip entirely.

3. **Test discipline is exceptional.** 1,134 passing tests, 94.46% line coverage, `pnpm audit` → 0 advisories (was 35 incl. 1 critical), lint+typecheck+build+E2E all green. E2E uses real Chromium + axe-core accessibility checks. The `db-restore-smoke` (pg_dump → restore → re-migrate) proves backups actually work — almost no OSS app tests this.

4. **The domain model is deeper than competitors.** Goals→milestones→tasks cascade with real progress math; personal trackers with typed fields, condition rules, 11 templates, and honest non-fabricated history; knowledge databases with real relations and backlinks; capacity planning against a configured workday; execution scoring with immutable corrections. Todoist has none of this. TickTick has habits, not goal cascades + knowledge relations.

5. **Offline-first foundations exist.** IndexedDB queues, client mutation IDs, cursor-based sync (`/sync/push`, `/sync/pull`), conflict resolution UI with per-field snapshots, optimistic UI with rollback. Most web apps claim "offline" and just cache the last fetch.

6. **Open-source hygiene is complete.** MIT license, CONTRIBUTING, CODE_OF_CONDUCT (Contributor Covenant), MAINTAINERS, CHANGELOG (Keep a Changelog), SECURITY.md, issue/PR templates, roadmap with honest status labels, no fabricated stars/tests/releases.

7. **The new UI/UX overhaul (branch `ui-ux-overhaul`)** upgraded the entire design system: layered surfaces, refined accent, grouped sidebar with brand mark, friendly empty states, premium command launcher, hover-lift cards, focus gradient. All 1,134 tests still pass.

### What needs improvement (honest gaps)

1. **No mobile/desktop clients yet.** Web only. Todoist/TickTick/Sunsama are cross-platform native. This is the #1 adoption blocker — people plan on their phones.

2. **Calendar provider sync is gated, not shipped.** Google OAuth/sync/webhook exists behind `GOOGLE_CALENDAR_ENABLED` (default false) and has no live provider acceptance. Outlook doesn't exist. Calendar is currently native+ICS only.

3. **Billing is scaffolding, not revenue.** Plan model + Stripe/Razorpay webhook verification exist; no live provider, no checkout. Fine for OSS, but blocks monetization.

4. **Offline scope is narrow.** Only quick-capture + Today cache work offline. Task edit/lifecycle, recurrence, relationships, timers require connectivity. This is the biggest "feels-broken" risk.

5. **No AI layer.** Natural-language parsing is deterministic (good, reliable) but there's no LLM assist (task breakdown, smart suggestions, email-to-task). Todoist's AI and TickTick's AI Mode are now table stakes.

6. **No collaboration.** Single-user by design. Todoist/Sunsama have shared projects/assignments. Deferred is a valid choice, but it caps the market.

7. **No habit/streak surface distinct from trackers.** Trackers are powerful but oriented to "observe", not the daily "do this routine" streak psychology of TickTick habits.

8. **No time-blocking / daily-planning ritual.** Sunsama's guided morning planning + shutdown ritual is behaviorally transformative and is the reason it charges $25/mo. NEXTDOO has capacity warnings but no guided ritual.

9. **Notifications are in-app only.** Reminders deliver as durable in-app rows; email/push exist but need SMTP/VAPID config; no OS-level notifications.

10. **No integrations ecosystem.** Todoist has 150+; TickTick has calendar subscriptions; Sunsama pulls from Asana/Jira/Todoist/Notion/Gmail/Slack. NEXTDOO is a fortress — great data, no inbound/outbound connectors.

11. **Mobile UI is untested.** The sidebar collapses to a `<select>` on mobile — functional but not a designed mobile experience. No responsive audit beyond that.

12. **No public demo / hosted instance.** README says "no public deployment claimed." For an OSS project, a hosted demo is the highest-leverage growth move.

### Verdict

> NEXTDOO is architecturally **more capable** than Todoist/TickTick/Sunsama in its domain model (goals, knowledge, honest analytics). Its weakness is **surface area and polish**: no mobile, no live providers, no AI, no integrations, narrow offline. The gap is not "build the core" — the core is built. The gap is "ship the experiences people touch daily, on every device, with the providers they already use."

---

## Part 2 — Competitor Benchmark

| Capability | NEXTDOO today | Todoist | TickTick | Sunsama |
|---|---|---|---|---|
| Fast capture + NL parsing | ✅ (deterministic, offline-capable) | ✅ best-in-class | ✅ good | ✅ |
| Recurring tasks | ✅ (bounded generation) | ✅ | ✅ | ✅ |
| Projects / sections / board | ✅ DnD board + sections | ✅ | ✅ | ✅ |
| Subtasks / dependencies | ✅ (cycle prevention) | ✅ subtasks | ✅ | ✅ |
| Priority | ✅ 3 levels | ✅ 4 levels | ✅ 5 levels | ✅ |
| Calendar view | ✅ Day/Week/Month/Year/Agenda | ⚠️ paid | ✅ full | ✅ best |
| Time blocking | ⚠️ capacity warnings only | ❌ | ⚠️ | ✅ core |
| Habits / streaks | ⚠️ trackers (observe, not streak) | ❌ | ✅ | ⚠️ |
| Pomodoro / timers | ✅ stopwatch + Pomodoro + manual | ❌ | ✅ | ✅ |
| Goals → tasks | ✅ cascade + real progress | ⚠️ basic | ❌ | ✅ objectives |
| Knowledge / notes | ✅ typed DBs + backlinks | ❌ | ❌ | ❌ |
| Insights / analytics | ✅ explainable scoring | ⚠️ Karma | ⚠️ stats | ⚠️ weekly only |
| Offline | ⚠️ capture-only | ✅ | ✅ | ✅ |
| Cross-platform native | ❌ web only | ✅ all | ✅ all | ✅ all |
| Provider sync (Google/Outlook) | ⚠️ Google gated, no Outlook | ✅ | ✅ | ✅ |
| Integrations | ❌ | ✅ 150+ | ⚠️ | ✅ 15+ |
| AI assist | ❌ | ✅ | ✅ | ❌ |
| Collaboration | ❌ deferred | ✅ | ⚠️ | ⚠️ |
| Daily planning ritual | ❌ | ❌ | ❌ | ✅ (differentiator) |
| Shutdown ritual / weekly review | ❌ | ❌ | ❌ | ✅ |
| Eisenhower matrix | ❌ | ❌ | ✅ | ❌ |
| Pricing | Free (OSS) | Free–$60/yr | Free–$50/yr | $25/mo |

**The strategic read:** NEXTDOO already beats all three on *depth* (goals, knowledge, honest analytics, offline foundations). It loses on *reach* (devices, providers, integrations, AI, ritual). To "surpass" them, NEXTDOO doesn't need to copy their feature list — it needs to **ship the reach layer on top of its deeper core**, and add the one behavioral differentiator none of them has: honest execution analytics wired into a daily ritual.

---

## Part 3 — Roadmap to "World's Best To-Do App"

Ordered by leverage (impact per unit of work), not by tradition. Each phase is independently shippable.

### Phase 0 — Ship a public demo & close the release gates (1–2 weeks)
**Why first:** a hosted demo + green release gates is the single highest-leverage growth move. Nothing else matters if people can't try it.
- Deploy to Vercel/Railway/Fly.io with Postgres (Supabase/Neon). Enable Google Calendar behind the existing flag. Configure SMTP + VAPID + S3.
- Complete `M8-i8` ASVS security assurance baseline.
- Write a "hosted demo" section in README with a real URL.
- **Open-source leverage:** Vercel/Fly templates, Dockerfile + docker-compose (there are ready-made Next.js+Postgres+pgBouncer images).

### Phase 1 — Mobile & desktop reach (the #1 adoption blocker)
**Why:** Todoist/TickTick/Sunsama grew because they're on phones. Web-only caps NEXTDOO at "developer tool."
- **PWA first (week 1):** service worker, offline shell, install-to-home, push. Cheapest mobile win.
- **Capacitor mobile (weeks 2–6):** wrap the web app into iOS/Android with native shells, biometric auth, local notifications, camera attachment. Capacitor is Apache-2.0 and lets you reuse the web codebase 100%.
- **Tauri desktop (weeks 3–8):** Windows/macOS/Linux client using the existing sync protocol. Tauri is MIT/Apache-2.0, far lighter than Electron.
- **Open-source leverage:** Capacitor (Apache-2.0), Tauri (MIT/Apache-2.0), `@capacitor/local-notifications`, `@capacitor-community/biometric-auth`, `vite-plugin-pwa`.

### Phase 2 — The daily ritual (NEXTDOO's differentiator)
**Why:** Sunsama charges $25/mo for a *ritual*, not a feature. NEXTDOO can offer a ritual + honest analytics — something none of the three competitors combine.
- **Guided morning planning:** walk through "what's on your calendar → pull tasks → estimate → commit to a plan" with capacity warnings (reuse the existing capacity math).
- **Shutdown ritual:** end-of-day reflection, "what got done," auto-link to Insights.
- **Weekly review:** plan-vs-actual, objectives, post-to-Slack/Teams (later).
- **Eisenhower matrix view** (quick win — TickTick has it, cheap to build on existing task data).
- **Open-source leverage:** reuse existing `capacity.ts`, `scoring.ts`, `insights.ts`. No new deps needed — this is behavior, not infrastructure.

### Phase 3 — Live providers & integrations (the reach layer)
**Why:** people won't switch from Todoist/Google Calendar if their data can't come with them.
- **Google Calendar acceptance:** enable `GOOGLE_CALENDAR_ENABLED`, complete live OAuth/sync/webhook acceptance. (Code exists; needs credentials + a test account.)
- **Outlook calendar:** OAuth + delta sync.
- **Inbound connectors:** email-to-task (Gmail/IMAP), browser extension (save page as task), Todoist CSV/JSON import, TickTick export import, ICS subscription.
- **Outbound:** export to Google Calendar, share a read-only board view (light collaboration).
- **Open-source leverage:** `googleapis` (Google Calendar API), `microsoft-graph-api`, `imapflow`/`nodemailer` (already a dep), `ical.js` (already a dep), browser extension template (CRXjs/WXT).

### Phase 4 — AI assist (table stakes by 2026)
**Why:** Todoist/TickTick both shipped AI; users now expect it.
- **LLM task breakdown:** "Plan Q3 report" → subtasks with estimates.
- **Smart suggestions:** surface the right next task based on context (due, capacity, habit streaks).
- **Natural-language filters:** "show me high-priority overdue things for tomorrow."
- **Email/voice capture:** email-to-task with LLM extraction; voice-to-task (Web Speech API on mobile).
- **Keep the deterministic parser as the fallback** — never let AI fabricate dates (this is NEXTDOO's honesty promise).
- **Open-source leverage:** Vercel AI SDK (Apache-2.0) for provider-agnostic LLM calls; `@anthropic-ai/sdk`, `openai` SDK; Web Speech API (browser-native, no dep).

### Phase 5 — Habit & streak surface
**Why:** TickTick's habit tracker is a core reason users stay. NEXTDOO's trackers are powerful but not streak-oriented.
- Build a "habits" view on top of trackers: daily/weekly routines, streaks, completion rates, reminders, motivational calendar heatmap.
- **Open-source leverage:** reuse `personal-tracker.ts`; `react-calendar-heatmap` (MIT) for the streak calendar.

### Phase 6 — Collaboration (optional, gated)
**Why:** deferred is fine, but it caps the market. Do it last.
- Shared projects, task assignment, comments, activity logs.
- **Open-source leverage:** CRDT sync (`yjs`, MIT) if real-time collab; or keep the existing cursor sync and add invite/accept flows.

### Phase 7 — Growth & community
- Hosted demo link in README.
- Publish to product directories, submit to Open Source Weekly, Awesome lists.
- Browser extension in the Chrome/Firefox stores.
- **Open-source leverage:** WXT (MIT) for the browser extension; `remix-auth` patterns if adding OAuth providers.

---

## Part 4 — Open-Source Leverage Plan (copy/adopt legally)

NEXTDOO is MIT, so it can adopt any MIT/Apache-2.0/BSD-licensed code freely, and can *use* (not copy) AGPL code only if it never distributes a modified AGPL core. Below are the highest-value, license-safe libraries for each gap. All are MIT/Apache-2.0 unless noted.

### Already using (good — don't churn)
- Next.js 15, React 19, Zod 4, Drizzle ORM, Vitest, Playwright, Turborepo, ICAL.js, web-push, Nodemailer, @node-rs/argon2.

### UI / interaction layer
| Library | License | Replace / what for |
|---|---|---|
| **shadcn/ui** | MIT | Copy-paste component set (buttons, dialogs, popovers, command). Ownership stays in-repo, no runtime dep. The fastest path to a polished, accessible UI. |
| **Tailwind CSS v4** | MIT | Utility styling — optional. The current single-CSS approach works; Tailwind only helps if the team prefers it. |
| **dnd-kit** | MIT | Modern, accessible drag-and-drop. Replaces any hand-rolled board DnD; accessible + touch-ready (mobile wins). |
| **@dnd-kit/sortable** | MIT | Sortable lists, kanban columns. |
| **react-aria** (Adobe) | Apache-2.0 | Accessible components (menus, dialogs, date pickers) — beats hand-rolled a11y. |
| **Downshift** | MIT | Accessible combobox/select for the mobile nav and filters. |
| **Motion** (Framer Motion, v11+ free tier) | — | Animations for the ritual/planning flows. (Check license — free for personal/education; commercial terms apply.) |
| **react-calendar / react-big-calendar** | MIT | Calendar views if the hand-rolled ones feel limiting. |
| **FullCalendar** | AGPL/commercial | Only if you need a premium calendar. **Avoid** — AGPL would force NEXTDOO's whole codebase AGPL or a commercial license. Stick with react-calendar. |

### Domain logic / utilities
| Library | License | What for |
|---|---|---|
| **rrule.js** | MIT | RFC 5545 recurrence rules. NEXTDOO has its own `recurrence.ts` — **keep it** (it's tested and offline-capable). Use rrule only if you need exotic RFC rules or want a battle-tested parser for the AI layer. |
| **date-fns v3** | MIT | Date math helpers if `calendar.ts` feels thin. |
| **zod** | MIT | Already using (v4). Keep. |
| **DOMPurify** | Apache-2.0/MIT | Sanitize markdown render output (already likely used — verify). |
| **react-markdown + remark/rehype** | MIT | Markdown rendering (verify if already used vs hand-rolled). |
| **TipTap** | MIT core | Rich-text editor for task descriptions/knowledge notes if the current one is basic. |
| **Lexical** (Meta) | MIT | Richer editor alternative. |

### State / data layer
| Library | License | What for |
|---|---|---|
| **TanStack Query** | MIT | Server-state caching, background refetch, optimistic updates. **Highest-value un-used lib.** NEXTDOO hand-rolls a lot of fetch/refresh — Query would cut that code substantially and make offline/online transitions smoother. |
| **Zustand** | MIT | Light client state (UI prefs, palette, offline queue status). |
| **IndexedDB via Dexie** | Apache-2.0/MIT | NEXTDOO hand-rolls IndexedDB caches — Dexie would make the offline queue more robust and testable. |
| **RxDB** | Apache-2.0 | Full offline-first database with sync — if you want to go all-in on offline (RxDB has its own sync protocol, but you can adapt yours). |
| **Yjs** | MIT | CRDT for real-time collaboration (Phase 6). |

### Mobile / desktop
| Library | License | What for |
|---|---|---|
| **Capacitor** | Apache-2.0 | iOS/Android wrapper (Phase 1). |
| **@capacitor/local-notifications** | Apache-2.0 | OS notifications on mobile. |
| **@capacitor-community/biometric-auth** | MIT | FaceID/TouchID unlock. |
| **Tauri** | MIT/Apache-2.0 | Desktop client (Phase 1). |
| **WXT** | MIT | Browser extension (Phase 3/7). |

### AI / automation
| Library | License | What for |
|---|---|---|
| **Vercel AI SDK** | Apache-2.0 | Provider-agnostic LLM calls (OpenAI/Anthropic/local). |
| **Web Speech API** | browser-native | Voice-to-task (no dep). |
| **imapflow / mailparser** | MIT | Email-to-task inbound (Phase 3). |

### Ops / infra
| Library | License | What for |
|---|---|---|
| **k6** | MIT | Load testing (already referenced in roadmap). |
| **supabase / neon** | MIT/Apache | Managed Postgres for the hosted demo. |
| **grafana/loki** | Apache-2.0 | Logging/monitoring for production. |

### What to AVOID (license traps)
- **FullCalendar** (AGPL/commercial) — would contaminate the MIT codebase.
- **AGPL-licensed libraries** generally — they force source disclosure of your whole app if you modify+distribute.
- **Proprietary "free" tiers** that require revenue share (e.g. some AI APIs) — fine to *call* via API, never to *vendor*.

### The golden rule for leveraging OSS
> **Prefer copy-paste (shadcn/ui model) over dependency for anything in your core UI.** Own the code, keep the MIT license clean, and you can relicense or commercialize later. Reserve dependencies for infrastructure (ORM, auth, AI SDK) where you genuinely benefit from maintenance.

---

## Part 5 — The honest 12-month summary

- **Months 1–2:** Phase 0 (demo + release gates) + Phase 1 PWA. This alone makes NEXTDOO *tryable* and *installable*.
- **Months 3–5:** Phase 1 (Capacitor mobile + Tauri desktop). Reach parity with competitors.
- **Months 5–7:** Phase 2 (daily ritual + Eisenhower + shutdown). This is the *differentiator* no competitor combines with honest analytics.
- **Months 7–9:** Phase 3 (Google/Outlook live sync + inbound connectors). Data portability.
- **Months 9–11:** Phase 4 (AI assist on a deterministic core) + Phase 5 (habits/streaks).
- **Month 12+:** Phase 6 (collab) + Phase 7 (growth).

**The bet:** NEXTDOO wins not by being a bigger checklist, but by being the only app that pairs Sunsama's planning ritual with Todoist's capture speed, TickTick's built-in habits/timers, **and** honest execution analytics — on every device, self-hostable, open-source. That combination does not exist today.

**Immediate next step:** confirm which phase to start (recommend Phase 0 + Phase 1 PWA first — highest leverage, lowest risk).
