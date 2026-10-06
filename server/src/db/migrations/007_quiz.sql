-- Phase 5: mock quiz. Questions are built from the lesson's flashcards when a quiz starts (quiz_questions from 001 is
-- not used). Nothing here touches flashcard scheduling.

-- Wrong answers for concept cards, made by the AI once per card and reused by every later quiz.
--   choices  JSON array of 0-3 wrong answers (none equal to the card's answer or to each other). [] means the AI
--            answered but gave nothing usable for this card; the card then falls back to true/false.
CREATE TABLE quiz_distractors (
  flashcard_id  INTEGER PRIMARY KEY REFERENCES flashcards(id) ON DELETE CASCADE,
  choices       TEXT    NOT NULL DEFAULT '[]',
  made_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per quiz taken. score/total come from 001; score is final once finished_at is set.
--   started_at    when the questions were handed out
--   finished_at   when the student saw the results; NULL for an attempt left part-way
--   duration_ms   time from the first question on screen to the results, as measured by the app
--   retake_of     the attempt whose questions this one reused (same questions, new order); NULL for a fresh quiz
ALTER TABLE quiz_attempts ADD COLUMN started_at TEXT;
ALTER TABLE quiz_attempts ADD COLUMN finished_at TEXT;
ALTER TABLE quiz_attempts ADD COLUMN duration_ms INTEGER;
ALTER TABLE quiz_attempts ADD COLUMN retake_of INTEGER REFERENCES quiz_attempts(id) ON DELETE SET NULL;

-- One row per question in an attempt, written when the quiz starts and filled in when it is answered. Each row is a
-- full copy of the question, so it still reads correctly after the card is changed or deleted.
--   position      0-based order the question was shown in
--   type          'mc' (four options) | 'tf' (true / false: choices are ["True", "False"])
--   kind          the card it came from: 'term' | 'concept'
--   question      the question (mc term: the definition; tf term: the term; concept: the card's question)
--   statement     tf only: the answer being judged true or false
--   choices       JSON array of the options, in the order shown
--   answer_index  index of the right option
--   answer_text   the card's real answer (term: the term for mc, its definition for tf), shown after answering
--   evidence      the card's "From the lesson" quote
--   chosen_index / correct / time_ms / answered_at   NULL until answered; correct is 0 or 1
CREATE TABLE quiz_answers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id    INTEGER NOT NULL REFERENCES quiz_attempts(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  flashcard_id  INTEGER REFERENCES flashcards(id) ON DELETE SET NULL,
  type          TEXT    NOT NULL CHECK (type IN ('mc', 'tf')),
  kind          TEXT    NOT NULL CHECK (kind IN ('term', 'concept')),
  question      TEXT    NOT NULL,
  statement     TEXT,
  choices       TEXT    NOT NULL,
  answer_index  INTEGER NOT NULL,
  answer_text   TEXT    NOT NULL,
  evidence      TEXT,
  chosen_index  INTEGER,
  correct       INTEGER,
  time_ms       INTEGER,
  answered_at   TEXT,
  UNIQUE (attempt_id, position)
);
CREATE INDEX idx_quiz_answers_card ON quiz_answers(flashcard_id);
CREATE INDEX idx_quiz_attempts_retake ON quiz_attempts(retake_of);
