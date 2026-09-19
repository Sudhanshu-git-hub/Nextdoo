-- Existing unimplemented/legacy rule rows remain unmodified and are not scheduled without a snapshot.
ALTER TABLE recurrence_rules ADD COLUMN template_snapshot jsonb;
ALTER TABLE recurrence_rules ADD COLUMN generation_error varchar(100);
ALTER TABLE recurrence_rules ADD COLUMN failure_count integer NOT NULL DEFAULT 0;
ALTER TABLE recurrence_rules ADD COLUMN next_run_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX recurrence_rules_due_idx ON recurrence_rules(next_run_at, id) WHERE active AND template_snapshot IS NOT NULL;
CREATE UNIQUE INDEX task_occurrences_task_unique ON task_occurrences(task_id) WHERE task_id IS NOT NULL;
