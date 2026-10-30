-- Study sessions can now end because the account signed out. end_reason gains three values:
--   signed_out            the student signed out
--   signed_out_elsewhere  the account signed in on another device
--   signed_out_by_admin   the admin signed the student out or reset their password
-- SQLite can't change a CHECK, so the table is rebuilt exactly as 008 made it; only the end_reason CHECK differs.
CREATE TABLE study_sessions_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id  INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  lesson_id       INTEGER REFERENCES lessons(id) ON DELETE SET NULL,
  activity        TEXT    NOT NULL CHECK (activity IN ('reading', 'flashcards', 'quiz')),
  started_at      TEXT    NOT NULL,
  last_active_at  TEXT    NOT NULL,
  ended_at        TEXT,
  active_ms       INTEGER NOT NULL DEFAULT 0,
  end_reason      TEXT    CHECK (end_reason IN ('left', 'idle', 'background', 'switched', 'signed_out', 'signed_out_elsewhere', 'signed_out_by_admin')),
  study_date      TEXT    NOT NULL
);
-- Foreign keys are ON while this runs, so a row that points at nothing would abort the copy: a lesson that is gone becomes
-- NULL (what ON DELETE SET NULL would have done), and a row of a participant that is gone is left behind.
INSERT INTO study_sessions_new (id, participant_id, lesson_id, activity, started_at, last_active_at, ended_at, active_ms, end_reason, study_date)
  SELECT id, participant_id, (SELECT id FROM lessons WHERE id = study_sessions.lesson_id), activity, started_at, last_active_at, ended_at, active_ms, end_reason, study_date
  FROM study_sessions
  WHERE participant_id IN (SELECT id FROM participants);
-- AUTOINCREMENT remembers the highest id ever used; carry that over, so the ids of deleted top rows are not handed out again.
DELETE FROM sqlite_sequence WHERE name = 'study_sessions_new';
INSERT INTO sqlite_sequence (name, seq) SELECT 'study_sessions_new', COALESCE(seq, 0) FROM sqlite_sequence WHERE name = 'study_sessions';
DROP TABLE study_sessions;
ALTER TABLE study_sessions_new RENAME TO study_sessions;
CREATE INDEX idx_study_sessions_participant ON study_sessions(participant_id, started_at);
CREATE INDEX idx_study_sessions_lesson ON study_sessions(lesson_id);
