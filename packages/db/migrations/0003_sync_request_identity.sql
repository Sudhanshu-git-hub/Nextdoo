-- Legacy records cannot prove request identity; new records fingerprint the
-- operation, target, base version and payload. Nullable solely for old records.
ALTER TABLE sync_mutations ADD COLUMN request_hash varchar(64);
