-- A key term keeps the short verbatim quote from the lesson that defines it (checked against the lesson text before
-- saving). The Review screen can show it as "from your lesson". NULL on terms saved before this migration.
ALTER TABLE key_terms ADD COLUMN evidence TEXT;
