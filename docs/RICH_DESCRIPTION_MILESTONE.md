# Rich task description — acceptance report

Date: 2026-09-09 (Asia/Calcutta). Scope: the next M2 Task & Planning UX
increment from execution-order item 4 of
[PHASE1_COMPLETION_PLAN.md](PHASE1_COMPLETION_PLAN.md) — the "rich
description" required task field (PRD §6.3) with a production-quality
edit/preview/sanitization/accessibility experience. **This is not full
M2:** collection scalability, capture/mutation instrumentation and the
remaining performance/a11y acceptance stay open (explicitly not started per
the agreed increment boundary).

## Design decisions

- **Storage is unchanged.** The description remains a plain string
  (≤ 20,000 chars, nullable) in the existing column, API contract, zod
  schema, sync writable-field list and full-text search index. The stored
  value is **Markdown source**, not HTML — hostile input is inert data until
  a rendering step, so no migration, no API change, no sync or search change
  was required (the PRD does not prove any of those necessary).
- **One safe renderer, shared by every rendering surface.**
  `packages/core/src/description.ts` renders a documented Markdown subset to
  HTML by construction: source HTML is never parsed (always escaped), the
  output is a fixed tag whitelist with a fixed attribute set, link targets
  are restricted to `http:`/`https:`/`mailto:` after stripping all ASCII
  control/whitespace characters (defeating `java\tscript:`-style tricks),
  and links always carry `rel="noopener noreferrer" target="_blank"`.
  This satisfies the PRD security requirement that rendered rich text is
  sanitized: there is no other description rendering path, and the pure
  core function is available server-side for any future server rendering
  (export/email) as well.
- **Supported subset:** headings `#`–`######`, paragraphs with soft line
  breaks, bold/italic/strikethrough/inline code, fenced code blocks,
  unordered/ordered lists with two-space nesting (≤ 4 levels), task-list
  items `- [ ]` / `- [x]` (disabled checkboxes), blockquotes, horizontal
  rules, and safe links. **Deliberately not supported** (rendered
  literally): images, tables, setext headings, autolinks, reference links.
- **Read/preview mode lives in the editor** (edit ⇄ preview toggle plus the
  conflict banner's rendered "Server notes"). Task rows, calendar chips and
  board cards are intentionally unchanged: the PRD does not require
  description text on those surfaces, and this keeps the virtualized-list
  and calendar contracts untouched.
- The editor field is renamed Notes → **Description** (PRD field name) with
  a visible Markdown hint, a live character counter that turns red at the
  20,000 limit, and a `maxLength` on the textarea.

## Delivered behavior

- **Edit:** Markdown source editing in the shared `TaskEditor` dialog
  (create flow: quick capture creates the task, the editor adds the
  description — unchanged); the counter and limit are surfaced in the UI.
- **Preview:** keyboard-accessible toggle (`aria-pressed` state, native
  button) renders the description safely: headings, emphasis, code blocks,
  nested lists, disabled checklist boxes, quotes, rules and new-tab links;
  empty descriptions show a "No description yet." state.
- **Sanitization:** `<script>`, event-handler attributes, `javascript:`/
  `data:`/`vbscript:`/relative link targets, `<img>`, `<svg>`, `<iframe>`,
  `<form>`, `<style>`, `<meta>`, `<base>` etc. all render as literal text
  and never execute (E2E probes `window.__pwned` markers before and after
  preview). The raw source is persisted unchanged — the server does not
  rewrite it.
- **Conflicts:** on a version conflict the banner renders the **server**
  description safely (its own `aria-label="Server description"` region)
  while the user's draft stays in the form untouched; "Keep my changes
  against this version" applies only the changed fields (E2E: title/priority
  from the server plus the user's description survive the round trip).
- **Compatibility:** whole-word search still matches description text;
  sync push/pull carry description through the writable-field boundary;
  complete/reopen and every other task flow are unchanged (E2E-verified).
- **Accessibility:** label/hint/counter associations on the textarea,
  named preview region, axe (WCAG 2.0/2.1/2.2 A+AA) clean on the dialog.

## Changes

- `packages/core/src/description.ts` (new) — `safeHref` (scheme allowlist +
  control-character stripping), `renderInline` (code, links, bold, strike,
  italic with word-boundary `_` rules, line breaks) and
  `renderDescription` (line-based block parser: fences, headings, rules,
  blockquotes with nesting, single-type list groups with indent nesting,
  paragraphs). Pure function, no DOM.
- `packages/core/src/description.test.ts` (new) — 45 unit tests: link
  allowlist/denylist (including `JAVASCRIPT:`, embedded-tab and
  whitespace scheme tricks), escaping, emphasis edge cases,
  snake_case preservation, code fences, list nesting/type-splitting,
  task-list checkboxes, quotes, rules, a mixed-document golden test, and a
  20-entry hostile-input invariant suite asserting only whitelisted tags
  and whitelisted attributes may appear, plus a 20k-character case.
- `packages/core/src/index.ts` + `packages/core/package.json` — barrel
  export plus a `./description` subpath export so the client bundle imports
  only this dependency-free module (the barrel pulls `node:crypto` via
  `totp` and is server-only).
- `apps/web/src/components/TaskEditor.tsx` — Notes → Description field with
  Markdown hint, character counter (`desc-count-limit` styling at the cap),
  edit/preview toggle (textarea stays in the DOM `hidden` so the label
  association survives), `role="region"` preview rendered through
  `renderDescription`, and the conflict banner's server notes rendered
  safely instead of as raw text.
- `apps/web/src/app/globals.css` — `.description-preview` typography
  (headings, code/pre, lists, checklist spacing, quote, rule, links) and
  `.desc-count-limit`.
- `apps/web/e2e/task-description.spec.ts` (new) — 6 browser E2E tests
  against the production build:
  1. edit → preview → save → reopen round trip: rendered structure
     (heading, bold, link attributes, nested list, 2 disabled checkboxes,
     code fence, quote), raw source persisted and reloaded;
  2. hostile-input preview: 6 payload families, no executed marker, no
     script/img/svg/javascript-anchors in the preview DOM, literal text
     visible, allowed link intact, raw source persisted;
  3. the 20,000 limit: `maxlength` attribute, counter at the cap with the
     limit styling, API 400 `VALIDATION_FAILED` at 20,001 (nothing
     persisted), the at-limit value saves;
  4. conflict: banner with rendered server notes region, draft value
     preserved, keep-changes applies only changed fields;
  5. keyboard-only preview toggle round trip (`aria-pressed` states, named
     region) plus axe on the dialog;
  6. description visible to whole-word search, sync push/pull carry it,
     and complete-from-list still works.
- `apps/web/e2e/online.spec.ts` — one selector renamed with the field
  (`getByLabel('Notes')` → `getByLabel('Description')`); every assertion in
  that conflict/draft-preservation test is unchanged and passing, including
  the raw `<script>private notes</script>` string being stored verbatim.

No migration; no API, contract, schema, sync or search change.

## Verification (all executed in this environment)

- New renderer unit suite: **45/45 pass** (vitest).
- New browser E2E suite `e2e/task-description.spec.ts`: **6/6 pass**.
- Full gates re-run green after the change: lint (`eslint .
  --max-warnings=0`), typecheck (5 packages plus direct `tsc --noEmit` in
  `apps/web` and `packages/core`), `test:coverage` (50 test files / 492
  tests, thresholds held), production build, migration integrity (replay is
  a no-op; no new migration), and the complete E2E suite (**102 passed** =
  96 baseline + 6 new, including the pre-existing
  editor-conflict/draft test and the virtualized-list axe test).
