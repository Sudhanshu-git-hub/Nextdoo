-- Persist an attempt before computation, so hard crashes consume the same retry
-- budget as caught failures. A token fences a delayed worker after lease recovery.
ALTER TABLE tracking_jobs ADD COLUMN claim_token uuid;
ALTER TABLE tracking_jobs ADD COLUMN lease_expires_at timestamptz;
ALTER TABLE tracking_jobs ADD CONSTRAINT tracking_jobs_lease_pair CHECK((claim_token IS NULL) = (lease_expires_at IS NULL));
CREATE INDEX tracking_jobs_expired_lease_idx ON tracking_jobs(lease_expires_at) WHERE claim_token IS NOT NULL;
CREATE OR REPLACE FUNCTION invalidate_task_tracking() RETURNS trigger AS $$
BEGIN
 INSERT INTO tracking_jobs(task_id,workspace_id) VALUES(NEW.id,NEW.workspace_id)
 ON CONFLICT(task_id) DO UPDATE SET revision=tracking_jobs.revision+1,
 requested_at=clock_timestamp(), attempts=0, last_error=NULL, last_error_at=NULL, next_attempt_at=clock_timestamp(),claim_token=NULL,lease_expires_at=NULL;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION invalidate_event_tracking() RETURNS trigger AS $$
BEGIN
 UPDATE tracking_jobs SET revision=revision+1, requested_at=clock_timestamp(), attempts=0,
 last_error=NULL,last_error_at=NULL,next_attempt_at=clock_timestamp(),claim_token=NULL,lease_expires_at=NULL
 WHERE task_id=NEW.task_id AND workspace_id=NEW.workspace_id;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
