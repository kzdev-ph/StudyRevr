What: add the quiz_statements table and quiz_answers.form.
For: sonnet-high-applier
Depends on: none
Status: done

# Step 1: Migration 021 and its tests

- New `server/src/db/migrations/021_quiz_statements.sql`, with a header comment in the style of 013:
  ```sql
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
  ALTER TABLE quiz_answers ADD COLUMN form TEXT; -- NULL or statement (no CHECK, like text_warning)
  ```
- `server/test/migration-020.test.js:27`: change it to `assert.equal(runMigrations(db)[0], '020_text_warning.sql')`, the
  same style as migration-019. This is the only edit to that file.
- New `server/test/migration-021.test.js` (copy 020's helper, using the files below 021). It checks:
  - the table and the column exist;
  - deleting a flashcard cascades to its statements row;
  - `quiz_answers.form` is NULL on old rows.


## Do NOT touch
- `D:\claude\pr2\Research_application_pr2` (frozen study data) and `.env`.
- The quiz_distractors schema, the distractors.js logic and the distractorsPrompt text.
- The leak thresholds (REWORDED, NEAR_DUPLICATE, ANSWER_COVERAGE, LENGTH_RATIO) and how the existing rules behave.
- Any existing line of quizReviewPrompt, and every prompts-haiku anchor.
- STAGES (no new stage), TF_CHOICES, TF_SHARE, QUIZ_LENGTH, normalizeTrailing, maskTerm, capitalFirst and lowerFirst.
- The research export columns and values (unless Q2 says otherwise).
- flashcard_progress, flashcard_reviews and the cards themselves: pairs never edit a card.
- The quiz-start fallback in routes/quiz.js: no statements call there, so students never wait.
- How RESTATE_ONLY is wired in run.js.
- The lesson-access tables and mount().

