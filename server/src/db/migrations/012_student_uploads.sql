-- Phase 7B: students can upload their own lessons (admin switch, off by default).

-- Who a lesson came from and who may see it.
--   origin                'admin' (the teacher's lesson, visible to everyone) | 'student' (an upload)
--   owner_participant_id  the uploader. SET NULL when the participant is withdrawn: a shared lesson stays and loses the
--                         owner; the origin stays 'student', so a private lesson that loses its owner is visible to
--                         nobody (it fails closed) and participant:delete removes private lessons first anyway.
--   shared_at             set once by admin ("Share with everyone", one way); the lesson is then visible to all
--   error_kind            why processing failed: 'content' (the file: no text, scanned) | 'ai' | 'other'. Students see
--                         the message only for 'content'; admin always sees it.
-- Visible to a student: origin = 'admin' OR shared_at IS NOT NULL OR owner_participant_id = them.
ALTER TABLE lessons ADD COLUMN origin TEXT NOT NULL DEFAULT 'admin' CHECK (origin IN ('admin', 'student'));
ALTER TABLE lessons ADD COLUMN owner_participant_id INTEGER REFERENCES participants(id) ON DELETE SET NULL;
ALTER TABLE lessons ADD COLUMN shared_at TEXT;
ALTER TABLE lessons ADD COLUMN error_kind TEXT;
CREATE INDEX idx_lessons_owner ON lessons(owner_participant_id);

-- Upload and share events. Kept apart from events, whose type list is fixed by a CHECK (like setting_events).
--   type    lesson_uploaded | lesson_upload_failed | lesson_deleted_by_student | lesson_shared
--   lesson_id is a plain number (no foreign key) with the title as it was, so the record outlives a deleted lesson
--   actor   student | admin (lesson_shared is done by admin; participant_id is the lesson's owner)
--   detail  lesson_upload_failed: too_large | wrong_type | bad_signature | wrong_content | unreadable | no_text |
--           processing:<stage>
CREATE TABLE lesson_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id  INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  type            TEXT    NOT NULL CHECK (type IN ('lesson_uploaded', 'lesson_upload_failed', 'lesson_deleted_by_student', 'lesson_shared')),
  lesson_id       INTEGER,
  lesson_title    TEXT,
  actor           TEXT    NOT NULL DEFAULT 'student' CHECK (actor IN ('student', 'admin')),
  detail          TEXT,
  created_at      TEXT    NOT NULL,
  study_date      TEXT    NOT NULL
);
CREATE INDEX idx_lesson_events_participant ON lesson_events(participant_id, created_at);

INSERT OR IGNORE INTO settings (key, value) VALUES ('allow_student_uploads', 'false');
INSERT OR IGNORE INTO settings (key, value) VALUES ('student_uploads_per_day', '2');
