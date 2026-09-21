-- 0020_billing_provider.sql
-- M6-i3: multi-provider billing core (PRD §18).
--
-- The subscriptions table gains a provider discriminator and the
-- provider's plan/price reference, so one internal subscription row can
-- mirror either Stripe or Razorpay. billing_events deduplication becomes
-- per-provider: the same event id in two providers is NOT a duplicate.
-- All statements are idempotent (the runner is replayed; CI migrates twice).

DO $$ BEGIN
  CREATE TYPE billing_provider AS ENUM ('STRIPE', 'RAZORPAY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS provider billing_provider NOT NULL DEFAULT 'STRIPE',
  ADD COLUMN IF NOT EXISTS provider_plan_ref varchar(120),
  ADD COLUMN IF NOT EXISTS pending_plan plan,
  ADD COLUMN IF NOT EXISTS pending_plan_effective_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_event_at timestamptz;

CREATE INDEX IF NOT EXISTS subscriptions_provider_sub_idx
  ON subscriptions (provider, provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;

ALTER TABLE billing_events
  ADD COLUMN IF NOT EXISTS provider billing_provider NOT NULL DEFAULT 'STRIPE',
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS received_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE billing_events DROP CONSTRAINT IF EXISTS billing_events_pkey;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_events_provider_event_pkey') THEN
    ALTER TABLE billing_events
      ADD CONSTRAINT billing_events_provider_event_pkey
      PRIMARY KEY (provider, provider_event_id);
  END IF;
END $$;
