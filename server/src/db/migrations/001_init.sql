-- StudyRevr initial schema. JSON columns are stored as TEXT; timestamps are UTC ISO-8601 text.

CREATE TABLE lessons (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  filename    TEXT    NOT NULL,
  raw_text    TEXT    NOT NULL DEFAULT '',
  word_count  INTEGER NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'failed')),
  error       TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id   INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  stage       TEXT    NOT NULL,
  status      TEXT    NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
  error       TEXT,
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_jobs_lesson ON jobs(lesson_id);

CREATE TABLE sections (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id         INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL,
  title             TEXT    NOT NULL,
  content           TEXT    NOT NULL,
  simple_version    TEXT,
  filipino_version  TEXT,
  check_questions   TEXT    NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_sections_lesson ON sections(lesson_id, position);

CREATE TABLE key_points (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id  INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  text       TEXT    NOT NULL
);
CREATE INDEX idx_key_points_lesson ON key_points(lesson_id, position);

CREATE TABLE key_terms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id   INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  term        TEXT    NOT NULL,
  definition  TEXT    NOT NULL
);
CREATE INDEX idx_key_terms_lesson ON key_terms(lesson_id);

CREATE TABLE review_progress (
  lesson_id           INTEGER PRIMARY KEY REFERENCES lessons(id) ON DELETE CASCADE,
  last_section        INTEGER NOT NULL DEFAULT 0,
  completed_sections  TEXT    NOT NULL DEFAULT '[]',
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- state: 0 = new, 1 = learning, 2 = review, 3 = relearning
CREATE TABLE flashcards (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id  INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  front      TEXT    NOT NULL,
  back       TEXT    NOT NULL,
  state      INTEGER NOT NULL DEFAULT 0,
  ease       REAL    NOT NULL DEFAULT 2.5,
  interval   REAL    NOT NULL DEFAULT 0,
  due_at     TEXT,
  reps       INTEGER NOT NULL DEFAULT 0,
  lapses     INTEGER NOT NULL DEFAULT 0,
  step       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_flashcards_lesson ON flashcards(lesson_id);
CREATE INDEX idx_flashcards_due ON flashcards(due_at);

CREATE TABLE flashcard_reviews (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  flashcard_id   INTEGER NOT NULL REFERENCES flashcards(id) ON DELETE CASCADE,
  rating         INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
  reviewed_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  prev_interval  REAL    NOT NULL DEFAULT 0,
  new_interval   REAL    NOT NULL DEFAULT 0
);
CREATE INDEX idx_flashcard_reviews_card ON flashcard_reviews(flashcard_id);
CREATE INDEX idx_flashcard_reviews_time ON flashcard_reviews(reviewed_at);

CREATE TABLE quiz_questions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id     INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  question      TEXT    NOT NULL,
  choices       TEXT    NOT NULL,
  answer_index  INTEGER NOT NULL,
  explanation   TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX idx_quiz_questions_lesson ON quiz_questions(lesson_id);

-- Attempts outlive regenerated question sets, so answers JSON is self-contained.
CREATE TABLE quiz_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id  INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  score      INTEGER NOT NULL,
  total      INTEGER NOT NULL,
  answers    TEXT    NOT NULL DEFAULT '[]',
  taken_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_quiz_attempts_lesson ON quiz_attempts(lesson_id, taken_at);

CREATE TABLE study_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id     INTEGER REFERENCES lessons(id) ON DELETE CASCADE,
  tab           TEXT    NOT NULL CHECK (tab IN ('review', 'flashcard', 'quiz')),
  started_at    TEXT    NOT NULL,
  duration_sec  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_study_sessions_started ON study_sessions(started_at);
CREATE INDEX idx_study_sessions_lesson ON study_sessions(lesson_id);

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
