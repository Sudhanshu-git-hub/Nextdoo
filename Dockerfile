# syntax=docker/dockerfile:1
# NEXTDOO production image — web (Next.js standalone) + worker (tsx).
#
# Build:  docker build -t nextdoo .
# Run:    docker compose up
#
# The image is built in three stages:
#   deps   — install all workspace dependencies (cached layer)
#   build  — compile the Next.js app to standalone output
#   runner — minimal runtime with web standalone + worker source

# ---------------------------------------------------------------- deps
FROM node:22-slim AS deps
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/calendar/package.json packages/calendar/
COPY packages/billing/package.json packages/billing/
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------- build
FROM deps AS build
COPY . .
# Build the web app (standalone). The worker runs TypeScript via tsx and
# needs no compilation — it resolves @nextdoo/* packages from source.
RUN pnpm turbo run build --filter=@nextdoo/web --concurrency=1

# ---------------------------------------------------------------- runner
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV TURBO_TELEMETRY_DISABLED=1

# Enable pnpm so the worker's start script (`pnpm --filter @nextdoo/worker start`) works.
RUN corepack enable

# Runtime directories (exports, logs) — declared as volumes in compose.
RUN mkdir -p /app/var/exports /app/var/logs

# --- Web: Next.js standalone output (self-contained, minimal node_modules) ---
# With transpilePackages in a pnpm workspace, standalone preserves the
# project structure: the server entry is at
# apps/web/.next/standalone/apps/web/server.js.
COPY --from=build /app/apps/web/.next/standalone ./apps/web/.next/standalone
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public

# --- Worker: source + workspace packages + shared node_modules ---
# The worker runs via tsx and resolves @nextdoo/* packages through pnpm
# workspace symlinks in node_modules → packages/*.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/worker ./apps/worker
COPY --from=build /app/packages ./packages
COPY --from=build /app/pnpm-workspace.yaml ./
COPY --from=build /app/package.json ./
COPY --from=build /app/apps/web/package.json ./apps/web/
COPY --from=build /app/apps/worker/package.json ./apps/worker/
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/
COPY --from=build /app/packages/core/package.json ./packages/core/
COPY --from=build /app/packages/db/package.json ./packages/db/
COPY --from=build /app/packages/calendar/package.json ./packages/calendar/
COPY --from=build /app/packages/billing/package.json ./packages/billing/

# Default command runs the web server. The worker is a separate compose service.
CMD ["node", "apps/web/.next/standalone/apps/web/server.js"]
