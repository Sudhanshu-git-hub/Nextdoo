# PC3 — Knowledge & Data

PC3 gives an individual a persistent personal knowledge library: databases with typed properties, records with content, standalone or associated notes, scanned files, and real references to existing work. It follows Goal → Milestone → Task, with Task branching into Tracker and Knowledge/Data, then supported Calendar and Reports projections. It introduces no second task engine, progress calculator or scoring system.

## Data and lifecycle

Additive migrations `0028_knowledge_data.sql` and `0029_knowledge_reference_types.sql` create eight tables: knowledge_databases, knowledge_properties, knowledge_records, knowledge_values, knowledge_notes, knowledge_note_tags, knowledge_relations and knowledge_files. Apply migrations before the web deployment. Applied migration bytes are immutable. Application rollback can leave these additive tables in place; dropping them would destroy personal data.

Each database has exactly one visible Title property. The supported types are TITLE, TEXT, RICH_TEXT, NUMBER, CHECKBOX, SELECT, MULTI_SELECT, DATE, URL, EMAIL, PHONE, FILE and RELATION. Stable property IDs survive rename, reorder, visibility and configuration edits. Types stay fixed. Properties containing values/references, including soft-deleted records, cannot be removed. Select configuration changes cannot invalidate existing values. Relation target configuration cannot change while links exist.

Values use typed scalar columns, never an arbitrary record JSON blob. Database-level checks enforce storage type, owned composite foreign keys and exact reference targets. Generated FILE/RELATION discriminator columns prevent a reference from being stored in the wrong property type. Property configuration is small validated JSON. Limits are 40 properties/database, 50 select choices, 20,000 characters/content, 200 relations/item and 200 file references/record. Null/missing is distinct from zero and false.

Databases can be favorited and archived/restored. Records can be edited, duplicated and soft-deleted/restored. Duplication copies content, scalar values, relations and file references; associated notes and directly owned uploads keep their original owner and are not cloned. Notes can be standalone or attached to one database or record. Notes reuse existing workspace tags. Rich text uses the existing sanitized Markdown renderer, with no executable HTML or new editor framework.

## Services and APIs

Contracts are in `packages/contracts/src/knowledge.ts`; pure templates and CSV serialization are in `packages/core/src/knowledge.ts`. Server services are separated into mutation, query and relation modules. Workspace transactions serialize writes; expected versions reject stale changes. Outbox, sync deltas and content-free audit metadata commit atomically. This increment is online-only. It does not add Knowledge data to the offline editing queue or claim offline synchronization.

The authenticated `/api/v1/knowledge/[...path]` route dispatches only explicit method/path combinations, with shared origin validation, idempotency ledger and rate limits:

| Endpoint | Methods / purpose |
| --- | --- |
| `/databases` | GET list/search; POST create from blank/custom properties or template |
| `/databases/:id` | GET paginated records and definitions; PATCH metadata/archive/favorite |
| `/databases/:id/properties[/:propertyId]` | POST add; PATCH configure; DELETE safe removal |
| `/databases/:id/reorder` | POST complete ordered property IDs |
| `/databases/:id/records` | POST record |
| `/databases/:id/export` | GET CSV/JSON for the explicitly bounded filtered page |
| `/records/:id` | GET detail; PATCH full scalar/content replacement; DELETE soft-delete |
| `/records/:id/restore`, `/duplicate`, `/relations`, `/files` | POST versioned commands |
| `/notes` | GET search/parent-filtered pages; POST create |
| `/notes/:id` | GET detail; PATCH content/tags; DELETE soft-delete |
| `/notes/:id/restore`, `/relations` | POST versioned commands |
| `/templates`, `/targets`, `/backlinks`, `/resources` | GET owned template/search/reference projections |

Search covers database names, record titles/content/text properties and note titles/content. Record filters support equality, text contains, exists/missing, numeric/date comparison, select/multi-select and checkbox values. Sorting uses valid scalar properties or creation/update dates with a stable ID tie-breaker. SQL handles filtering, sorting and pagination (40 by default, maximum 100). Only the current page's property values are loaded. Table is primary; list/gallery and first-select-grouped board show the same bounded page. Offset pages are stable for an unchanged query but may shift during concurrent insertions. The UI currently combines one filter at a time; the API accepts up to ten AND filters. Saved views can later persist the validated query shape without changing storage.

## Integration and privacy

Relations use owned foreign keys to records, databases, notes, tasks, goals, milestones, trackers and calendar events. Notes and records can both originate general relations; typed record relation properties can restrict the target kind and database. Task, Goal and Tracker details show incoming Knowledge links. Task links open the existing task editor. Linking never changes execution history, goal progress or tracker scores. Calendar relations point to existing events; date fields do not yet create events or calendar overlays.

Attachments extend the existing owner boundary to one task, goal, record or note. The existing quota, object store, signed upload/download URLs, scanner queue, clean-only download gate and deletion path remain authoritative. FILE values reference only owned clean uploads. The resource picker excludes deleted sources. Archive blocks new uploads; record/note deletion blocks downloads until restoration. Shared file references do not transfer ownership. Binary file contents are not included in JSON/CSV exports.

Full account export includes all eight Knowledge tables and existing attachment metadata. Account purge cascades the complete graph and uses the existing object-store cleanup. Page export is explicitly labeled and includes pagination metadata in JSON; it is not advertised as a complete bulk export. CSV cells escape spreadsheet formula prefixes. A background bulk exporter and external importers are future work.

## UI and templates

Knowledge & Data is in the main navigation. Users can create databases, preview templates, configure properties, browse/search/filter/sort records, open details, edit content, add associated notes/files, and link to existing work. All mutations retain drafts on failures. Explicit “Reload saved version” handles stale edits without silently overwriting another device's changes.

Eleven independent templates are included: Books, Courses, Study Notes, Workout Log, Finance, Movies/Shows, Recipes, Research, Journal, Contacts and Personal Projects. Templates create fresh property IDs and do not share mutable definitions. Financial/workout templates are general personal data structures, not new advice or tracking engines.

## Validation and remaining scope

Dedicated tests cover typed storage, invalid writes and rollback, property lifecycle, filtered pagination, ownership and direct foreign keys, concurrent versions, duplication, deletion/restore, tags, target restrictions, templates, CSV safety, export/purge and secure attachment ownership. Nine Chromium scenarios exercise creation, property editing, records, filters/sort/views, notes, templates, Task/Goal/Tracker integration, mobile layout, exports, HTTP replay/isolation and conflict preservation. Final test/build/CI results must be verified for the committed SHA, not inferred from this inventory.

Local acceptance on 2026-09-23 passed the dedicated unit/integration checks, all nine Knowledge Chromium scenarios, all seven package type checks, repository lint and the production build. The first full regression run passed 971/972 tests; the unchanged worker crash-recovery test exceeded its worker-start polling deadline while build/validation processes were overlapping. Its isolated rerun passed without modifying the test or deadlines. Final coverage and CI evidence is recorded separately for the pushed commit. The two new migration files preserve their exact bytes through Git attributes to keep checksums stable across operating systems.

This is a bounded personal module. WYSIWYG/block editing, collaborative databases, formulas/rollups, arbitrary automation, universal cross-module search, offline Knowledge edits, saved views, rich gallery covers, bulk import/export jobs, calendar overlays and combined Reports/Insights remain future work. UI target-database configuration currently lists the first 100 active databases; target item/resource searches themselves are paginated. PC4 does not begin until PC3 validation is complete.
