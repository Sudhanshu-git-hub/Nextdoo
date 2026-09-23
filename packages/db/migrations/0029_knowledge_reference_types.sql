-- Enforce reference property types even for callers outside the service layer.
ALTER TABLE knowledge_relations ADD COLUMN property_type varchar(16) GENERATED ALWAYS AS ('RELATION'::varchar) STORED;
ALTER TABLE knowledge_relations ADD CONSTRAINT knowledge_relations_property_type_fk
 FOREIGN KEY(property_id,database_id,workspace_id,property_type) REFERENCES knowledge_properties(id,database_id,workspace_id,type);
ALTER TABLE knowledge_files ADD COLUMN property_type varchar(16) GENERATED ALWAYS AS ('FILE'::varchar) STORED;
ALTER TABLE knowledge_files ADD CONSTRAINT knowledge_files_property_type_fk
 FOREIGN KEY(property_id,database_id,workspace_id,property_type) REFERENCES knowledge_properties(id,database_id,workspace_id,type);
