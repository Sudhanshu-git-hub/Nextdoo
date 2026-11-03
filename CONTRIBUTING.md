# Contributing to NEXTDOO

Thank you for your interest in improving NEXTDOO. This guide explains how to set up the repository, the conventions we follow, and how to get a pull request reviewed. Commands here are the project's real scripts — keep them consistent with [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md), which remains the authoritative development guide.

## Development prerequisites

- **Node.js 22.22+** (CI uses 22.22.3)
- **pnpm 9.15.4** — the repository pins it via the `packageManager` field: `corepack enable` makes `pnpm` available
- **PostgreSQL 16+** — either a system installation or the repository's embedded PostgreSQL (`pnpm dev:services`), which is the recommended local path
- No Docker, Redis, or external services are required for the core development workflow

## Repository setup

```bash
git clone https://github.com/Sudhanshu-git-hub/Nextdoo.git
cd Nextdoo
corepack enable
pnpm install --frozen-lockfile
```

The lockfile is authoritative. Do not run `pnpm install` without `--frozen-lockfile`, and do not update dependency versions in a feature branch unless the change is deliberate and reviewed.

## Installation and environment configuration

```bash
# Terminal 1 — embedded PostgreSQL on port 55432 (isolated test database)
PGPORT=55432 PGDATABASE=nextdoo_test PGDATA_DIR="$PWD/.data/test-postgres" pnpm dev:services
# prints: DATABASE_URL=postgres://postgres:postgres@localhost:55432/nextdoo_test

# Terminal 2 — export the environment explicitly; pnpm/tsx do not load .env files automatically
export DATABASE_URL=postgres://postgres:postgres@localhost:55432/nextdoo_test
export AUTH_SECRET=test-only-secret-at-least-32-characters
export APP_URL=http://localhost:3000
```

Required for database-backed flows: `DATABASE_URL` and `AUTH_SECRET` (32+ random characters). `APP_URL` controls absolute links. Never commit real secrets or credentials. Optional variables (`GOOGLE_*`, `STRIPE_*`, `RAZORPAY_*`, `S3_*`, `SMTP_URL`, `REDIS_URL`) are documented in [.env.example](.env.example) and [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Database initialization

```bash
pnpm db:migrate     # applies all forward migrations
pnpm db:migrate     # safe rerun: reports "Already up to date"
pnpm dev            # starts the web app on http://localhost:3000
pnpm dev:worker     # optional: background worker (reminders, tracking, mail, retention)
```

Use an isolated test database (`PGDATABASE=nextdoo_test`), never a valuable or production database, for local development and testing.

## Branch naming

Create a feature branch from `main` using conventional prefixes:

| Prefix | Use |
|---|---|
| `feat/` | New feature or user-facing capability |
| `fix/` | Bug fix |
| `docs/` | Documentation only |
| `security/` | Security hardening or remediation |
| `refactor/` | Internal restructuring without behavior change |
| `test/` | Test-only changes |
| `chore/` | Tooling, CI, maintenance |

Examples: `feat/goal-center-export`, `fix/sync-cursor-ordering`, `security/attachment-finalization-race`.

## Commit conventions

We use [Conventional Commits](https://www.conventionalcommits.org/). Each commit message has the form:

```
<type>(<optional scope>): <short imperative summary>
```

Types: `feat`, `fix`, `docs`, `security`, `refactor`, `test`, `chore`, `build`, `ci`. Scope is optional and should name the module (e.g. `tasks`, `sync`, `calendar`, `mfa`). The first line is imperative and summarizes the change; use the commit body for rationale and test evidence. Example: `fix(tasks): serialize bulk completion under the workspace lock`.

Do not mix unrelated changes in one commit. Squash-merge is used for feature branches; keep each branch focused so the squashed commit reads as one logical change.

## Code quality requirements

- **TypeScript strictness.** The codebase runs with `strict`, `noUncheckedIndexedAccess`, and `noImplicitOverride`. New code must typecheck cleanly.
- **Linting.** `pnpm lint` must pass with zero warnings (`eslint . --max-warnings=0`). Do not disable or broaden lint rules to make a change pass; fix the code or raise the question in review.
- **No silent failures.** Database-backed tests must fail when the database is unavailable — never silently skip. If you add an integration test, it must use the existing `requireTestDatabase()` helper.
- **Hand-authored SQL.** Migrations are checksummed, forward-only SQL in `packages/db/migrations/`. Never edit an applied migration; add a new forward migration and update `packages/db/src/schema.ts` to match.
- **Honest boundaries.** Do not present planned or partial functionality as complete. If a change leaves a boundary, document it in the relevant milestone doc or this guide.
- **Security defaults.** Never introduce credentials, weaken authorization checks, disable validation, or bypass the security scanner's findings. If a legitimate exception is needed, it requires an explicit, reviewed allowlist entry (see [SECURITY.md](SECURITY.md)).
- **Data integrity.** Preserve existing semantics: tenant/owner scoping, optimistic versioning, idempotent request identities, transactional outbox/audit writes. Do not fabricate values or rewrite history.

## Running tests

```bash
pnpm test:unit       # pure core + tooling; no database required
pnpm test            # full unit + integration suite (requires migrated DATABASE_URL)
pnpm test:coverage   # full suite + V8 coverage reports
pnpm typecheck       # all seven packages
pnpm build           # production web build
pnpm test:e2e        # Playwright: production build + real DB + real Chromium on :3100
```

Run the full gate chain before opening a pull request:

```bash
export DATABASE_URL=postgres://postgres:postgres@localhost:55432/nextdoo_test
export AUTH_SECRET=test-only-secret-at-least-32-characters
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm build
```

E2E tests start their own production server on port 3100 with a real Chromium browser and zero retries; they refuse to reuse a developer's running server. If browser CDN access is unavailable locally, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can point to an already installed real Chromium — do not disable browser security or mock responses to claim E2E success.

## Database migration expectations

- New migrations are numbered automatically by `pnpm db:generate <name>`, which scaffolds the next SQL file (it does **not** infer schema differences — edit the file yourself).
- Migrations must be additive, transactionally safe, and replay-idempotent. Verify both a fresh install and an upgrade from the current tip.
- Keep `packages/db/src/schema.ts` aligned with the SQL.
- Do not edit or delete applied migration files; checksum verification will fail.
- If a migration adds columns or changes semantics, add integration tests covering the new behavior and account for export/purge implications (see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)).

## Pull request process

1. Open an issue first for substantial changes (features, architecture changes) so the approach can be discussed. Small fixes can go straight to a pull request.
2. Branch from `main`, implement, and keep the branch focused.
3. Run the full gate chain above locally and include exact results in the PR description (test counts from output, not from memory).
4. Fill in the pull request template: summary, changes, related issue, tests performed, screenshots for UI changes, migration impact, and security implications.
5. Keep the PR description updated as review feedback is addressed.

## Review expectations

- **First review:** correctness, tests, and boundary honesty. Reviewers check that claims match implementation and that regressions are covered.
- **Security review:** any change touching authentication, authorization, data isolation, file handling, or secrets receives focused review against [SECURITY.md](SECURITY.md) and the [control matrix](docs/M8_i8_SECURITY_CONTROL_MATRIX.md).
- **Migration review:** any new migration requires explicit review of additivity, checksums, rollback behavior, and export/purge implications.
- Reviews are thorough but pragmatic: focus on behavior, data integrity, and maintainability rather than style preferences already enforced by tooling.

## Security-sensitive contribution restrictions

- **Do not** weaken authentication, authorization, or data-isolation checks for demonstration purposes or test convenience.
- **Do not** commit real credentials, tokens, keys, or connection strings. The repository's security scan rejects tracked `.env` variants and credential-like patterns; the scanner is a bounded check, not a substitute for review.
- **Do not** disable TLS verification, introduce `shell: true` child processes, dynamic code execution, or unreviewed `sql.raw` usage.
- **Do not** add new dependency versions without justification; keep the lockfile frozen and let `pnpm audit --audit-level high` gate the change.
- **Do not** publish or discuss security vulnerabilities in public issues. Use the repository's GitHub Security Advisories tab — see [SECURITY.md](SECURITY.md).

## Code of conduct

By participating, you agree to uphold the [Code of Conduct](CODE_OF_CONDUCT.md).

## Maintainer coordination

If you plan to contribute regularly, introduce yourself in an issue. Maintainer responsibilities are documented in [MAINTAINERS.md](MAINTAINERS.md).
