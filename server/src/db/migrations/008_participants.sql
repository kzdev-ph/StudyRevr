-- Phase 6: participants. Lessons, flashcards (the cards themselves), quiz wrong answers and section versions stay
-- shared; everything a student does belongs to one participant code. Data from before this migration becomes P00
-- (the researcher's test data), so nothing is lost. Deleting a participant row deletes all of their data (cascade);
-- that is how withdrawal works (npm run participant:delete).

-- Codes like P01. Only the admin adds them; students can only use a code that exists.
CREATE TABLE participants (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT    NOT NULL UNIQUE,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO participants (code) VALUES ('P00');

-- Each participant's schedule for a card (the scheduling fields used to live on `flashcards`; those columns are no
-- longer read). A card with no row here is new for that participant.
CREATE TABLE flashcard_progress (
  participant_id  INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  flashcard_id    INTEGER NOT NULL REFERENCES flashcards(id) ON DELETE CASCADE,
  state           INTEGER NOT NULL DEFAULT 0,
  step            INTEGER NOT NULL DEFAULT 0,
  ease            REAL    NOT NULL DEFAULT 2.5,
  interval        REAL    NOT NULL DEFAULT 0,
  due_at          TEXT,
  reps            INTEGER NOT NULL DEFAULT 0,
  lapses          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (participant_id, flashcard_id)
);
CREATE INDEX idx_flashcard_progress_due ON flashcard_progress(participant_id, due_at);
INSERT INTO flashcard_progress (participant_id, flashcard_id, state, step, ease, interval, due_at, reps, lapses)
  SELECT (SELECT id FROM participants WHERE code = 'P00'), id, state, step, ease, interval, due_at, reps, lapses
  FROM flashcards WHERE state <> 0 OR reps > 0 OR lapses > 0;

-- The review log and quiz attempts get an owner. SQLite can't add a NOT NULL foreign-key column, so the code always
-- fills it. Deleting a participant deletes their attempts, and with them their quiz_answers.
ALTER TABLE flashcard_reviews ADD COLUMN participant_id INTEGER REFERENCES participants(id) ON DELETE CASCADE;
UPDATE flashcard_reviews SET participant_id = (SELECT id FROM participants WHERE code = 'P00');
CREATE INDEX idx_flashcard_reviews_participant ON flashcard_reviews(participant_id, reviewed_at);

ALTER TABLE quiz_attempts ADD COLUMN participant_id INTEGER REFERENCES participants(id) ON DELETE CASCADE;
UPDATE quiz_attempts SET participant_id = (SELECT id FROM participants WHERE code = 'P00');
CREATE INDEX idx_quiz_attempts_participant ON quiz_attempts(participant_id, lesson_id);

-- Where each participant stopped in a lesson's review.
CREATE TABLE review_progress_new (
  participant_id      INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  lesson_id           INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  last_section        INTEGER NOT NULL DEFAULT 0,
  completed_sections  TEXT    NOT NULL DEFAULT '[]',
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (participant_id, lesson_id)
);
INSERT INTO review_progress_new (participant_id, lesson_id, last_section, completed_sections, updated_at)
  SELECT (SELECT id FROM participants WHERE code = 'P00'), lesson_id, last_section, completed_sections, updated_at FROM review_progress;
DROP TABLE review_progress;
ALTER TABLE review_progress_new RENAME TO review_progress;

-- Study sessions: one row per stretch of active study on a lesson (the 001 table was never written; any rows are
-- kept as P00).
--   lesson_id       NULL for the "All lessons" flashcard deck (or a lesson deleted since)
--   activity        reading (Review tab) | flashcards | quiz
--   last_active_at  the last time the app reported this session (heartbeat)
--   ended_at        NULL while the session is open
--   active_ms       time on screen with the app in front and the student interacting (idle and background excluded)
--   end_reason      left (closed the screen) | idle (5 min without interaction) | background (away > 5 min) |
--                   switched (switched participant)
--   study_date      the study day it started on (the day starts at 04:00 Asia/Manila, like flashcards)
CREATE TABLE study_sessions_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id  INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  lesson_id       INTEGER REFERENCES lessons(id) ON DELETE SET NULL,
  activity        TEXT    NOT NULL CHECK (activity IN ('reading', 'flashcards', 'quiz')),
  started_at      TEXT    NOT NULL,
  last_active_at  TEXT    NOT NULL,
  ended_at        TEXT,
  active_ms       INTEGER NOT NULL DEFAULT 0,
  end_reason      TEXT    CHECK (end_reason IN ('left', 'idle', 'background', 'switched')),
  study_date      TEXT    NOT NULL
);
INSERT INTO study_sessions_new (participant_id, lesson_id, activity, started_at, last_active_at, ended_at, active_ms, end_reason, study_date)
  SELECT (SELECT id FROM participants WHERE code = 'P00'), lesson_id,
    CASE tab WHEN 'review' THEN 'reading' WHEN 'flashcard' THEN 'flashcards' ELSE 'quiz' END,
    started_at, started_at, started_at, duration_sec * 1000, 'left', date(started_at, '+4 hours')
  FROM study_sessions;
DROP TABLE study_sessions;
ALTER TABLE study_sessions_new RENAME TO study_sessions;
CREATE INDEX idx_study_sessions_participant ON study_sessions(participant_id, started_at);
CREATE INDEX idx_study_sessions_lesson ON study_sessions(lesson_id);

-- Self-monitoring events.
--   stats_view             opened the Stats tab
--   quiz_retake            started a retake (attempt_id is the new attempt)
--   review_flashcards_tap  tapped "Review these flashcards" on quiz results (attempt_id is that attempt)
--   section_simplify       opened "Explain simpler" on a section (section_index, 0-based)
--   section_translate      opened "Filipino/Taglish" on a section (section_index, 0-based)
CREATE TABLE events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id  INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  type            TEXT    NOT NULL CHECK (type IN ('stats_view', 'quiz_retake', 'review_flashcards_tap', 'section_simplify', 'section_translate')),
  lesson_id       INTEGER REFERENCES lessons(id) ON DELETE SET NULL,
  attempt_id      INTEGER,
  section_index   INTEGER,
  created_at      TEXT    NOT NULL,
  study_date      TEXT    NOT NULL
);
CREATE INDEX idx_events_participant ON events(participant_id, created_at);
