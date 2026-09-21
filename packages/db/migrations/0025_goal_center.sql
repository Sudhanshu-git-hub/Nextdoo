-- Goal Center: personal goal hierarchy, milestones and explicit task links.
-- Identifiers are stable human references (G1, G1.M1), while UUIDs remain the
-- authoritative relation keys. Tables are workspace-scoped for tenant safety.

CREATE TYPE goal_status AS ENUM ('ACTIVE', 'COMPLETED', 'ARCHIVED');
CREATE TYPE milestone_status AS ENUM ('ACTIVE', 'COMPLETED', 'ARCHIVED');

CREATE TABLE goals (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_goal_id uuid,
  sequence integer NOT NULL CHECK (sequence > 0),
  identifier varchar(40) NOT NULL,
  title varchar(300) NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  description text,
  category varchar(100),
  priority task_priority NOT NULL DEFAULT 'NONE',
  start_at timestamptz,
  due_at timestamptz,
  status goal_status NOT NULL DEFAULT 'ACTIVE',
  completed_at timestamptz,
  archived_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT goals_no_self_parent CHECK (parent_goal_id IS DISTINCT FROM id),
  CONSTRAINT goals_dates_ordered CHECK (start_at IS NULL OR due_at IS NULL OR start_at <= due_at),
  CONSTRAINT goals_completed_at_state CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL)),
  CONSTRAINT goals_archived_at_state CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL))
);

CREATE UNIQUE INDEX goals_workspace_identifier_unique ON goals (workspace_id, identifier);
CREATE UNIQUE INDEX goals_id_workspace_unique ON goals (id, workspace_id);
CREATE UNIQUE INDEX goals_workspace_sequence_unique ON goals (workspace_id, sequence);
ALTER TABLE goals ADD CONSTRAINT goals_parent_workspace_fkey FOREIGN KEY (parent_goal_id, workspace_id) REFERENCES goals(id, workspace_id) ON DELETE NO ACTION;
CREATE INDEX goals_workspace_status_idx ON goals (workspace_id, status);
CREATE INDEX goals_parent_idx ON goals (parent_goal_id);

CREATE TABLE milestones (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  goal_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  identifier varchar(60) NOT NULL,
  title varchar(300) NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  description text,
  due_at timestamptz,
  status milestone_status NOT NULL DEFAULT 'ACTIVE',
  completed_at timestamptz,
  archived_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT milestones_goal_workspace_fkey FOREIGN KEY (goal_id, workspace_id) REFERENCES goals(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT milestones_completed_at_state CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL)),
  CONSTRAINT milestones_archived_at_state CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL))
);

CREATE UNIQUE INDEX milestones_workspace_identifier_unique ON milestones (workspace_id, identifier);
CREATE UNIQUE INDEX milestones_id_workspace_unique ON milestones (id, workspace_id);
CREATE UNIQUE INDEX milestones_goal_sequence_unique ON milestones (goal_id, sequence);
CREATE INDEX milestones_goal_status_idx ON milestones (goal_id, status);

CREATE TABLE goal_tasks (
  workspace_id uuid NOT NULL,
  goal_id uuid NOT NULL,
  task_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (goal_id, task_id),
  CONSTRAINT goal_tasks_goal_workspace_fkey FOREIGN KEY (goal_id, workspace_id) REFERENCES goals(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT goal_tasks_task_workspace_fkey FOREIGN KEY (task_id, workspace_id) REFERENCES tasks(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX goal_tasks_task_idx ON goal_tasks (task_id);

CREATE TABLE milestone_tasks (
  workspace_id uuid NOT NULL,
  milestone_id uuid NOT NULL,
  task_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (milestone_id, task_id),
  CONSTRAINT milestone_tasks_milestone_workspace_fkey FOREIGN KEY (milestone_id, workspace_id) REFERENCES milestones(id, workspace_id) ON DELETE CASCADE,
  CONSTRAINT milestone_tasks_task_workspace_fkey FOREIGN KEY (task_id, workspace_id) REFERENCES tasks(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX milestone_tasks_task_idx ON milestone_tasks (task_id);
