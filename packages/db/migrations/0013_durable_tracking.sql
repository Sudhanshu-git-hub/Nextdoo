-- Existing event bodies stay immutable. Legacy ordinals are migration-assigned,
-- not a reconstruction of historical commit order. New ordinals record ingestion.
ALTER TABLE tracking_events ADD COLUMN sequence bigserial NOT NULL;
ALTER SEQUENCE tracking_events_sequence_seq MAXVALUE 9007199254740991;
CREATE UNIQUE INDEX tracking_events_sequence_unique ON tracking_events(sequence);
CREATE INDEX tracking_events_stream_idx ON tracking_events(workspace_id, task_id, sequence);
ALTER TABLE recurrence_rules ADD COLUMN tracking_revision integer NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD CONSTRAINT tasks_id_workspace_unique UNIQUE(id, workspace_id);
CREATE TABLE tracking_jobs (
 task_id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 revision integer NOT NULL DEFAULT 1,
 queued_revision integer NOT NULL DEFAULT 0,
 acknowledged_revision integer NOT NULL DEFAULT 0,
 evaluated_revision integer NOT NULL DEFAULT 0,
 evaluated_cohort_revision integer NOT NULL DEFAULT 0,
 queued_cohort_revision integer NOT NULL DEFAULT 0,
 calculation_version integer NOT NULL DEFAULT 0,
 queued_calculation_version integer NOT NULL DEFAULT 0,
 next_evaluation_at timestamptz,
 evaluated_at timestamptz,
 requested_at timestamptz NOT NULL DEFAULT now(),
 queued_at timestamptz,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 6),
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 last_error varchar(80),
 last_error_at timestamptz,
 FOREIGN KEY(task_id, workspace_id) REFERENCES tasks(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX tracking_jobs_workspace_idx ON tracking_jobs(workspace_id, task_id);
CREATE INDEX tracking_jobs_ready_idx ON tracking_jobs(next_attempt_at, queued_at) WHERE queued_revision > acknowledged_revision AND attempts < 6;
CREATE INDEX tracking_jobs_clock_idx ON tracking_jobs(next_evaluation_at) WHERE next_evaluation_at IS NOT NULL;
CREATE TABLE tracking_outbox_receipts (
 outbox_id uuid PRIMARY KEY REFERENCES outbox(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 received_at timestamptz NOT NULL DEFAULT now()
);
-- Seed metadata only; reconciliation rate-limits calculation and defaults legacy
-- bootstrap/engine upgrades to the last 90 days. No historical result is rewritten.
INSERT INTO tracking_jobs(task_id,workspace_id,requested_at)
 SELECT id,workspace_id,updated_at FROM tasks;
CREATE FUNCTION invalidate_task_tracking() RETURNS trigger AS $$
BEGIN
 INSERT INTO tracking_jobs(task_id,workspace_id) VALUES(NEW.id,NEW.workspace_id)
 ON CONFLICT(task_id) DO UPDATE SET revision=tracking_jobs.revision+1,
 requested_at=clock_timestamp(), attempts=0, last_error=NULL, last_error_at=NULL, next_attempt_at=clock_timestamp();
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER tasks_tracking_invalidation AFTER INSERT OR UPDATE ON tasks
 FOR EACH ROW EXECUTE FUNCTION invalidate_task_tracking();
CREATE FUNCTION invalidate_event_tracking() RETURNS trigger AS $$
BEGIN
 -- Defend against legacy/corrupt cross-workspace references, not just API validation.
 UPDATE tracking_jobs SET revision=revision+1, requested_at=clock_timestamp(), attempts=0,
 last_error=NULL,last_error_at=NULL,next_attempt_at=clock_timestamp()
 WHERE task_id=NEW.task_id AND workspace_id=NEW.workspace_id;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER events_tracking_invalidation AFTER INSERT ON tracking_events
 FOR EACH ROW EXECUTE FUNCTION invalidate_event_tracking();
CREATE FUNCTION invalidate_recurrence_tracking() RETURNS trigger AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN
  UPDATE recurrence_rules SET tracking_revision=tracking_revision+1 WHERE id=OLD.recurrence_rule_id;
 END IF;
 IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.recurrence_rule_id IS DISTINCT FROM OLD.recurrence_rule_id) THEN
  UPDATE recurrence_rules SET tracking_revision=tracking_revision+1 WHERE id=NEW.recurrence_rule_id;
 END IF;
 RETURN NULL;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER occurrences_tracking_invalidation AFTER INSERT OR UPDATE OR DELETE ON task_occurrences
 FOR EACH ROW EXECUTE FUNCTION invalidate_recurrence_tracking();
