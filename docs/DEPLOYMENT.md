# NEXTDOO Deployment Guide

**Status: deployment infrastructure complete. No public deployment is claimed.**

This document covers every supported deployment path. The recommended path
for a public demo is **Docker (docker compose)** — it runs the full stack
(web + worker + Postgres) with one command and mirrors production exactly.

---

## 1. Docker (recommended — full stack, one command)

The Docker image builds the Next.js app to standalone output and bundles the
worker. `docker-compose.yml` runs three services: Postgres, migrations (one-shot),
web, and worker.

### Prerequisites
- Docker 24+ and Docker Compose v2
- A strong `AUTH_SECRET` (32+ random characters)

### Steps
```bash
# 1. Configure
cp .env.example .env
# Edit .env: set AUTH_SECRET, APP_URL, and any provider keys you need.

# 2. Build and start
docker compose up --build -d

# 3. Verify
curl http://localhost:3000/api/v1/health
# → {"status":"ok",...}

# 4. Logs
docker compose logs -f web
```

### What runs
| Service | Purpose |
|---|---|
| `db` | PostgreSQL 16 (persistent volume) |
| `migrate` | One-shot: applies forward-only migrations, then exits |
| `web` | Next.js standalone server on port 3000 |
| `worker` | Background jobs (reminders, recurrence, tracking, mail) |

### Volumes
- `pgdata` — PostgreSQL data (survives restarts)
- `exports` — generated export artifacts (shared between web and worker)

### Tearing down
```bash
docker compose down        # stop services
docker compose down -v     # stop + delete data (irreversible)
```

---

## 2. Fly.io (cloud VPS, scales to zero)

Fly runs the web and worker as two processes in one app. Postgres is a Fly
Postgres cluster (or any reachable Postgres).

### Steps
```bash
# 1. Install Fly CLI and log in
curl -L https://fly.io/install && fly auth login

# 2. Create the app
fly app create nextdoo

# 3. Set secrets (use `fly secrets set`)
fly secrets set \
  AUTH_SECRET=$(openssl rand -hex 32) \
  DATABASE_URL=<your-postgres-connection-string> \
  APP_URL=https://nextdoo.app

# 4. Deploy
fly deploy

# 5. Run migrations
fly ssh console -- pnpm --filter @nextdoo/db migrate

# 6. Verify
curl https://nextdoo.app/api/v1/health
```

The `fly.toml` defines two processes: `web` (port 3000) and `worker`.

---

## 3. Vercel (web only — no worker)

Vercel hosts the Next.js web app. **The worker must run separately** (Fly, a
VPS, or a container platform). Use Vercel for the web layer and run the worker
anywhere with Postgres access.

### Steps
1. Import the repo at vercel.com/new.
2. Vercel auto-detects Next.js. The `vercel.json` pins the monorepo build.
3. Set environment variables in the Vercel dashboard:
   - `DATABASE_URL` — your Postgres connection
   - `AUTH_SECRET` — 32+ random characters
   - `APP_URL` — your Vercel URL
4. Run migrations once (against your Postgres):
   ```bash
   DATABASE_URL=... AUTH_SECRET=... pnpm --filter @nextdoo/db migrate
   ```
5. Deploy. The worker runs as a second service (see Fly or Docker above).

### Worker on a separate host
```bash
# On your worker host (any Linux with Node 22 + pnpm):
DATABASE_URL=postgres://... AUTH_SECRET=... APP_URL=https://nextdoo.app \
  pnpm --filter @nextdoo/worker start
```

---

## 4. Railway (web + worker as two services)

Railway detects Next.js from `railway.toml`. Create **two** Railway services:
one for web, one for worker (duplicate the app and change the run command).

### Web service
```bash
railway init
railway vars set AUTH_SECRET=... DATABASE_URL=... APP_URL=https://xxx.up.railway.app
railway up
```

### Worker service (separate app, same project)
```toml
# railway.toml (worker)
[build]
  command = "pnpm install --frozen-lockfile"
[run]
  command = "pnpm --filter @nextdoo/worker start"
```

---

## 5. Self-hosted VPS (Docker, manual)

For a traditional VPS (DigitalOcean, Hetzner, etc.):

```bash
# On the VPS
git clone https://github.com/Sudhanshu-git-hub/Nextdoo.git
cd Nextdoo

# Install Docker + Compose (one-time)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER

# Configure and run
cp .env.example .env
# Edit .env: AUTH_SECRET, APP_URL, set GOOGLE_CALENDAR_ENABLED if desired
docker compose up --build -d
```

Put a reverse proxy (Caddy/Nginx) in front for TLS. A ready-made Caddy
snippet:
```
nextdoo.app {
  reverse_proxy localhost:3000
}
```

---

## 6. Required environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `AUTH_SECRET` | ✅ | 32+ random chars; derives session + encryption keys |
| `APP_URL` | ✅ | Public URL of the web app |
| `LOG_LEVEL` | Optional | `debug`, `info`, `warn`, `error` (default `info`) |

### Provider variables (all optional, all disabled by default)

| Variable | Enables |
|---|---|
| `GOOGLE_CALENDAR_ENABLED` + `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | Google Calendar OAuth sync |
| `SMTP_URL` + `MAIL_FROM` | Email reminder delivery (requires TLS) |
| `S3_ENDPOINT` + `S3_BUCKET` + `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` | S3-compatible attachment storage |
| `STRIPE_*` / `RAZORPAY_*` | Billing (test mode only) |

### Security notes
- **Never** commit real `.env` files. Use `.env.example` as a template.
- `AUTH_SECRET` must be 32+ characters. Generate one: `openssl rand -hex 32`.
- In production, use managed secrets (Fly secrets, Vercel env, Docker secrets).
- The app enforces secure cookie flags and CSP nonces when `NODE_ENV=production`.

---

## 7. Migrations

Migrations are forward-only and serialized with a PostgreSQL advisory lock.
Run them before starting web/worker, or as a one-shot compose service:

```bash
# One-shot
DATABASE_URL=postgres://... AUTH_SECRET=... pnpm --filter @nextdoo/db migrate

# In docker compose, the `migrate` service does this automatically.
```

To roll back, use `pg_restore` from a recent backup (see `docs/MAINTENANCE.md`).
There is no `migrate down` — migrations are forward-only by design.

---

## 8. Health checks

| URL | Expected |
|---|---|
| `/api/v1/health` | `200 {"status":"ok"}` |
| `/login` | `200` (HTML) |
| `/api/v1/health` (worker) | worker logs `worker.schedule` at startup |

The docker-compose `web` service includes a healthcheck that polls
`/api/v1/health`.

---

## 9. Verifying a deployment

After starting, verify the full stack:
```bash
# 1. Health
curl https://your-url/api/v1/health

# 2. Register + sign in (browser or curl)
#    Visit https://your-url/register, create an account.

# 3. Create a task via quick capture
#    Type a task in the Today view.

# 4. Check the worker is running
docker compose logs worker | grep "worker.schedule"
# or: fly logs | grep "worker.schedule"

# 5. Run the E2E smoke suite against your deployment
#    Set DEMO_BASE_URL and run scripts/screenshot-demo.mjs
```

---

## 10. Cost estimates (rough)

| Path | Monthly cost | Notes |
|---|---|---|
| Docker on a $5 VPS | ~$5 | Full stack, your own server |
| Fly.io (2× tiny, PG) | ~$18–30 | Scales to zero, managed Postgres |
| Vercel (web) + Fly (worker+PG) | ~$20–35 | Best DX, two platforms |
| Railway (web+worker+PG) | ~$20–40 | Simple, all-in-one |

For a public demo, the **Docker on a $5 VPS** path is the cheapest full-stack
option. For managed convenience, **Fly.io** is the best single-platform choice.
