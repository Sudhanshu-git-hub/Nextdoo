-- Returning to a historical input must append a new result, not conflict with
-- an old superseded row. Preserve all history while enforcing one active result.
DROP INDEX tracking_results_unique;
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY task_id, coalesce(occurrence_key, '')
    ORDER BY created_at DESC, id DESC
  ) AS rank
  FROM tracking_results WHERE superseded_at IS NULL
)
UPDATE tracking_results SET superseded_at = now()
FROM ranked WHERE tracking_results.id = ranked.id AND ranked.rank > 1;
CREATE UNIQUE INDEX tracking_results_unique
  ON tracking_results (task_id, coalesce(occurrence_key, ''))
  WHERE superseded_at IS NULL;
