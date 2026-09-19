-- Tracking survives task deletion for the life of the account (PRD 13.5).
-- At final account purge, FK cascades may remove it; normal edits/deletes remain
-- forbidden. No session flag or blanket trigger disabling is introduced.
CREATE OR REPLACE FUNCTION tracking_events_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1
     AND NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'tracking_events is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

-- Prevent a direct workspace delete from masquerading as an account cascade.
CREATE FUNCTION workspace_account_purge_only() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE id = OLD.owner_id) THEN
    RAISE EXCEPTION 'A live account workspace cannot be permanently deleted';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER workspaces_account_purge_only BEFORE DELETE ON workspaces
FOR EACH ROW EXECUTE FUNCTION workspace_account_purge_only();
