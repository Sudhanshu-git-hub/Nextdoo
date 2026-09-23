# PC4 — Connected daily workflows

## Baseline audit (before implementation)

Inspected clean local `main` and independently verified GitHub `main` at `13792eab7f3f72dde69a68b2de8beaebd96f8ab0` on 2026-09-23. The current PRD and PC1/PC2/PC3 milestone boundaries remain authoritative.

Already working:

- Goal Center owns goals/milestones and existing goal_tasks/milestone_tasks links. Its read projection deduplicates tasks across goal and milestone paths. Completion is read from authoritative Task history; no event-driven progress counter is needed.
- Tracker owns personal_tracker_links, durable task-completion source receipts, one record per actual tracker day and scoring/report logic. Existing worker ingestion is retry-safe, preserves history and respects pause/archive ingestion boundaries.
- Knowledge uses owned knowledge_relations with real target foreign keys. Record/note pages can create links to Tasks, Goals, Milestones and Trackers. Task/Goal/Tracker pages already show backlinks, but adding links requires starting in Knowledge; milestones have no contextual references panel.
- Today already shows overdue/due tasks and workspace-day capacity. Calendar already paginates tasks and displays supported provider events. Neither supplies a connected cross-module summary or additional domain-date layers.
- Task-local search and Knowledge-local search exist; no shared type-aware search page exists. Tasks do not expose their Goal/Milestone/Tracker links in the editor.
- Shared authenticated/idempotent routes, outbox, sync deltas, audit, attachment security and account data rights are available and must be reused.

PC4 adds bounded read projections, contextual navigation, existing-relation controls, a compact Today summary, a minimum search page and read-only Calendar layers. It adds no relationship tables, progress counters, scoring, event consumers, notification chains or full Insights dashboard. Tracker frequency is descriptive, so no future tracker appointments are fabricated.

## API and data boundaries

No schema migration. All four new endpoints are authenticated GET routes under `/api/v1/connected` and derive the workspace from the session:

| Route | Contract |
| --- | --- |
| `/search` | Literal substring search across tasks, goals, milestones, trackers, databases, records and notes. Type filter, stable title/type/id ordering, default 40 and maximum 100 results, explicit next offset. Excludes archived/deleted items and records/notes in archived databases. |
| `/tasks/:id` | Existing direct goal, milestone/parent goal and tracker connections. Deduplicated goal results; retained archived links are labeled. Deleted or foreign tasks return 404. |
| `/today` | Existing upcoming tasks, active goals/milestones linked to due work, active Tracker daily status, Knowledge references for due work, the current user's saved calendar events and dates through the next seven days. Six items per section and a visible route to more. |
| `/calendar` | Bounded range of at most 93 days, up to 100 entries per page. Active goal/milestone deadlines in workspace time, existing Tracker activity on its original tracker date, visible Knowledge DATE properties. No busy intervals or capacity changes. |

Today and task context use repeatable-read snapshots. Search is a single database projection; it has no secondary index to synchronize. Queries never accept an alternate workspace or user. Existing task events, source receipts and worker ingestion remain authoritative. Reading connected views emits no new domain events, preventing circular update chains.

Knowledge linking from context fetches the current record/note version and uses the existing PC3 relation endpoint with an idempotency key. Concurrent edits retain existing conflict handling. Unlinking remains available from the source record/note. Milestone reference navigation now targets the exact milestone anchor.

## User experience

- Search in the existing sidebar, with type-aware links and a direct Task page that reuses the Task editor.
- Task editor shows related Goals, Milestones and Trackers alongside Knowledge references.
- Task, Goal, Milestone and Tracker reference panels can attach existing records or notes.
- Today keeps its existing due/overdue task list first, followed by compact context cards. It refreshes after local task changes, sync notifications, manual refresh and every 30 seconds while visible and online.
- Calendar keeps its task/provider behavior and adds independently toggleable context layers. Additional pages load explicitly; these items cannot reschedule a task or affect workday capacity.

## Validation scope

`connected.integration.test.ts` exercises the full Goal/Milestone/Task/Tracker path, repeated/concurrent ingestion, deduplicated progress, all four Knowledge target types, retry-safe links, concurrent reference edits, search pagination/literal matching, workspace isolation, Today, Calendar/time zones/hidden properties, archive/pause/restore, Knowledge soft deletion, and the permanent-task-deletion FK cascade. Existing retention tests remain responsible for purge eligibility and worker retry policy.

`e2e/connected.spec.ts` covers Task contextual navigation, Knowledge linking from Task/Goal/Milestone/Tracker, mobile search and task deep links, Today, Calendar toggles/navigation, authentication and foreign-task rejection. Existing PC1/PC2/PC3 suites retain their original assertions and gates.

Local checkpoint (2026-09-23): 985 tests in 85 files passed with all coverage thresholds met (93.75% total lines); this includes 13 new connected integration tests. All seven package type checks, lint and the final production build passed. Migration and replay both reported up to date. The combined Calendar/Goal/Tracker/Knowledge/Connected Chromium run passed all 34 scenarios without retries, including six new PC4 browser scenarios. Mobile Today was visually inspected at 390px and overflow assertions passed. The unchanged GitHub workflow must also verify this commit, including the full browser suite, real ClamAV and backup/restore checks; its exact run and commit identifiers are recorded in the delivery report.

## Deliberate limits

Connected views and reference writes require an online connection. Search is a bounded SQL substring foundation, without ranking, fuzzy matching or a global document index. Offset pages can shift when other devices edit concurrently. Calendar date-only values are not appointments; Tracker dates retain the tracker time zone, and paused trackers show past recorded activity while archived trackers are excluded. Today uses saved provider events and does not trigger a provider refresh. Full Insights, future Tracker schedule generation, native clients, AI and collaboration are not part of PC4.
