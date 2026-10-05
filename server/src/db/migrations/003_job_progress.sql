-- Per-stage progress for polling ("2 of 5 parts"), and the summary length used by the sections prompt.
ALTER TABLE jobs ADD COLUMN progress_done  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN progress_total INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO settings (key, value) VALUES ('summary_length', 'detailed');
