-- PC3: normalized personal knowledge and structured data; additive to existing modules.
CREATE TABLE knowledge_databases (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 name varchar(200) NOT NULL CHECK(length(btrim(name))>0), description text, icon varchar(8), color varchar(7),
 favorite boolean NOT NULL DEFAULT false, archived boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK(version>0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,workspace_id)
);
CREATE INDEX knowledge_databases_list_idx ON knowledge_databases(workspace_id,archived,updated_at,id);
CREATE TABLE knowledge_properties (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, database_id uuid NOT NULL, name varchar(80) NOT NULL CHECK(length(btrim(name))>0),
 type varchar(24) NOT NULL CHECK(type IN ('TITLE','TEXT','RICH_TEXT','NUMBER','CHECKBOX','SELECT','MULTI_SELECT','DATE','URL','EMAIL','PHONE','FILE','RELATION')),
 position integer NOT NULL DEFAULT 0, hidden boolean NOT NULL DEFAULT false,
 config jsonb NOT NULL DEFAULT '{"options":[],"relationKind":"record","relationDatabaseId":null}' CHECK(jsonb_typeof(config)='object'),
 related_database_id uuid, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,database_id,workspace_id), UNIQUE(id,database_id,workspace_id,type),
 FOREIGN KEY(database_id,workspace_id) REFERENCES knowledge_databases(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(related_database_id,workspace_id) REFERENCES knowledge_databases(id,workspace_id),
 CHECK(type<>'TITLE' OR NOT hidden)
);
CREATE UNIQUE INDEX knowledge_title_unique ON knowledge_properties(database_id) WHERE type='TITLE';
CREATE INDEX knowledge_properties_order_idx ON knowledge_properties(database_id,position,id);
CREATE TABLE knowledge_records (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, database_id uuid NOT NULL,
 title varchar(500) NOT NULL CHECK(length(btrim(title))>0), content text NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 1 CHECK(version>0), deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,workspace_id), UNIQUE(id,database_id,workspace_id),
 FOREIGN KEY(database_id,workspace_id) REFERENCES knowledge_databases(id,workspace_id) ON DELETE CASCADE
);
CREATE INDEX knowledge_records_page_idx ON knowledge_records(workspace_id,database_id,deleted_at,updated_at,id);
CREATE INDEX knowledge_records_title_idx ON knowledge_records(database_id,lower(title),id);
CREATE TABLE knowledge_values (
 record_id uuid NOT NULL, property_id uuid NOT NULL, database_id uuid NOT NULL, workspace_id uuid NOT NULL,
 type varchar(24) NOT NULL, text_value text, number_value double precision, boolean_value boolean, date_value date, options_value text[],
 PRIMARY KEY(record_id,property_id),
 FOREIGN KEY(record_id,database_id,workspace_id) REFERENCES knowledge_records(id,database_id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(property_id,database_id,workspace_id,type) REFERENCES knowledge_properties(id,database_id,workspace_id,type),
 CHECK(num_nonnulls(text_value,number_value,boolean_value,date_value,options_value)=1),
 CHECK(CASE type WHEN 'NUMBER' THEN number_value IS NOT NULL AND number_value BETWEEN -1e12 AND 1e12
 WHEN 'CHECKBOX' THEN boolean_value IS NOT NULL WHEN 'DATE' THEN date_value IS NOT NULL
 WHEN 'MULTI_SELECT' THEN options_value IS NOT NULL
 WHEN 'TEXT' THEN text_value IS NOT NULL WHEN 'RICH_TEXT' THEN text_value IS NOT NULL WHEN 'SELECT' THEN text_value IS NOT NULL
 WHEN 'URL' THEN text_value IS NOT NULL WHEN 'EMAIL' THEN text_value IS NOT NULL WHEN 'PHONE' THEN text_value IS NOT NULL ELSE false END)
);
CREATE INDEX knowledge_values_number_idx ON knowledge_values(property_id,number_value,record_id);
CREATE INDEX knowledge_values_date_idx ON knowledge_values(property_id,date_value,record_id);
CREATE INDEX knowledge_values_text_idx ON knowledge_values(property_id,text_value,record_id) WHERE type='SELECT';
CREATE TABLE knowledge_notes (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 database_id uuid, record_id uuid, title varchar(500) NOT NULL CHECK(length(btrim(title))>0), content text NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 1 CHECK(version>0), deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,workspace_id), CHECK(num_nonnulls(database_id,record_id)<=1),
 FOREIGN KEY(database_id,workspace_id) REFERENCES knowledge_databases(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(record_id,workspace_id) REFERENCES knowledge_records(id,workspace_id) ON DELETE CASCADE
);
CREATE INDEX knowledge_notes_page_idx ON knowledge_notes(workspace_id,updated_at,id);
CREATE INDEX knowledge_notes_record_idx ON knowledge_notes(record_id);
CREATE UNIQUE INDEX tags_id_workspace_unique ON tags(id,workspace_id);
CREATE TABLE knowledge_note_tags (
 note_id uuid NOT NULL, tag_id uuid NOT NULL, workspace_id uuid NOT NULL, PRIMARY KEY(note_id,tag_id),
 FOREIGN KEY(note_id,workspace_id) REFERENCES knowledge_notes(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(tag_id,workspace_id) REFERENCES tags(id,workspace_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX calendar_events_id_workspace_unique ON calendar_events(id,workspace_id);
CREATE TABLE knowledge_relations (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, record_id uuid, note_id uuid, database_id uuid, property_id uuid,
 kind varchar(16) NOT NULL, target_id uuid NOT NULL,
 target_record_id uuid, target_database_id uuid, target_note_id uuid, task_id uuid, goal_id uuid, milestone_id uuid, tracker_id uuid, calendar_event_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(num_nonnulls(record_id,note_id)=1), CHECK(record_id IS NOT NULL OR (database_id IS NULL AND property_id IS NULL)),
 CHECK(record_id IS NULL OR database_id IS NOT NULL),
 CHECK(num_nonnulls(target_record_id,target_database_id,target_note_id,task_id,goal_id,milestone_id,tracker_id,calendar_event_id)=1),
 CHECK(target_id=coalesce(target_record_id,target_database_id,target_note_id,task_id,goal_id,milestone_id,tracker_id,calendar_event_id)),
 CHECK(CASE kind WHEN 'record' THEN target_record_id IS NOT NULL WHEN 'database' THEN target_database_id IS NOT NULL
 WHEN 'note' THEN target_note_id IS NOT NULL WHEN 'task' THEN task_id IS NOT NULL WHEN 'goal' THEN goal_id IS NOT NULL
 WHEN 'milestone' THEN milestone_id IS NOT NULL WHEN 'tracker' THEN tracker_id IS NOT NULL WHEN 'calendar' THEN calendar_event_id IS NOT NULL ELSE false END),
 UNIQUE NULLS NOT DISTINCT(record_id,note_id,property_id,kind,target_id),
 FOREIGN KEY(record_id,database_id,workspace_id) REFERENCES knowledge_records(id,database_id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(note_id,workspace_id) REFERENCES knowledge_notes(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(property_id,database_id,workspace_id) REFERENCES knowledge_properties(id,database_id,workspace_id),
 FOREIGN KEY(target_record_id,workspace_id) REFERENCES knowledge_records(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(target_database_id,workspace_id) REFERENCES knowledge_databases(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(target_note_id,workspace_id) REFERENCES knowledge_notes(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(task_id,workspace_id) REFERENCES tasks(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(goal_id,workspace_id) REFERENCES goals(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(milestone_id,workspace_id) REFERENCES milestones(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(tracker_id,workspace_id) REFERENCES personal_trackers(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(calendar_event_id,workspace_id) REFERENCES calendar_events(id,workspace_id) ON DELETE CASCADE
);
CREATE INDEX knowledge_relations_target_idx ON knowledge_relations(workspace_id,kind,target_id,id);
CREATE INDEX knowledge_relations_source_record_idx ON knowledge_relations(record_id);
CREATE INDEX knowledge_relations_source_note_idx ON knowledge_relations(note_id);
-- Reuse the existing store, quota, signed URLs, scan queue and download gate.
ALTER TABLE attachments ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE attachments ADD COLUMN record_id uuid, ADD COLUMN note_id uuid, ADD COLUMN goal_id uuid;
ALTER TABLE attachments ADD CONSTRAINT attachments_single_owner CHECK(num_nonnulls(task_id,record_id,note_id,goal_id)=1);
ALTER TABLE attachments ADD FOREIGN KEY(record_id,workspace_id) REFERENCES knowledge_records(id,workspace_id) ON DELETE CASCADE;
ALTER TABLE attachments ADD FOREIGN KEY(note_id,workspace_id) REFERENCES knowledge_notes(id,workspace_id) ON DELETE CASCADE;
ALTER TABLE attachments ADD FOREIGN KEY(goal_id,workspace_id) REFERENCES goals(id,workspace_id) ON DELETE CASCADE;
CREATE UNIQUE INDEX attachments_id_workspace_unique ON attachments(id,workspace_id);
CREATE INDEX attachments_record_idx ON attachments(record_id);
CREATE INDEX attachments_note_idx ON attachments(note_id);
CREATE TABLE knowledge_files (
 record_id uuid NOT NULL, property_id uuid NOT NULL, database_id uuid NOT NULL, workspace_id uuid NOT NULL, attachment_id uuid NOT NULL,
 PRIMARY KEY(record_id,property_id,attachment_id),
 FOREIGN KEY(record_id,database_id,workspace_id) REFERENCES knowledge_records(id,database_id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(property_id,database_id,workspace_id) REFERENCES knowledge_properties(id,database_id,workspace_id),
 FOREIGN KEY(attachment_id,workspace_id) REFERENCES attachments(id,workspace_id) ON DELETE CASCADE
);
