-- Durable asynchronous export generation (PRD §7.10, §12.4, §13).
-- The exports table already holds identity/format/status/object_key/expires_at.
-- This adds the bounded-job state: an attempt is persisted before generation so a
-- hard crash consumes the same retry budget as a caught failure, a claim token
-- fences a delayed worker after lease recovery, and READY rows carry a 24-hour
-- download window that an expiry sweep enforces.
ALTER TABLE exports ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE exports ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE exports ADD COLUMN completed_at timestamptz;
ALTER TABLE exports ADD COLUMN claim_token uuid;
ALTER TABLE exports ADD COLUMN lease_expires_at timestamptz;
ALTER TABLE exports ADD CONSTRAINT exports_attempts_check CHECK(attempts BETWEEN 0 AND 3);
ALTER TABLE exports ADD CONSTRAINT exports_lease_pair CHECK((claim_token IS NULL) = (lease_expires_at IS NULL));
CREATE INDEX exports_ready_idx ON exports(user_id, next_attempt_at) WHERE status = 'PENDING' AND claim_token IS NULL AND attempts < 3;
CREATE INDEX exports_claimed_idx ON exports(lease_expires_at) WHERE claim_token IS NOT NULL;
CREATE INDEX exports_expiring_idx ON exports(expires_at) WHERE status = 'READY' AND expires_at IS NOT NULL;
