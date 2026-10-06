-- Phase 7A: a student's own AI key, the log of live AI calls, and admin events (backups).

-- A participant's own API key for the live calls (Explain simpler, Filipino/Taglish), used only while admin allows it
-- (setting allow_student_keys). Saved only after a test call passed. The key is never returned (key_last4 is shown),
-- never exported, stripped from backups, and goes with the participant (participant:delete).
CREATE TABLE participant_ai_keys (
  participant_id  INTEGER PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  provider        TEXT    NOT NULL,
  model           TEXT    NOT NULL,
  api_key         TEXT    NOT NULL,
  key_last4       TEXT    NOT NULL,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

-- One row per live AI request (a rewrite that was not served from the shared cache), answered or not.
--   source          who answered: student (their own key) | default (admin's provider and model) | gemma (the backup
--                   model on the admin's Google key); NULL when nothing answered
--   provider, model the provider and model that answered (or, when nothing did, the last one tried)
--   fallback_steps  how many steps failed before the answer (0 = the first choice answered)
--   fallback_reasons the failed steps in order, e.g. "student:auth;default:rate_limit"
--   from_cache      1 when the answer was the shared Default version already saved (the student's own key failed)
--   saved_shared    1 when this answer became the shared cached version (Default answers only)
--   error_code      the final error when nothing answered (rate_limit, timeout, network, provider_error, ...)
CREATE TABLE ai_calls (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id    INTEGER REFERENCES participants(id) ON DELETE CASCADE,
  lesson_id         INTEGER REFERENCES lessons(id) ON DELETE SET NULL,
  section_id        INTEGER,
  section_index     INTEGER,
  kind              TEXT    NOT NULL CHECK (kind IN ('simplify', 'translate')),
  outcome           TEXT    NOT NULL CHECK (outcome IN ('ok', 'failed')),
  source            TEXT    CHECK (source IN ('student', 'default', 'gemma')),
  provider          TEXT,
  model             TEXT,
  fallback_steps    INTEGER NOT NULL DEFAULT 0,
  fallback_reasons  TEXT,
  from_cache        INTEGER NOT NULL DEFAULT 0,
  saved_shared      INTEGER NOT NULL DEFAULT 0,
  error_code        TEXT,
  ms                INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL,
  study_date        TEXT    NOT NULL
);
CREATE INDEX idx_ai_calls_participant ON ai_calls(participant_id, created_at);

-- Things the researcher did in admin that are worth a record: type 'backup' (detail = the file name).
CREATE TABLE admin_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT    NOT NULL,
  detail      TEXT,
  created_at  TEXT    NOT NULL
);

-- Students may not use their own key until admin turns this on.
INSERT OR IGNORE INTO settings (key, value) VALUES ('allow_student_keys', 'false');

-- Which provider/model made each shared rewrite ("google/gemini-3.5-flash-lite"); NULL for ones made before 009.
ALTER TABLE sections ADD COLUMN simple_made_by   TEXT;
ALTER TABLE sections ADD COLUMN filipino_made_by TEXT;
