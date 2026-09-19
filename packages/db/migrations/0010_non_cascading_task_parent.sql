-- A task's retention purge must not delete independently live subtasks. Keep the
-- reference until an explicit, versioned detach; deleting an entire account still
-- removes all its tasks in the existing workspace cascade.
ALTER TABLE tasks DROP CONSTRAINT tasks_parent_task_id_fkey;
ALTER TABLE tasks ADD CONSTRAINT tasks_parent_task_id_fkey
  FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE NO ACTION;
