-- Configurable personal tracking tables; independent of task execution history.
CREATE TABLE personal_trackers (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 name varchar(200) NOT NULL CHECK (char_length(btrim(name)) > 0), description text,
 start_date date NOT NULL, time_zone varchar(64) NOT NULL,
 goal_id uuid, frequency varchar(16) NOT NULL DEFAULT 'DAILY' CHECK (frequency IN ('DAILY','WEEKLY','CUSTOM')),
 state varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','PAUSED','ARCHIVED')),
 definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
 delivery jsonb NOT NULL CHECK (jsonb_typeof(delivery) = 'object'),
 ingest_after timestamptz NOT NULL DEFAULT now(),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,workspace_id),
 FOREIGN KEY(goal_id,workspace_id) REFERENCES goals(id,workspace_id)
);
CREATE INDEX personal_trackers_workspace_idx ON personal_trackers(workspace_id,id);
CREATE TABLE personal_tracker_links (
 workspace_id uuid NOT NULL, tracker_id uuid NOT NULL, task_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tracker_id,task_id),
 FOREIGN KEY(tracker_id,workspace_id) REFERENCES personal_trackers(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(task_id,workspace_id) REFERENCES tasks(id,workspace_id) ON DELETE CASCADE
);
CREATE INDEX personal_tracker_links_task_idx ON personal_tracker_links(task_id);
CREATE TABLE personal_tracker_entries (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 tracker_id uuid NOT NULL, day date NOT NULL,
 definition jsonb NOT NULL CHECK(jsonb_typeof(definition) = 'object'),
 input_values jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(input_values) = 'object'),
 status_id varchar(40), status_name varchar(80), stars integer CHECK(stars BETWEEN 0 AND 5), rule_id varchar(40),
 missing_fields jsonb NOT NULL DEFAULT '[]', notes text,
 version integer NOT NULL DEFAULT 1 CHECK(version > 0), deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,workspace_id), UNIQUE(tracker_id,day),
 FOREIGN KEY(tracker_id,workspace_id) REFERENCES personal_trackers(id,workspace_id) ON DELETE CASCADE
);
CREATE INDEX personal_tracker_entries_range_idx ON personal_tracker_entries(workspace_id,tracker_id,day,id);
-- Event identity is retained even if task-history retention later removes the source event.
CREATE TABLE personal_tracker_sources (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 tracker_id uuid NOT NULL, entry_id uuid NOT NULL, task_id uuid, source_event_id uuid NOT NULL,
 completed_at timestamptz NOT NULL, duration_minutes numeric(16,6), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tracker_id,source_event_id),
 FOREIGN KEY(tracker_id,workspace_id) REFERENCES personal_trackers(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(entry_id,workspace_id) REFERENCES personal_tracker_entries(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(task_id,workspace_id) REFERENCES tasks(id,workspace_id) ON DELETE SET NULL(task_id)
);
CREATE INDEX personal_tracker_sources_entry_idx ON personal_tracker_sources(entry_id);
CREATE TABLE personal_tracker_reports (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 tracker_id uuid NOT NULL, period varchar(7) NOT NULL,
 channel varchar(16) NOT NULL CHECK(channel IN ('EMAIL','WHATSAPP','TELEGRAM')),
 status varchar(24) NOT NULL CHECK(status IN ('BLOCKED','QUEUED','SENT','FAILED','EXPIRED')),
 summary jsonb NOT NULL, reason varchar(80), mail_delivery_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tracker_id,period),
 FOREIGN KEY(tracker_id,workspace_id) REFERENCES personal_trackers(id,workspace_id) ON DELETE CASCADE
);
