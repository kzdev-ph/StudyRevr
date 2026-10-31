What: report the pairs; the "never asked" list uses `yesNo`.
For: sonnet-high-applier
Depends on: 3, 4
Status: done

# Step 9: quiz:check and run-pipeline report

- `server/src/quiz/check.js`:
  - the `never` list uses `!p.yesNo.length` instead of `!p.falseClean.length`;
  - add `quiz.statements = { cards, ok, pending, flagged, rejected: [{ card_id, question, true_text, false_text, why }] }`
    from loadStatements, or null without the table;
  - `formatReport` adds the line "  True/False statements: N cards, X ready, P waiting for the review, F flagged, R rejected  [rules]",
    plus up to `examples` rejected or flagged ones, and a note: "concept cards with 3 clean wrong answers and no ready
    statement are multiple choice only";
  - keep every existing line unchanged (the regexes in quiz-check.test.js depend on them).
- `server/scripts/run-pipeline.js`: after the report, print every pair (status, true, false, why). At line 204, add the
  statement texts to the LaTeX leftover scan.
- Test: a new `it` in `server/test/quiz-check.test.js` seeds statement rows and checks the new line. A run on an older
  db prints no statements line.


## Design reference (from the plan)
## (1) Where the statement is built today
**`server/src/quiz/build.js` `quizCandidates`, concept branch (lines 187-221):**
- `falsePool` is the card's saved wrong answers. With none saved, it is other concept answers of the same shape
  (`sameShape`) that share a word with the question.
- `falseCode` is what passes rule e (`falseStatementProblems`) and the "another card's answer" check.
- `falseClean` is `falseCode` minus what the reviewer flagged.
- A flagged true statement (`trueFlagged`) means no Yes/No at all.

**`buildQuiz` (lines 289-296):**
- Usable cards (3 clean MC options, or a non-empty falseClean) are shuffled.
- A card that can't be MC is "forced" T/F.
- Variety is `round(n * 0.3)` T/F, taken from MC-able cards that also have a falseClean.
- `trueFalse` (lines 260-276) draws `truth = random() < 0.5`. The statement is `card.back`, or `pickOne(falseClean)` when false.
- The stored row is `question = card.front`, `statement = <answer or wrong answer>`, `answer_text = card.back`.

**The client glues them:** `tfStatement` returns `"${question} ${statement}."`. That is the stiff form.

## (2)-(6) Design
**New AI call:** `statementsPrompt` (prompts.js) plus `ensureStatements` (new `server/src/services/quiz-statements.js`).
- Label: `the quiz true/false statements`.
- Batches of `BATCH_SIZE = 25` concept cards (about 1 call per lesson), maxTokens 4000, `mapLimit(concurrency)`.
- Cards are numbered `[n]` in `position, id` order. Each card sends Question, Answer, its quote and its language.
- Lesson context comes from `contextForBatch(raw_text, quotes)` in `services/quiz-review.js`.
- zod reply: `{ items: [{ n: int, true_statement: string.catch(''), false_statement: string.catch('') }] }`.
- Pairing is by `n`.
- A reply that matches none of the batch's numbers fails the batch: nothing is saved, and the cards are asked for again later.
- A card left out of a reply that parsed is saved `rejected` ("no statement in the reply"). This mirrors quiz_distractors saving `[]`.
- A pair is saved only if the card's front and back are unchanged at save time (the same guard as `saveResults` in distractors.js).

**Which cards get a pair (`cardsNeedingStatements`):**
- Concept cards, not list items (`siblingItems`).
- Breaking none of rules a, k, l, m, o (quizCandidates `problems`).
- Without a row for the current `cardHash`.
- Term cards and list items keep today's forms.

**Determinism.**
- The AI output is saved; the quiz is still built purely from saved data.
- A statement-form `trueFalse` uses `random()` exactly as often as the old one: one draw for `truth`, plus `pickOne` when false.
- So seeded quizzes stay reproducible, and fixtures without pairs give identical output.

**Code checks** (`server/src/quiz/statements.js`, pure). Both sentences: has text, at most 45 words, no trailing "?".

TRUE sentence T:
- **Grounding, with no similarity score.** Every content word of T must come from the card's question, its answer, or
  its quote (which was checked verbatim against `raw_text` when the card was made).
  - Words are compared with `wordStems` and the strict `exact` matcher of leaks.js: the same stem, or an
    inflected/derived form of the word.
  - Never with `sameWord` substring matching.
- **States the answer.** Every content word of `card.back` is in T.
- No negative word (`isNegative`) unless the card's question or answer has one.
- No absolute word ("always", "only", "all", "every", "lahat", "palagi"...) the card doesn't use.
- Same language as the card's answer.

FALSE twin F, checked with a token diff (`words()` of leaks.js):
- Strip the common prefix and suffix of T and F. What is left is R (removed from T) and A (added in F). F is rejected when:
- R or A is empty (rule e: it only adds or drops words, such as "not" or "only").
- A has no content word that isn't in R (only reordered or re-inflected).
- R shares no content word with `card.back` (the change must replace the answer, never the subject).
- `answerInQuestion(F, card.back)` finds the answer (rule a: the twin still holds the right answer).
- `isNegative(A) && !isNegative(R)`, or A adds an absolute word (rules c and e).
- `falseStatementProblems(A, R, { reworded: true })` finds anything (rule e: language, same value, reworded).
- `wrongOptionProblems(A, R, { lessonWords, otherAnswers })` finds anything (rules c and f: length of A against R,
  near-duplicate, another card's answer, language, off-topic).
- A content word of A is not a word of the lesson. This is checked with `LessonWords.has` on its stems, exactly: the
  "lesson-grounded change".
- All of A's content words already appear in the shared frame (it only repeats the sentence).

Rules that can't fire: b (echo words) and the c opening/shape checks can't fire, since both sentences share one frame.
Rule d applies to term cards only.

**Storage** (migration `021_quiz_statements.sql`) is a NEW table, not new columns on quiz_distractors:
- quiz_distractors is written with `INSERT OR REPLACE`, which would wipe extra columns on every remake.
- `cardsNeedingDistractors` treats "a row exists" as "has wrong answers".

The new table:
- `quiz_statements(flashcard_id PK -> flashcards ON DELETE CASCADE, card_hash, true_text, false_text, status CHECK IN
  ('pending','ok','flagged','rejected'), why, made_at, reviewed_at)`.
- Status meanings:
  - `pending`: passed the code checks;
  - `ok`: reviewed clean;
  - `flagged`: the review flagged it;
  - `rejected`: failed the code checks, or the AI gave none.
- A stale `card_hash` (the card was regenerated) means "no pair": a new one is made on the next quiz_options run.
- Also `ALTER TABLE quiz_answers ADD COLUMN form TEXT`: NULL, or `'statement'` for a question that shows an AI sentence.
  The client needs it to show the sentence alone.

**Review and fallback.**
- `reviewItems` passes the pairs to quizCandidates.
- For a card with a pair (pending, ok or flagged), the reviewer gets `true_statement` = the TRUE sentence and the twin
  as one more option with use `yes_no`.
- `reviewBatch` sets the pair's status when it saves: `flagged` on any card flag, true-statement flag or twin option
  flag; otherwise `ok`.
- A true statement flagged `not_in_lesson` on a pair item does NOT trigger a card rewrite. Card flags still do.
- The builder uses a pair only when all of these hold:
  - status `ok` and the current hash;
  - no card flags;
  - the true statement is not flagged and the twin has no option flags.
- Otherwise:
  - an MC-able card is MC (no stiff T/F for variety);
  - a card that can't be MC keeps today's form, the old falseClean (Q1; keeps the quiz length);
  - a flagged true statement still means no T/F at all, as today.
- A failed statements call is logged and does not fail the stage. The review still runs, those cards have no pair, and
  admin sees a count and a button (Step 10).

**Backfill (least risky): a per-lesson admin button.**
- The admin row gets `quiz_options.statements` (cards still without a pair) and a "Make True/False statements" button.
- The button reuses `POST /api/lessons/:id/quiz-options`, which runs quiz_options and then quiz_review on a ready lesson.
- Cards are never edited by it, and never rewritten once participants have records.
- `lesson:rebuild` also works, but it remakes the cards and is refused for studied lessons.
- Until a backfill, an old lesson's concept cards are MC where possible, and its forced ones stay as they are.

**quiz:check.**
- "Clean questions available: N of 10" counts `canMc || yesNo.length`.
- It is never lower than today, except when the reviewer flags a pair's true statement on a card that can't be MC.
- It goes up when a card had no clean form but has an `ok` pair.
- A new report line shows the statements: made / ok / waiting / flagged / rejected, with examples.


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

