-- Sequence numbers must not become visible out of commit order. A plain
-- bigserial is allocated before commit and lets clients permanently skip a late
-- transaction. Serialize allocation through commit for EVERY writer (including
-- worker/raw SQL). Dropping the default is essential: defaults run before triggers.
-- This deliberately trades global sync-write throughput for cursor correctness.
-- ALTER TABLE's lock also drains pre-migration writers before enabling the rule.
ALTER TABLE sync_changes ALTER COLUMN sequence DROP DEFAULT;

CREATE FUNCTION assign_commit_ordered_sync_sequence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(1852075375);
  NEW.sequence := nextval('sync_changes_sequence_seq');
  RETURN NEW;
END;
$$;

CREATE TRIGGER sync_changes_commit_order
BEFORE INSERT ON sync_changes
FOR EACH ROW EXECUTE FUNCTION assign_commit_ordered_sync_sequence();
