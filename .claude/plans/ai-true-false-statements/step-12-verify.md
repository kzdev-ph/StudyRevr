What: run the test suites and a small real-AI run.
For: sonnet-high-applier
Depends on: 1-11
Status: done

# Step 12: Verify

- `cd server && npm test` passes (1121 plus the new tests). `cd client && npm test` passes (235 plus the new tests).
- Regression check on a COPY of the after_chapter_3 database, before any backfill. Run
  `npm run quiz:check -- --db <copy>` with the old code and with the new code. Per lesson, these stay the same:
  - "Clean questions available";
  - the Multiple choice counts;
  - the Yes/No false statement counts.
- Real AI, about 30 requests in total:
  - Run `npm run pipeline -- <lesson> --save=<scratchpad file>` once on an English and once on a Filipino/Taglish lesson
    from server/test-lessons.
  - Each run is about 12-16 requests: the statements call is 1, and the review adds about 0-1.
  - Read every pair the script prints and grade it: reads naturally / the true one is true / the false one is false
    but believable / no negation trick.
  - Targets: at least 60% of eligible concept cards end ok; no ok twin is actually true; no negation trick reaches ok.


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

