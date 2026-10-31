What: document the feature. The export CSV columns stay unchanged unless the user answers Q2 "yes".
For: sonnet-high-applier
Depends on: 1-10
Status: done

# Step 11: Codebook and docs

- `server/src/export/codebook.js`, quiz_answers: some concept true/false questions show one AI-written sentence alone. For those:
  - `statement` is that sentence as shown;
  - `question` is still the card's question (not shown);
  - `answer_text` is the true sentence;
  - choices stay True/False.
- `docs/quiz.md`:
  - the concept-card bullet;
  - a new "True/False statements" bullet (the call, the checks, the statuses, the review, the fallback, the backfill button);
  - the tables list;
  - the client display bullet.
- `docs/ai-layer.md`: the call budget gains "quiz true/false statements 1 per 25 concept cards (no second try)". A
  small lesson goes from about 8 to about 9 calls.
- `docs/data-model.md`: quiz_statements, quiz_answers.form, migration 021.
- `docs/api.md`: `quiz_options.statements` and the POST guard.
- `docs/claude-import.md`:
  - the new label `the-quiz-true-false-statements`;
  - it is asked after the wrong answers in the same stage, so expect one more round;
  - its promptKind is 'other', so Haiku gets the shared prompt.
- Do not edit CLAUDE.md. The boss decides whether it needs a pointer.


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

