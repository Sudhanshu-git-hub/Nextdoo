# NEXTDOO

Personal productivity and life-management workspace, starting on the web.

> Connect goals, milestones, tasks, trackers, knowledge and data, calendar, and insights so people can plan, do, track, store, schedule, and understand their progress.

## Documentation

- [Product Requirements Document & Technical Blueprint](docs/PRD.md) — authoritative strategy, scope labels, requirements, architecture and roadmap.
- [Personal-first reconciliation audit](docs/PERSONAL_CORE_AUDIT.md) — inspected baseline, current boundaries, risks and next implementation order.

## Status

Recovered implementation with substantial task, execution-tracking, sync, calendar and quality/security work. **Not a release-complete personal workspace.** Goal Center provides online goals, sub-goals, milestones and task-linked progress. Tracker adds configurable tracking tables, automatic task evidence, rules, star scores, reports and templates. Knowledge & Data adds online typed databases, records, notes, scanned resources and owned relations to existing work. See [Goal Center boundaries and validation](docs/GOAL_CENTER_MILESTONE.md), [Tracker boundaries and validation](docs/TRACKER_MILESTONE.md), and [Knowledge & Data boundaries and validation](docs/KNOWLEDGE_DATA_MILESTONE.md).

- [Development and verification](docs/DEVELOPMENT.md)
- [Phase 1 completion ledger and remaining work](docs/PHASE1_COMPLETION_PLAN.md)
- [Atomic bulk task operations milestone](docs/TASK_BULK_MILESTONE.md)
- [Phase 1 task filtering and sorting milestone](docs/TASK_FILTERING_MILESTONE.md)
- [Phase 1 task archive, deletion and recovery milestone](docs/TASK_LIFECYCLE_MILESTONE.md)
- [Phase 1 subtasks and dependencies milestone](docs/TASK_RELATIONSHIPS_MILESTONE.md)
- [Project execution analytics milestone](docs/PROJECT_ANALYTICS_MILESTONE.md)
- [Project sections and board milestone](docs/PROJECT_BOARD_MILESTONE.md)
- [Project lifecycle milestone and validation](docs/PROJECT_LIFECYCLE_MILESTONE.md)
- [Online workflow milestone and validation](docs/ONLINE_WORKFLOW_PHASE.md)
- [Audit-remediation report and release blockers](docs/AUDIT_REMEDIATION_REPORT.md)
- [Implementation log and remaining limitations](docs/IMPLEMENTATION_LOG.md)

The PRD remains the source of truth; routes, schemas and green unit tests alone do not establish feature completion.

## Historical Phase 1 bulk-task increment

**Browse tasks** (`/tasks`, linked from Inbox and project tasks) supports combined
filters, six sorts, and now confirmed **all-or-nothing bulk complete/archive/reschedule**
for up to 100 explicitly selected tasks. Versions and retry identity protect against
partial writes or duplicate acknowledged operations. These workflows are online-only.

Validation at that checkpoint: **363 tests in 39 files, 50 browser/API scenarios**, all existing gates
passing and zero dependency findings. See the bulk milestone for boundaries and
rollout guidance. **Phase 1 remains incomplete**: the completion ledger explicitly
tracks recurrence, offline/Windows, provider integrations and operational acceptance
rather than treating core tasks as the whole MVP.
