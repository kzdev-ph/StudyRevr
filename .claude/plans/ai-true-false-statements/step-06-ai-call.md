What: add `statementsPrompt` in prompts.js and `ensureStatements` in a new `server/src/services/quiz-statements.js`.
For: sonnet-high-applier
Depends on: 2, 3
Status: done

# Step 6: The AI call

- `statementsPrompt({ cards, text })`. The system message is LESSON_RULES, then this text:
  ```
  Task: the quiz asks some flashcards as True or False. The student sees ONE sentence alone and answers True or False. For each card, write one true sentence and one false sentence.
  - "true_statement": one plain sentence that states the card's answer as a fact, joining the question's topic and the answer ("What is the purpose of a self-introduction?" + "To share your background" -> "The purpose of a self-introduction is to share your background."). Use only words from the card's question, its answer and its quote, and keep every key word of the answer. Never add a fact, example, cause or describing word the card does not have. Never a question, never "Yes" or "No", never "The answer is ...".
  - "false_statement": the SAME sentence with only the answer's part changed so it is false according to the lesson: put in another idea, item or term FROM THE LESSON that does not answer this question. Every other word stays exactly as in the true sentence.
  - The false sentence must be clearly false to a student who studied the lesson and believable to one who did not. Never make it false by adding "not", "never", "no", "hindi", "wala" or "walang", or by turning the answer into its opposite ("builds confidence" -> "creates anxiety"). Never add "only", "always", "all", "every" or "lahat". Never use something the lesson says is also true here, not even partly, and never another item of the same list if the sentence would still be true with it.
  - Keep the changed part about as long as the part it replaces. Write both sentences in the language of the card's answer.
  (then KEEP_MEANING; "- " + NO_OBJECTIVES; "- " + NO_POSITION + " " + ASK_BY_MEANING; mathRules(text, MATH_TEXT))
  Reply with this JSON shape, one item per card, using the card's number as "n":
  {"items":[{"n":1,"true_statement":"...","false_statement":"..."}]}
  ```
- The user message is a `<cards>` block, then `lessonText(text)`. Each card in the block is:
  - `[n] Question: ...`
  - `    Answer: ...`
  - `    From the lesson: "..."`
  - `    Write in English` (or Filipino).
- `ensureStatements({ db, ai, lessonId, concurrency = 1, batchSize = 25, now, log, onProgress })` returns
  `{ made, rejected, error }`.
  - `lessonWords` comes from raw_text. `otherAnswers` are the lesson's other concept answers.
  - It runs `checkPair` on each card, then `saveStatements`.
  - The JSON schema `quiz_true_false` goes in `responseSchema`.
- `server/test/content-prompts.test.js`: add one `it` checking that the prompt:
  - has the Notes line, KEEP_MEANING, NO_OBJECTIVES, NO_POSITION and ASK_BY_MEANING;
  - forbids "not";
  - gives the JSON shape;
  - is not a kind the Haiku prompt set knows (`promptKind(system)` is 'other'), so Haiku leaves it unchanged.
- New `server/test/quiz-statements-ai.test.js` with a fake AI:
  - 25 cards make 1 call and 26 make 2;
  - pairs are saved by n, and an unknown n is ignored;
  - a missing n is saved as rejected;
  - a reply matching nothing gives an error and saves nothing;
  - a pair the code checks reject is saved with its why;
  - a card changed mid-call is not saved;
  - a second run makes no call.


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

