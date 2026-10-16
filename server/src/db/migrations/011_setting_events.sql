-- Settings a participant changed (the Motion choice for now; theme can be added later as setting 'theme'). Kept apart from
-- events, whose type list is fixed. One row per change, with its study day. Goes with the participant (participant:delete).
CREATE TABLE setting_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id  INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  study_date      TEXT    NOT NULL,
  setting         TEXT    NOT NULL,
  value           TEXT    NOT NULL,
  created_at      TEXT    NOT NULL
);
CREATE INDEX idx_setting_events_participant ON setting_events(participant_id, created_at);
