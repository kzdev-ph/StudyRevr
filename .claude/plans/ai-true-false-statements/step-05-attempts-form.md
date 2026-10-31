What: store `form`, return it, and keep it on resume, retake and results.
For: sonnet-high-applier
Depends on: 1, 4
Status: done

# Step 5: Attempts carry `form`

- `server/src/quiz/attempts.js`:
  - add `form` to `ANSWER_COLUMNS`;
  - add `@form` to the INSERT, passing `form: q.form ?? null`;
  - `publicQuestion` adds `form` ONLY when it is set, which keeps the exact-key asserts at quiz-api.test.js:74 and 256 passing;
  - `questionsOf` and the `attemptResults` missed entries carry `form` the same way.
- Test (a new `it` in `server/test/quiz-api.test.js`, or a new file):
  - seed one ok pair and start quizzes with a fixed random until one has the statement question;
  - check form 'statement' and a full-sentence `statement`;
  - answer it wrong and check `answer_text` is the true sentence;
  - check that a retake and a resume keep `form`.


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

