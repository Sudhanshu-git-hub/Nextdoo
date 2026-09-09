-- Additive delivery state. Legacy notifications have no invented reminder link.
ALTER TABLE reminders ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE reminders ADD COLUMN superseded_by_id uuid;
ALTER TABLE notifications ALTER COLUMN title TYPE varchar(500);
ALTER TABLE notifications ADD COLUMN reminder_id uuid REFERENCES reminders(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX notifications_reminder_unique ON notifications(reminder_id);
CREATE INDEX notifications_history_idx ON notifications(user_id, workspace_id, created_at, id);
CREATE INDEX reminders_history_idx ON reminders(user_id, workspace_id, created_at, id);
