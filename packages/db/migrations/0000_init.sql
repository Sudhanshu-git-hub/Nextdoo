-- NEXTDOO initial schema (PRD §13)
-- Hand-authored and reviewable. Expand-only: no destructive statements.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------------ enums
DO $$ BEGIN CREATE TYPE task_status AS ENUM ('ACTIVE','COMPLETED','ARCHIVED','DELETED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE task_priority AS ENUM ('NONE','LOW','MEDIUM','HIGH'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE project_status AS ENUM ('ACTIVE','ARCHIVED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE reminder_status AS ENUM ('SCHEDULED','PROCESSING','SENT','FAILED','CANCELED','EXPIRED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE reminder_channel AS ENUM ('WEB','DESKTOP','EMAIL'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE timer_status AS ENUM ('RUNNING','PAUSED','STOPPED','OVERLAPPED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE tracking_event_type AS ENUM ('TASK_CREATED','TASK_PLANNED','TASK_STARTED','TASK_PAUSED','TASK_COMPLETED','TASK_RESCHEDULED','TASK_SKIPPED','TASK_REOPENED','TASK_ARCHIVED','TIME_LOGGED','ESTIMATE_CHANGED','RECURRENCE_GENERATED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE execution_outcome AS ENUM ('ON_TIME','LATE','EARLY','RESCHEDULED','SKIPPED','INCOMPLETE','UNMEASURED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE subscription_status AS ENUM ('TRIALING','ACTIVE','PAST_DUE','GRACE_PERIOD','CANCELED','EXPIRED','PAUSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE plan AS ENUM ('FREE','PRO','TEAM','ENTERPRISE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE sync_operation AS ENUM ('create','update','delete'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE scan_status AS ENUM ('PENDING','CLEAN','INFECTED','FAILED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE occurrence_status AS ENUM ('PENDING','COMPLETED','SKIPPED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------------ identity
CREATE TABLE IF NOT EXISTS users (
  id                    uuid PRIMARY KEY,
  email                 varchar(254) NOT NULL,
  password_hash         text NOT NULL,
  name                  varchar(120),
  time_zone             varchar(64) NOT NULL DEFAULT 'UTC',
  email_verified_at     timestamptz,
  mfa_secret_encrypted  text,
  mfa_enabled_at        timestamptz,
  status                varchar(20) NOT NULL DEFAULT 'ACTIVE',
  deletion_requested_at timestamptz,
  deleted_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email);

CREATE TABLE IF NOT EXISTS sessions (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL,
  device_label varchar(200),
  ip_hash      varchar(64),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_unique ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id, expires_at);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     varchar(32) NOT NULL,
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_tokens_hash_unique ON auth_tokens (token_hash);
CREATE INDEX IF NOT EXISTS auth_tokens_user_purpose_idx ON auth_tokens (user_id, purpose);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recovery_codes_user_idx ON recovery_codes (user_id);

-- ------------------------------------------------------------------ workspace
CREATE TABLE IF NOT EXISTS workspaces (
  id                   uuid PRIMARY KEY,
  owner_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                 varchar(200) NOT NULL,
  time_zone            varchar(64) NOT NULL DEFAULT 'UTC',
  week_start           integer NOT NULL DEFAULT 1,
  workday_start_minute integer NOT NULL DEFAULT 540,
  workday_end_minute   integer NOT NULL DEFAULT 1020,
  version              integer NOT NULL DEFAULT 1,
  deleted_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspaces_owner_idx ON workspaces (owner_id);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         varchar(20) NOT NULL DEFAULT 'OWNER',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members (user_id);

-- ------------------------------------------------------------------ projects
CREATE TABLE IF NOT EXISTS projects (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         varchar(200) NOT NULL,
  description  text,
  color        varchar(7),
  status       project_status NOT NULL DEFAULT 'ACTIVE',
  position     numeric(20,10) NOT NULL DEFAULT 0,
  version      integer NOT NULL DEFAULT 1,
  archived_at  timestamptz,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_workspace_status_idx ON projects (workspace_id, status);

CREATE TABLE IF NOT EXISTS sections (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         varchar(200) NOT NULL,
  position     numeric(20,10) NOT NULL DEFAULT 0,
  version      integer NOT NULL DEFAULT 1,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sections_project_position_idx ON sections (project_id, position);

CREATE TABLE IF NOT EXISTS tags (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         varchar(60) NOT NULL,
  color        varchar(7),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tags_workspace_name_unique ON tags (workspace_id, name);

-- ------------------------------------------------------------------ tasks
CREATE TABLE IF NOT EXISTS tasks (
  id                  uuid PRIMARY KEY,
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id          uuid REFERENCES projects(id) ON DELETE SET NULL,
  section_id          uuid REFERENCES sections(id) ON DELETE SET NULL,
  parent_task_id      uuid REFERENCES tasks(id) ON DELETE CASCADE,
  title               varchar(500) NOT NULL,
  description         text,
  status              task_status NOT NULL DEFAULT 'ACTIVE',
  priority            task_priority NOT NULL DEFAULT 'NONE',
  due_at              timestamptz,
  time_zone           varchar(64),
  estimate_minutes    integer,
  actual_minutes      integer NOT NULL DEFAULT 0,
  position            numeric(20,10) NOT NULL DEFAULT 0,
  reschedule_count    integer NOT NULL DEFAULT 0,
  recurrence_rule_id  uuid,
  occurrence_key      varchar(120),
  version             integer NOT NULL DEFAULT 1,
  completed_at        timestamptz,
  archived_at         timestamptz,
  deleted_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tasks_no_self_parent  CHECK (parent_task_id IS DISTINCT FROM id),
  CONSTRAINT tasks_estimate_nonneg CHECK (estimate_minutes IS NULL OR estimate_minutes >= 0),
  CONSTRAINT tasks_actual_nonneg   CHECK (actual_minutes >= 0),
  CONSTRAINT tasks_title_len       CHECK (char_length(title) BETWEEN 1 AND 500)
);
CREATE INDEX IF NOT EXISTS tasks_ws_status_due_idx ON tasks (workspace_id, status, due_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks (project_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS tasks_parent_idx ON tasks (parent_task_id);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_occurrence_unique ON tasks (recurrence_rule_id, occurrence_key)
  WHERE recurrence_rule_id IS NOT NULL AND occurrence_key IS NOT NULL;
-- PostgreSQL full-text search (PRD §9.1: FTS before a dedicated engine)
CREATE INDEX IF NOT EXISTS tasks_fts_idx ON tasks
  USING gin (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(description,'')));

CREATE TABLE IF NOT EXISTS task_tags (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id  uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
);
CREATE INDEX IF NOT EXISTS task_tags_tag_idx ON task_tags (tag_id);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id            uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, depends_on_task_id),
  CONSTRAINT task_deps_no_self CHECK (task_id <> depends_on_task_id)
);

-- ------------------------------------------------------------------ recurrence
CREATE TABLE IF NOT EXISTS recurrence_rules (
  id                uuid PRIMARY KEY,
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  template_task_id  uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  rule              jsonb NOT NULL,
  time_zone         varchar(64) NOT NULL,
  series_start      timestamptz NOT NULL,
  last_generated_at timestamptz,
  active            boolean NOT NULL DEFAULT true,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recurrence_rules_ws_active_idx ON recurrence_rules (workspace_id, active);

CREATE TABLE IF NOT EXISTS task_occurrences (
  id                 uuid PRIMARY KEY,
  recurrence_rule_id uuid NOT NULL REFERENCES recurrence_rules(id) ON DELETE CASCADE,
  occurrence_key     varchar(120) NOT NULL,
  task_id            uuid REFERENCES tasks(id) ON DELETE SET NULL,
  due_at             timestamptz NOT NULL,
  status             occurrence_status NOT NULL DEFAULT 'PENDING',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- The idempotency guarantee against duplicate generation on worker retry.
CREATE UNIQUE INDEX IF NOT EXISTS task_occurrences_key_unique ON task_occurrences (recurrence_rule_id, occurrence_key);

-- ------------------------------------------------------------------ reminders & timers
CREATE TABLE IF NOT EXISTS reminders (
  id                 uuid PRIMARY KEY,
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id            uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_at       timestamptz NOT NULL,
  minutes_before_due integer,
  channel            reminder_channel NOT NULL DEFAULT 'WEB',
  status             reminder_status NOT NULL DEFAULT 'SCHEDULED',
  attempts           integer NOT NULL DEFAULT 0,
  sent_at            timestamptz,
  last_error         varchar(200),
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders (status, scheduled_at);
CREATE INDEX IF NOT EXISTS reminders_task_idx ON reminders (task_id);

CREATE TABLE IF NOT EXISTS timer_sessions (
  id                        uuid PRIMARY KEY,
  workspace_id              uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id                   uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id                   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id                 varchar(100) NOT NULL,
  started_at                timestamptz NOT NULL,
  ended_at                  timestamptz,
  accumulated_seconds       integer NOT NULL DEFAULT 0,
  last_resumed_at           timestamptz,
  status                    timer_status NOT NULL DEFAULT 'RUNNING',
  manual_adjustment_seconds integer NOT NULL DEFAULT 0,
  version                   integer NOT NULL DEFAULT 1,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS timer_sessions_task_idx ON timer_sessions (task_id, started_at);
CREATE INDEX IF NOT EXISTS timer_sessions_user_status_idx ON timer_sessions (user_id, status);

-- ------------------------------------------------------------------ tracking (append-only)
CREATE TABLE IF NOT EXISTS tracking_events (
  id               uuid PRIMARY KEY,
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id          uuid NOT NULL,
  occurrence_key   varchar(120),
  type             tracking_event_type NOT NULL,
  actor_id         uuid,
  actor_kind       varchar(16) NOT NULL DEFAULT 'USER',
  occurred_at      timestamptz NOT NULL,
  client_timestamp timestamptz,
  device_id        varchar(100),
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key  varchar(200) NOT NULL,
  schema_version   integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tracking_events_idem_unique ON tracking_events (idempotency_key);
CREATE INDEX IF NOT EXISTS tracking_events_task_time_idx ON tracking_events (task_id, occurred_at);
CREATE INDEX IF NOT EXISTS tracking_events_ws_time_idx ON tracking_events (workspace_id, occurred_at);

-- Append-only enforcement: history must never be rewritten (PRD §7.2).
CREATE OR REPLACE FUNCTION tracking_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'tracking_events is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tracking_events_no_update ON tracking_events;
CREATE TRIGGER tracking_events_no_update
  BEFORE UPDATE OR DELETE ON tracking_events
  FOR EACH ROW EXECUTE FUNCTION tracking_events_immutable();

CREATE TABLE IF NOT EXISTS tracking_results (
  id                   uuid PRIMARY KEY,
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id              uuid NOT NULL,
  occurrence_key       varchar(120),
  score                numeric(5,1),
  outcome              execution_outcome NOT NULL,
  components           jsonb NOT NULL,
  explanation          text NOT NULL,
  measured_weight      numeric(4,2) NOT NULL,
  calculation_version  integer NOT NULL DEFAULT 1,
  input_hash           varchar(64) NOT NULL,
  recalculated         boolean NOT NULL DEFAULT false,
  superseded_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tracking_results_unique
  ON tracking_results (task_id, coalesce(occurrence_key,''), calculation_version, input_hash);
CREATE INDEX IF NOT EXISTS tracking_results_ws_created_idx ON tracking_results (workspace_id, created_at);

CREATE TABLE IF NOT EXISTS tracking_corrections (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id      uuid NOT NULL,
  actor_id     uuid NOT NULL,
  kind         varchar(40) NOT NULL,
  reason       varchar(500),
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tracking_corrections_task_idx ON tracking_corrections (task_id);

-- ------------------------------------------------------------------ sync
CREATE TABLE IF NOT EXISTS sync_changes (
  sequence     bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type  varchar(40) NOT NULL,
  entity_id    uuid NOT NULL,
  operation    sync_operation NOT NULL,
  payload      jsonb NOT NULL,
  version      integer NOT NULL,
  device_id    varchar(100),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sync_changes_ws_seq_idx ON sync_changes (workspace_id, sequence);

CREATE TABLE IF NOT EXISTS sync_tombstones (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type  varchar(40) NOT NULL,
  entity_id    uuid NOT NULL,
  deleted_at   timestamptz NOT NULL DEFAULT now(),
  purge_after  timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_tombstones_entity_unique ON sync_tombstones (entity_type, entity_id);

CREATE TABLE IF NOT EXISTS sync_mutations (
  mutation_id  uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  device_id    varchar(100) NOT NULL,
  entity_type  varchar(40) NOT NULL,
  entity_id    uuid NOT NULL,
  status       varchar(20) NOT NULL,
  result       jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sync_mutations_ws_idx ON sync_mutations (workspace_id, created_at);

CREATE TABLE IF NOT EXISTS conflict_snapshots (
  id             uuid PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type    varchar(40) NOT NULL,
  entity_id      uuid NOT NULL,
  device_id      varchar(100),
  local_payload  jsonb NOT NULL,
  server_payload jsonb NOT NULL,
  resolved_at    timestamptz,
  resolution     varchar(20),
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conflict_snapshots_ws_idx ON conflict_snapshots (workspace_id, created_at);

-- ------------------------------------------------------------------ outbox & audit
CREATE TABLE IF NOT EXISTS outbox (
  id             uuid PRIMARY KEY,
  event_type     varchar(60) NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  workspace_id   uuid,
  actor_id       uuid,
  entity_type    varchar(40) NOT NULL,
  entity_id      uuid NOT NULL,
  correlation_id varchar(80),
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  attempts       integer NOT NULL DEFAULT 0,
  last_error     varchar(300)
);
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox (published_at, occurred_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id           uuid PRIMARY KEY,
  workspace_id uuid,
  actor_id     uuid,
  action       varchar(80) NOT NULL,
  target_type  varchar(40) NOT NULL,
  target_id    uuid,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_hash      varchar(64),
  request_id   varchar(80),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_ws_time_idx ON audit_logs (workspace_id, created_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key             varchar(200) PRIMARY KEY,
  scope           varchar(80) NOT NULL,
  user_id         uuid,
  request_hash    varchar(64) NOT NULL,
  response_status integer,
  response_body   jsonb,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idempotency_expiry_idx ON idempotency_keys (expires_at);

-- ------------------------------------------------------------------ attachments / calendar / billing
CREATE TABLE IF NOT EXISTS attachments (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id      uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  uploader_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_key   varchar(400) NOT NULL,
  file_name    varchar(300) NOT NULL,
  content_type varchar(120) NOT NULL,
  size_bytes   integer NOT NULL,
  scan_status  scan_status NOT NULL DEFAULT 'PENDING',
  uploaded_at  timestamptz,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attachments_size_positive CHECK (size_bytes > 0)
);
CREATE INDEX IF NOT EXISTS attachments_task_idx ON attachments (task_id);
CREATE UNIQUE INDEX IF NOT EXISTS attachments_object_key_unique ON attachments (object_key);

CREATE TABLE IF NOT EXISTS calendar_connections (
  id                      uuid PRIMARY KEY,
  user_id                 uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id            uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider                varchar(20) NOT NULL,
  external_account_id     varchar(200),
  access_token_encrypted  text,
  refresh_token_encrypted text,
  token_expires_at        timestamptz,
  scopes                  text,
  mode                    varchar(20) NOT NULL DEFAULT 'READ_ONLY',
  sync_token              text,
  last_synced_at          timestamptz,
  status                  varchar(20) NOT NULL DEFAULT 'ACTIVE',
  version                 integer NOT NULL DEFAULT 1,
  disconnected_at         timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calendar_connections_user_idx ON calendar_connections (user_id, provider);

CREATE TABLE IF NOT EXISTS calendar_mappings (
  id                  uuid PRIMARY KEY,
  connection_id       uuid NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
  task_id             uuid REFERENCES tasks(id) ON DELETE CASCADE,
  external_id         varchar(300) NOT NULL,
  calendar_id         varchar(300),
  sync_state          varchar(20) NOT NULL DEFAULT 'SYNCED',
  external_updated_at timestamptz,
  local_updated_at    timestamptz,
  conflict_payload    jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- Prevents duplicate events for the same task (PRD §16.6).
CREATE UNIQUE INDEX IF NOT EXISTS calendar_mappings_external_unique ON calendar_mappings (connection_id, external_id);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_mappings_task_unique ON calendar_mappings (connection_id, task_id) WHERE task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS calendar_events (
  id            uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  external_id   varchar(300) NOT NULL,
  calendar_id   varchar(300),
  title         varchar(500),
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  time_zone     varchar(64),
  is_all_day    boolean NOT NULL DEFAULT false,
  busy          boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_events_unique ON calendar_events (connection_id, external_id);
CREATE INDEX IF NOT EXISTS calendar_events_ws_time_idx ON calendar_events (workspace_id, starts_at);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                       uuid PRIMARY KEY,
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_customer_id     varchar(120),
  provider_subscription_id varchar(120),
  plan                     plan NOT NULL DEFAULT 'FREE',
  status                   subscription_status NOT NULL DEFAULT 'ACTIVE',
  current_period_end       timestamptz,
  trial_ends_at            timestamptz,
  cancel_at_period_end     boolean NOT NULL DEFAULT false,
  grace_ends_at            timestamptz,
  version                  integer NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_user_unique ON subscriptions (user_id);
CREATE INDEX IF NOT EXISTS subscriptions_provider_idx ON subscriptions (provider_customer_id);

CREATE TABLE IF NOT EXISTS billing_events (
  provider_event_id varchar(120) PRIMARY KEY,
  type              varchar(80) NOT NULL,
  processed_at      timestamptz NOT NULL DEFAULT now(),
  payload           jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS entitlements (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature     varchar(60) NOT NULL,
  limit_value integer,
  source      varchar(40) NOT NULL DEFAULT 'PLAN',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS entitlements_user_feature_unique ON entitlements (user_id, feature);

CREATE TABLE IF NOT EXISTS notifications (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  type         varchar(60) NOT NULL,
  title        varchar(300) NOT NULL,
  body         text,
  task_id      uuid,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, read_at);

CREATE TABLE IF NOT EXISTS exports (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  format       varchar(10) NOT NULL DEFAULT 'json',
  status       varchar(20) NOT NULL DEFAULT 'PENDING',
  object_key   varchar(400),
  size_bytes   integer,
  expires_at   timestamptz,
  error        varchar(300),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS exports_user_status_idx ON exports (user_id, status);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        varchar(60) NOT NULL,
  value      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS device_registrations (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id    varchar(100) NOT NULL,
  platform     varchar(20) NOT NULL,
  label        varchar(200),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS device_registrations_unique ON device_registrations (user_id, device_id);
