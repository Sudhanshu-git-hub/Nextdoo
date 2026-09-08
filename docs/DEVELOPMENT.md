# Development guide

How to run NEXTDOO locally, what exists today, and the conventions that keep the
codebase coherent. The [PRD](./PRD.md) remains the source of truth for behaviour.

## Requirements

| Tool       | Version | Notes                                       |
| ---------- | ------- | ------------------------------------------- |
| Node.js    | 22.x    | Uses native `node:` APIs and ESM throughout |
| pnpm       | 9.15.4  | `corepack enable` installs the pinned version |
| PostgreSQL | 16+     | A local instance is bundled; see below      |

## First run

```bash
pnpm install

# Boots an embedded PostgreSQL on port 55432 with a persistent .pgdata directory.
# Leave this running in its own terminal.
pnpm dev:services

# Apply migrations (hand-authored SQL, applied in filename order).
pnpm db:migrate

cp .env.example apps/web/.env.local   # then set AUTH_SECRET
pnpm dev
```

The app is served at <http://localhost:3000>. Create an account at `/register`;
registration provisions a personal workspace and a FREE subscription in one
transaction.

## Environment

Configuration is validated once at boot by `apps/web/src/server/env.ts`. A
missing required value crashes startup rather than degrading silently.

| Variable       | Required | Purpose                                        |
| -------------- | -------- | ---------------------------------------------- |
| `DATABASE_URL` | yes      | PostgreSQL connection string                    |
| `AUTH_SECRET`  | yes      | 32+ chars; derives session and encryption keys  |
| `APP_URL`      | no       | Absolute base URL, defaults to localhost:3000   |
| `REDIS_URL`    | no       | Durable queue; falls back to an in-process adapter |
| `SMTP_URL`     | no       | Outbound email; when unset, mail is logged instead of sent |
| `GOOGLE_*`     | no       | Calendar sync; the feature is hidden when unset |
| `STRIPE_*`     | no       | Billing; entitlements fall back to FREE         |
| `S3_*`         | no       | Attachment storage                              |

Optional integrations are genuinely optional: `features()` derives availability
from configuration so the UI can degrade honestly instead of failing at runtime.

## Commands

```bash
pnpm dev              # Next.js dev server
pnpm dev:worker       # background jobs (reminders, purges, outbox relay)
pnpm build            # production build of every package
pnpm typecheck        # tsc --noEmit across the workspace
pnpm test             # unit + integration tests
pnpm db:migrate       # apply pending SQL migrations
```

## Testing

```bash
pnpm test                                   # everything
npx vitest run packages/core                # pure domain logic, no I/O
npx vitest run apps/web                     # integration, needs a database
```

Integration tests **skip rather than fail** when no database is reachable, so a
fresh checkout is green without `pnpm dev:services`. They probe the connection at
module scope because Vitest chooses `it.skip` during collection, before hooks run.

Current coverage: 188 tests — 155 unit (scoring, recurrence, NL parsing, sync
merge rules, task state machine, TOTP) and 33 integration against real
PostgreSQL (optimistic locking, tenant isolation, append-only history, sync
replay and conflicts, MFA, password reset, export and account deletion).

The TOTP suite runs the published RFC 4226 and RFC 6238 test vectors, so the
implementation is checked against the specification rather than against itself.

## Layout

```
apps/web            Next.js App Router: UI, API routes, server services
apps/worker         background jobs: reminder dispatch, purges, outbox relay
packages/contracts  zod schemas, error taxonomy, entitlements — shared by all
packages/core       pure domain logic, no I/O, exhaustively unit tested
packages/db         Drizzle schema, migrations, client
```

Dependencies point inward: `core` knows nothing about HTTP or the database, and
`contracts` knows nothing about anything. That is what keeps the domain rules
testable without a running stack.

## Conventions

**Migrations are hand-authored SQL** in `packages/db/migrations`, applied in
filename order and recorded in `_migrations`. `drizzle-kit generate` is not used —
it fails against this ESM schema — so `schema.ts` and the SQL must be kept in
step by hand. Never edit an applied migration; add a new one.

**Every mutation is versioned.** Updates carry the client's `version` and the
UPDATE re-checks it in the WHERE clause, so a lost update becomes a 409 rather
than silent data loss.

**Tracking events are append-only**, enforced by a database trigger, not
convention. Scores are content-addressed on their inputs and superseded rather
than overwritten, so any number on the analytics page can be traced to the events
that produced it.

**Errors are RFC 7807 problem+json** with a stable `code` and a `request_id` that
matches the structured log line. Logs redact secrets and task content.

**Idempotency**: mutating routes accept an `Idempotency-Key` header and replay the
stored response within 24 hours. Sync mutations are deduped by `mutationId`.

## Local email

No SMTP provider is configured in development, so `sendMail` logs the message
instead of sending it — including the verification or reset link, which is the
only way to complete those flows locally:

```
{"level":"info","message":"mail.stub","kind":"reset-password","url":"http://localhost:3000/reset-password?token=..."}
```

Tokens are stored only as SHA-256, so the log is genuinely the sole source of
the raw value. Setting `SMTP_URL` switches to real delivery.

## Background jobs

The worker is a separate process so slow background work cannot affect request
latency. Every job is idempotent and claims rows with `FOR UPDATE ... SKIP
LOCKED`, so running several workers is safe.

| Job                      | Interval | Purpose                                       |
| ------------------------ | -------- | --------------------------------------------- |
| `reminders.dispatch`     | 30s      | Sends due reminders; expires those >24h stale  |
| `reminders.requeue_stuck`| 5m       | Recovers reminders orphaned by a crashed worker |
| `outbox.relay`           | 10s      | Publishes transactional outbox events          |
| `accounts.purge`         | 6h       | Deletes accounts past their 30-day grace period |
| `auth_tokens.purge`      | 12h      | Removes expired verification and reset tokens  |
| `idempotency.purge`      | 6h       | Clears replay records past their window        |

## Adding an endpoint

1. Define the request schema in `packages/contracts/src/schemas.ts`.
2. Put the behaviour in a service under `apps/web/src/server/services/`, taking an
   actor `{ userId, workspaceId }` and authorising at the resource boundary.
3. Wrap the route with `authedRoute` — it supplies validation, rate limiting,
   idempotency, problem+json and structured logging.
4. Emit a tracking event for anything that reflects user intent, and an audit log
   entry for anything security-relevant.
5. Cover the rule in `packages/core` if it is pure, or an integration test if it
   touches the database.

## Troubleshooting

**`numeric field overflow`** — a `position` column narrower than the epoch
milliseconds written into it. Fixed by migration `0001`; mentioned here because
the symptom is opaque.

**`Module not found: ./x.js`** — the Next.js bundler does not rewrite `.js`
specifiers to `.ts` sources. Import workspace-relative modules without the
extension.

**`column "status" is of type X but expression is of type text`** — a raw SQL
`CASE` producing string literals needs an explicit `::enum_name` cast.

**`The "string" argument must be of type string ... Received an instance of
Date`** — the `postgres` driver cannot bind a `Date` inside a raw `sql` fragment.
Use Drizzle's comparison helpers (`gt`, `lte`), or pass `.toISOString()` with an
explicit `::timestamptz` cast.

**Port 55432 already in use** — a previous `pnpm dev:services` is still running.
Its data lives in `.pgdata/` and is safe to reuse.
