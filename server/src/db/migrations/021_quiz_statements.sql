-- The true and false Yes/No statements the AI writes for each card (feat/accounts). One row per flashcard, shared like
-- the cards (not per participant), never exported.
--   card_hash    the card's front and back when the statements were written: a card written again (Regenerate) no
--                longer matches, so its old row is ignored
--   true_text    the statement that is true to the lesson; NULL until it is made or when none was kept
--   false_text   the statement that is false to the lesson; NULL until it is made or when none was kept
--   status       pending (being made) | ok (kept) | flagged (a check did not pass) | rejected (left out)
--   why          the reason for flagged or rejected, for admin
--   reviewed_at  when the statements were last checked; NULL if never
CREATE TABLE quiz_statements (
  flashcard_id INTEGER PRIMARY KEY REFERENCES flashcards(id) ON DELETE CASCADE,
  card_hash    TEXT NOT NULL,
  true_text    TEXT,
  false_text   TEXT,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'ok', 'flagged', 'rejected')),
  why          TEXT,
  made_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reviewed_at  TEXT
);

-- Which form of the statement a Yes/No question showed: NULL (an answer from before this column, or a multiple-choice
-- one) or 'statement'. No CHECK, like text_warning.
ALTER TABLE quiz_answers ADD COLUMN form TEXT; -- NULL or statement
