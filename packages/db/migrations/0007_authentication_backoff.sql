CREATE TABLE authentication_attempts (
  key varchar(64) PRIMARY KEY,
  attempts integer NOT NULL,
  blocked_until timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX authentication_attempts_expiry ON authentication_attempts(expires_at);
