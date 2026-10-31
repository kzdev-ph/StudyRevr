What: show the sentence alone, word the correction, and add the admin "Make True/False statements" notice.
For: sonnet-high-applier
Depends on: 5, 7
Status: done

# Step 10: Client display and admin notice

- `client/src/lib/quiz.js`:
  - `tfStatement`: for `q.form === 'statement'`, return `capitalFirst(endSentence(q.statement))`.
  - `tfCorrection`: for the statement form when the answer is False, return
    "The true statement: " + `capitalFirst(endSentence(answer))`.
- `client/src/components/QuizQuestion.jsx:103-108`: for the statement form, the prefix is "The true statement: " and
  `answer_text` is shown with capitalFirst.
- `client/src/lib/quizOptions.js`: read `statements = 0`.
  - The "nothing to say" check becomes `!missing && !weak && !statements`.
  - When only statements are missing, the notice is:
    - title: "N quiz cards have no True/False statement yet." (or "1 quiz card has ...");
    - detail: "Until then they are multiple choice where possible.";
    - action: "Make True/False statements".
- Client tests:
  - `client/test/quiz.test.js`: the statement form in `tfStatement`, `questionText` and `tfCorrection`.
  - `client/test/quizOptions.test.js`: the new notice, and the old notices unchanged.


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

