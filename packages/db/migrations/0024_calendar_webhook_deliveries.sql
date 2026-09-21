-- M8-i6: Calendar webhook ingress replay/dedup ledger.
-- Stores provider notification ids scoped to the calendar connection. The
-- channel token itself is not stored here; connection_id is the scoped row.
CREATE TABLE calendar_webhook_deliveries (
  connection_id uuid NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
  message_id varchar(200) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'PROCESSING',
  imported integer NOT NULL DEFAULT 0,
  first_received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  lease_until timestamptz,
  expires_at timestamptz NOT NULL,
  last_error varchar(300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, message_id),
  CONSTRAINT calendar_webhook_deliveries_status_chk CHECK (status IN ('PROCESSING','SUCCEEDED','FAILED')),
  CONSTRAINT calendar_webhook_deliveries_imported_nonnegative CHECK (imported >= 0)
);

CREATE INDEX calendar_webhook_deliveries_expiry_idx ON calendar_webhook_deliveries (expires_at);
CREATE INDEX calendar_webhook_deliveries_processing_idx ON calendar_webhook_deliveries (status, lease_until);
