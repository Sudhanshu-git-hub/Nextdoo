-- Keep task/day contribution identity stable after task retention removes its FK.
ALTER TABLE personal_tracker_sources ADD COLUMN task_identity uuid;
UPDATE personal_tracker_sources SET task_identity = coalesce(task_id,source_event_id);
ALTER TABLE personal_tracker_sources ALTER COLUMN task_identity SET NOT NULL;
CREATE UNIQUE INDEX personal_tracker_entries_tracker_workspace_unique ON personal_tracker_entries(id,tracker_id,workspace_id);
ALTER TABLE personal_tracker_sources ADD CONSTRAINT personal_tracker_sources_entry_tracker_fkey
 FOREIGN KEY(entry_id,tracker_id,workspace_id) REFERENCES personal_tracker_entries(id,tracker_id,workspace_id) ON DELETE CASCADE;
