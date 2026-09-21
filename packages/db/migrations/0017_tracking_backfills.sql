-- PRD §7.6 recalculation strategy: "on correction, rule change, or engine
-- version bump, enqueue a bounded backfill (default: last 90 days, chunked by
-- workspace and day, rate-limited)".
-- One row per requested range. The worker advances `cursor_date` by one day
-- per run inside a transaction, so progress is durable and observable, a
-- crash cannot lose a day, and the same day is never processed twice.
CREATE TABLE tracking_backfills (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  from_date date NOT NULL,
  to_date date NOT NULL,
  cursor_date date NOT NULL,
  total_days integer NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED')),
  requested_by uuid NOT NULL,
  reason varchar(500) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_date <= to_date),
  CHECK (cursor_date >= from_date),
  CHECK (total_days > 0)
);
CREATE INDEX tracking_backfills_pending_idx ON tracking_backfills (created_at, id) WHERE status = 'PENDING';
CREATE INDEX tracking_backfills_workspace_idx ON tracking_backfills (workspace_id, created_at DESC);
