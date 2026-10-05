-- A failed lesson keeps a developer hint next to its plain-language error (for example "set GOOGLE_API_KEY in .env").
-- The UI shows it behind a collapsed "Details" toggle. NULL when there is nothing to add.
ALTER TABLE lessons ADD COLUMN error_hint TEXT;
ALTER TABLE jobs ADD COLUMN error_hint TEXT;
