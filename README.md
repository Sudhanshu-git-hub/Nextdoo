# NEXTDOO

An outcome-oriented task and time-management platform for Web and Windows Desktop.

> Help users plan work against available time, execute it, and understand whether their execution matched their intentions.

## Documentation

- [Product Requirements Document & Technical Blueprint](docs/PRD.md) — full PRD: strategy, phasing, tracking system, architecture, sync design, security, reliability, database, API, monetization, testing, delivery plan, decision register.

## Status

Recovered implementation with verified incremental quality/security repairs. **Not a release-complete MVP.**

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

## Latest Phase 1 increment

**Browse tasks** (`/tasks`, linked from Inbox and project tasks) supports combined
filters, six sorts, and now confirmed **all-or-nothing bulk complete/archive/reschedule**
for up to 100 explicitly selected tasks. Versions and retry identity protect against
partial writes or duplicate acknowledged operations. These workflows are online-only.

Validation: **363 tests in 39 files, 50 browser/API scenarios**, all existing gates
passing and zero dependency findings. See the bulk milestone for boundaries and
rollout guidance. **Phase 1 remains incomplete**: the completion ledger explicitly
tracks recurrence, offline/Windows, provider integrations and operational acceptance
rather than treating core tasks as the whole MVP.
