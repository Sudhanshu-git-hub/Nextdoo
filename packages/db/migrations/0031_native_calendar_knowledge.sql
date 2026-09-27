-- Extend the existing typed reference store; retain every previous link.
CREATE UNIQUE INDEX calendar_native_events_id_workspace_unique ON calendar_native_events(id,workspace_id);
ALTER TABLE knowledge_relations ADD COLUMN native_event_id uuid;
ALTER TABLE knowledge_relations ADD CONSTRAINT knowledge_relations_native_event_fk
 FOREIGN KEY(native_event_id,workspace_id) REFERENCES calendar_native_events(id,workspace_id) ON DELETE CASCADE;
-- Historical unnamed target checks are identified by their referenced column,
-- rather than relying on PostgreSQL's generated constraint name numbering.
DO $$ DECLARE target_check record; BEGIN
 FOR target_check IN SELECT conname FROM pg_constraint WHERE conrelid='knowledge_relations'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%calendar_event_id%'
 LOOP EXECUTE format('ALTER TABLE knowledge_relations DROP CONSTRAINT %I',target_check.conname); END LOOP;
END $$;
ALTER TABLE knowledge_relations ADD CONSTRAINT knowledge_relations_one_target CHECK(num_nonnulls(target_record_id,target_database_id,target_note_id,task_id,goal_id,milestone_id,tracker_id,calendar_event_id,native_event_id)=1);
ALTER TABLE knowledge_relations ADD CONSTRAINT knowledge_relations_target_identity CHECK(target_id=coalesce(target_record_id,target_database_id,target_note_id,task_id,goal_id,milestone_id,tracker_id,calendar_event_id,native_event_id));
ALTER TABLE knowledge_relations ADD CONSTRAINT knowledge_relations_target_kind CHECK(CASE kind
 WHEN 'record' THEN target_record_id IS NOT NULL WHEN 'database' THEN target_database_id IS NOT NULL WHEN 'note' THEN target_note_id IS NOT NULL
 WHEN 'task' THEN task_id IS NOT NULL WHEN 'goal' THEN goal_id IS NOT NULL WHEN 'milestone' THEN milestone_id IS NOT NULL WHEN 'tracker' THEN tracker_id IS NOT NULL
 WHEN 'calendar' THEN calendar_event_id IS NOT NULL WHEN 'native_event' THEN native_event_id IS NOT NULL ELSE false END);
