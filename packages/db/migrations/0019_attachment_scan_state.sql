-- Durable asynchronous attachment scanning (PRD §6.8, §14: attachment.scan,
-- on upload, 3 attempts total, quarantine on exhaustion).
-- The attachments table already holds identity/object_key/size/scan_status.
-- This adds the bounded-job state: an attempt is persisted before scanning so a
-- hard crash consumes the same retry budget as a caught failure, a claim token
-- fences a delayed worker after lease recovery, and only completed uploads
-- (uploaded_at not null) are ever scanned.
ALTER TABLE attachments ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE attachments ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE attachments ADD COLUMN completed_at timestamptz;
ALTER TABLE attachments ADD COLUMN claim_token uuid;
ALTER TABLE attachments ADD COLUMN lease_expires_at timestamptz;
ALTER TABLE attachments ADD COLUMN scan_error varchar(300);
ALTER TABLE attachments ADD CONSTRAINT attachments_attempts_check CHECK(attempts BETWEEN 0 AND 3);
ALTER TABLE attachments ADD CONSTRAINT attachments_lease_pair CHECK((claim_token IS NULL) = (lease_expires_at IS NULL));
CREATE INDEX attachments_scan_idx ON attachments(next_attempt_at)
  WHERE scan_status = 'PENDING' AND uploaded_at IS NOT NULL AND claim_token IS NULL AND attempts < 3;
CREATE INDEX attachments_claimed_idx ON attachments(lease_expires_at) WHERE claim_token IS NOT NULL;
