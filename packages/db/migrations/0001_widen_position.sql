-- 0001_widen_position
--
-- `position` is assigned from epoch milliseconds so that newly created rows sort
-- last without needing to read the current maximum. That value has 13 integer
-- digits, but numeric(20,10) permits only 10, so every insert raised
-- "numeric field overflow". Widen the integer part to 20 digits, which leaves
-- room for epoch-microsecond precision if ordering ever needs to be finer.

ALTER TABLE tasks    ALTER COLUMN position TYPE numeric(30,10);
ALTER TABLE projects ALTER COLUMN position TYPE numeric(30,10);
ALTER TABLE sections ALTER COLUMN position TYPE numeric(30,10);
