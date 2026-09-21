-- The old schema did not retain pause event time on each session. Backfill the
-- best known durable lower bound; new transitions record their exact event time.
ALTER TABLE timer_sessions ADD COLUMN last_transition_at timestamptz;
UPDATE timer_sessions SET last_transition_at = coalesce(ended_at, last_resumed_at, started_at);
ALTER TABLE timer_sessions ALTER COLUMN last_transition_at SET NOT NULL;
ALTER TABLE timer_sessions ALTER COLUMN last_transition_at SET DEFAULT now();
