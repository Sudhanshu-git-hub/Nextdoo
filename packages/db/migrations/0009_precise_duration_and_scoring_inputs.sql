-- Preserve existing credited whole minutes. Previously discarded fractions cannot
-- be reconstructed safely without reconciling historical manual/overlap events.
ALTER TABLE tasks ADD COLUMN actual_seconds_remainder integer NOT NULL DEFAULT 0
  CHECK (actual_seconds_remainder >= 0 AND actual_seconds_remainder < 60);
-- Legacy scores keep NULL: do not invent their original inputs from current tasks.
ALTER TABLE tracking_results ADD COLUMN input_snapshot jsonb;
