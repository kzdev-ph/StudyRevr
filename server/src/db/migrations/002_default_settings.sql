-- Settings are key/value TEXT. INSERT OR IGNORE keeps any value the user has already changed.
INSERT OR IGNORE INTO settings (key, value) VALUES ('include_speaker_notes', 'true');
