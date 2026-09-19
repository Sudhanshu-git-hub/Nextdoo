-- calendar_oauth_states
-- One row per in-flight Google OAuth authorization (PRD §16.1/§16.2: the
-- sync mode is chosen before authorization; PKCE verifier stored so the
-- callback can finish the exchange). Single-use, short-lived.
CREATE TABLE calendar_oauth_states (
  state_hash varchar(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mode varchar(20) NOT NULL,
  code_verifier varchar(128) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calendar_oauth_states_expiry ON calendar_oauth_states(expires_at);

-- Why a connection was paused (token expired / revoked / sync failures),
-- surfaced as the reconnect prompt (PRD §16.6). NULL while healthy.
ALTER TABLE calendar_connections ADD COLUMN pause_reason varchar(40);

-- Expiry of the Google push-notification channel; renewed proactively
-- before it lapses (PRD §16.1 webhooks). NULL = no channel subscribed.
ALTER TABLE calendar_connections ADD COLUMN channel_expires_at timestamptz;

-- Provider revision for optimistic updates (If-Match) when re-exporting a
-- mapped event (PRD §16.6 AC-4 idempotency without lost updates).
ALTER TABLE calendar_events ADD COLUMN etag text;

-- Consecutive generic sync failures (transport errors that are neither
-- auth nor rate-limit). At CALENDAR_SYNC_PAUSE_AFTER the connection is
-- paused and the user notified (PRD §12.4). Auth failures pause
-- immediately (§16.6); rate limits are skipped, not counted.
ALTER TABLE calendar_connections ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0;
