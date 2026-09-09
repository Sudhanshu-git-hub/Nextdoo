-- PRD §6.3 lists `location` among the required task fields; MVP stores it as
-- free text, mirroring the title length bound. Existing rows keep NULL.
ALTER TABLE tasks ADD COLUMN location varchar(500);
