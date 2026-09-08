CREATE TABLE mail_deliveries (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  kind varchar(40) NOT NULL,
  encrypted_message text NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','SENT','FAILED','EXPIRED')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  expires_at timestamptz NOT NULL,
  sent_at timestamptz,
  last_error varchar(80),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mail_delivery_due ON mail_deliveries(status, next_attempt_at);
