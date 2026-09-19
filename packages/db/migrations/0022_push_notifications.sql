-- M8-i1: browser push notification channel (PRD §6.6, §9.3, §13.2).
--
-- reminder_channel gains PUSH. The value is only used by later DML (never in
-- this migration), so adding it inside the migration transaction is safe on
-- PostgreSQL 12+; the DO block keeps re-runs idempotent.
DO $$
BEGIN
  ALTER TYPE reminder_channel ADD VALUE 'PUSH';
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

-- One row per browser push subscription (Web Push). A user may have several
-- (multiple devices/browsers); re-registering the same endpoint is a no-op
-- (unique per user). Only the fields Web Push delivery requires are stored —
-- no user-agent payloads or other client data.
CREATE TABLE push_subscriptions (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint     varchar(2048) NOT NULL,
  p256dh       varchar(255) NOT NULL,
  auth         varchar(255) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_subscriptions_user_endpoint_key UNIQUE (user_id, endpoint)
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

-- Durable, lease-based at-least-once push delivery queue. One row per
-- (reminder, subscription): the no-double-delivery key for the push channel.
-- Mirrors mail_deliveries: bounded retries (5), exponential backoff, 10-minute
-- leases, 24-hour payload expiry with content scrubbing.
CREATE TABLE push_deliveries (
  id             uuid PRIMARY KEY,
  reminder_id    uuid NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id   uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id        uuid,
  payload        text NOT NULL,
  status         varchar(12) NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING','PROCESSING','SENT','FAILED','EXPIRED')),
  attempts       integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token    uuid,
  lease_until    timestamptz,
  sent_at        timestamptz,
  last_error     varchar(100),
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_deliveries_reminder_subscription_key
    UNIQUE (reminder_id, subscription_id)
);
CREATE INDEX push_deliveries_claim_idx ON push_deliveries (status, next_attempt_at, id);
CREATE INDEX push_deliveries_user_idx ON push_deliveries (user_id);
