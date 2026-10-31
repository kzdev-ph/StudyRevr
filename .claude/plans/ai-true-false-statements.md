# Plan: AI-written True/False statements for concept cards ("option B")

Project: StudyRevr, `D:\claude\pr2\Research_application_pr2_after_chapter_3`, branch `feat/accounts`.
NEVER read, touch or run anything in `D:\claude\pr2\Research_application_pr2` (frozen study data). Never edit `.env`.

## Goal
A True/False question built from a CONCEPT card should show one natural sentence the AI wrote ("The purpose of a
self-introduction is to share your background."). It should not show the stiff "<card question> <suggested answer>."
(`tfStatement`, `client/src/lib/quiz.js:55-58`).

In the `quiz_options` stage the AI writes one TRUE sentence and one FALSE twin per concept card. Code checks them, then
the existing exam review checks them. Only a pair that passed both is ever shown; otherwise the card is multiple choice.
Stored and exported choices stay `True` / `False`. Quiz results never touch flashcard scheduling.

## Project rules every step must respect (from the brief)
- Plain JavaScript. zod validates every AI JSON reply. One retry on invalid JSON (`generateJSON` in `ai/client.js` already does it).
- Strict "use only the provided lesson text". Use the shared constants KEEP_MEANING, NO_OBJECTIVES, ASK_BY_MEANING and
  NO_POSITION from `server/src/ai/prompts.js`.
- Every prompt with lesson text explains that a `Notes:` line is the teacher's spoken explanation (LESSON_RULES does this).
- RESTATE_ONLY actually lives in `server/src/pipeline/run.js`, which appends it to the content stages only. The new call
  is a quiz-stage call (like the wrong answers), so it gets `thinkingAi` without RESTATE_ONLY: the false twin can't
  "only restate". The prompt carries its own restate-only rule for the TRUE sentence.
- Separate calls per feature, never one giant call. A failure in quiz_options or the quiz review leaves the lesson `ready`.
- Free tier is 500 requests a day and 15 a minute. The extra cost is about 1 call per lesson (batches of 25 concept
  cards, no second try).
- Leak rules a-f (`server/src/quiz/leaks.js`) apply to the new sentences (see "Code checks").
- No new route, so the lesson-access tables (`server/test/lesson-access.test.js`, `mount()` in `server/src/app.js`) stay unchanged.
- `npm test` in `server/` (1121 now) and `client/` (235 now) must pass. Edits to existing tests stay minimal (listed in Step 7).

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

## Step 1: Migration 021 and its tests
What: add the quiz_statements table and quiz_answers.form.
For: applier
Depends on: none
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

## Step 2: Pure statement checks
What: add `server/src/quiz/statements.js` (no DB, no AI) and one small export in leaks.js.
For: applier
Depends on: none
- `server/src/quiz/leaks.js`: add `export function wordsNotIn(text, source)`. It returns the content words of `text`
  (from `wordStems`) that have no `exact` match in `source`. Nothing else in leaks.js changes.
- `statements.js` exports:
  - `MAX_STATEMENT_WORDS = 45`;
  - `ABSOLUTES` (a Set of English and Filipino absolute words);
  - `splitChange(trueText, falseText)` -> `{ removed, added, frame }` (token arrays plus joined texts);
  - `trueProblems(card, text)` -> `[{ rule, detail }]`;
  - `twinProblems(card, trueText, falseText, { lessonWords, otherAnswers })` -> `[{ rule, detail }]`;
  - `checkPair(card, pair, opts)` -> `{ ok, problems }`.
- Implement exactly the checks in "Code checks" above.
  - Use rule `s` for grounding and "states the answer".
  - Use the existing letters a/c/e/f where a check reuses one.
- New `server/test/quiz-statements.test.js`. A good English pair and a good Filipino pair pass. Each of these is rejected:
  - "not" inserted, or "does not build" in place of "builds";
  - "only" or "always" added;
  - a new content word in T, or T missing an answer word;
  - the subject swapped instead of the answer;
  - the twin still holding the answer;
  - a span off the lesson, or another card's answer as the span;
  - a reworded span ("promote" for "advertise");
  - a language mismatch;
  - a question mark at the end;
  - more than 45 words;
  - a length outside 0.6-1.6x the original and more than 4 words apart.

## Step 3: Store helpers and build options
What: DB helpers for quiz_statements; quizBuildOptions passes `statements`.
For: applier
Depends on: 1
- New `server/src/quiz/statement-store.js`. It imports build.js, review-flags.js and list-items.js. It must NOT
  import options.js (that would be an import cycle).
  - `loadStatements(db, lessonId)` returns `undefined` when the table doesn't exist (an older db read by quiz:check).
    Otherwise it returns a Map from card id to `{ card_hash, true_text, false_text, status, why }`, joined via
    flashcards on the lesson.
  - `cardsNeedingStatements(db, lessonId)` applies the rule in "Which cards get a pair". It returns
    `[{ id, front, back, evidence }]` in position, id order.
  - `saveStatements(db, results, now)` writes with INSERT OR REPLACE, status pending or rejected. A row is saved only
    while the card's front and back still equal what was sent. It returns the count saved.
  - `markStatementReviewed(db, { cardId, cardHash, trueText, falseText, flagged, why, now })` is an UPDATE guarded by
    all four values plus status pending, ok or flagged.
- `server/src/quiz/options.js` `quizBuildOptions`: add `statements: loadStatements(db, lessonId)`.
- New `server/test/quiz-statement-store.test.js`:
  - load works on a db without the table;
  - a list item, a rule a/k card and a card with a current row are not "needing"; a stale hash is;
  - save skips a card that changed;
  - mark touches only the same pair.

## Step 4: Builder uses pairs; MC instead of stiff True/False
What: build.js picks forms via `yesNo`; a statement-form trueFalse adds `form: 'statement'`.
For: applier
Depends on: 3 (row shape only)
- `quizCandidates(cards, { ..., statements })` sets `statementMode = statements instanceof Map`. With `statements`
  undefined (the existing unit tests, older databases), behaviour is exactly today's.
- Concept branch:
  - `row = statementMode && !siblings ? statements.get(card.id) : null`.
  - `pair` is `{ true, false }` when the row's card_hash equals `cardHash(card)` (import from review-flags.js), its
    status is pending, ok or flagged, and both texts have text.
  - `pairClean` = pair, and status ok, and cardOk, and no reviewProblems, and not trueFlagged, and no `optionFlags(review, pair.false)`.
  - `yesNo`:
    - falseClean when not in statement mode, or for a list item;
    - `[pair.false]` when pairClean;
    - `[]` when `mcClean.length >= 3`;
    - otherwise falseClean (today's forced form).
  - Add `pair.false` to `reviewable` when there is a pair. Return `pair` and `tfForm` ('statement' when pairClean, else null).
- Keep `falseClean` and its meaning UNCHANGED: quiz-review tests and check.js read it.
- Every other return gets `yesNo: falseClean, pair: null, tfForm: null` through a final `.map`, so the early term
  returns stay as written.
- `usable = canMc(p) || p.yesNo.length > 0`. buildQuiz's variety pool is `canMc(p) && p.yesNo.length`.
- `trueFalse`:
  - With tfForm 'statement': `statement = truth ? pair.true : pickOne(yesNo, random)`, then
    `normalizeTrailing([statement, pair.true, pair.false])`. Return the usual fields plus `form: 'statement'`, with
    `answer_text` = the true sentence after normalizeTrailing.
  - Otherwise: as today, with `yesNo` in place of `falseClean` (they are equal on that path).
  - Add the `form` key ONLY for the statement form, so existing deepEquals keep passing.
- `leaks.js questionLeaks`: for form 'statement', return `[]`, with a comment that pairs are checked by statements.js
  when they are saved.
- New `server/test/quiz-build-statements.test.js`:
  - legacy output is identical when `statements` is undefined;
  - with a Map, an MC-able concept card without a pair is never T/F, and a forced card keeps the old form;
  - an ok pair is asked with both truths across seeds, and `answer_text` = the true sentence;
  - a pending, flagged, rejected or stale pair is unused, and so is a pair with a flagged twin or a flagged true statement;
  - term and list cards are unchanged;
  - the same seed gives the same quiz;
  - `usableCount` is never lower than legacy on the fixtures.

## Step 5: Attempts carry `form`
What: store `form`, return it, and keep it on resume, retake and results.
For: applier
Depends on: 1, 4
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

## Step 6: The AI call
What: add `statementsPrompt` in prompts.js and `ensureStatements` in a new `server/src/services/quiz-statements.js`.
For: applier
Depends on: 2, 3
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

## Step 7: Pipeline and admin wiring; existing test fakes
What: run statements in the quiz_options stage, add the admin count and guard, delete pairs on card rewrites, and fix the fakes.
For: applier
Depends on: 6
- `server/src/pipeline/run.js` `quiz_options`:
  - `saved()` also requires `cardsNeedingStatements(db, lessonId).length === 0`.
  - `run()` awaits ensureDistractors as today, THEN `ensureStatements({ db, ai: thinkingAi, lessonId, concurrency, log, now: clock })`.
  - A statements error is only `log.warn`. Only the distractors error is thrown, as today.
- `server/src/routes/lessons.js`:
  - `quizOptionCounts` adds `statements: cardsNeedingStatements(db, lessonId).length`.
  - The 409 guard of POST `/:id/quiz-options` passes when distractors OR statements are needed. Keep the message.
- `server/src/services/regenerate-card.js:108` and `services/quiz-review.js:279`: add
  `DELETE FROM quiz_statements WHERE flashcard_id = ?` next to the quiz_distractors delete.
- `server/test/helpers.js`: add `blankStatements(user)`. For every `[n] Question:` line it returns an item with
  empty true_statement and false_statement. Every pair is then rejected, so quiz expectations stay the same.
- Existing fakes, with the minimal edit only:
  - route the label `the quiz true/false statements` to `blankStatements(user)`;
  - add that label right after 'the quiz answer options' in the expected label arrays: pipeline.test.js:90 and 239,
    thinking.test.js:105, flashcards-api.test.js:266;
  - quiz-options-stage.test.js: count `calls` only for labels that start with 'the quiz answer options';
  - claude-import.test.js: the test writer answers the new label;
  - run `npm test` and fix only the failures the new label causes (likely pipeline-parallel, section-sources,
    student-uploads, made-by-mixed). Never loosen an assertion.
- New tests in quiz-options-stage.test.js:
  - the stage makes pairs;
  - a statements error leaves the job done, the lesson ready, and the review still running;
  - POST quiz-options is accepted when only statements are missing, and returns 409 when nothing is missing.

## Step 8: The exam review checks the pairs
What: show pairs to the reviewer, save its verdict on quiz_statements, and never rewrite a card for a pair flag.
For: applier
Depends on: 3, 4
- `server/src/services/quiz-review.js`:
  - `reviewItems` passes `statements: loadStatements(db, lessonId)` to quizCandidates.
  - `itemFor`: `true_statement` is `p.pair.true` when there is a pair (else `p.shown`). Add `sentence: Boolean(p.pair)`;
    it is not part of itemHash. The twin is already in `reviewable` and gets use `yes_no` from the existing ternary.
  - `reviewBatch`, inside the save transaction: for each saved result that has a pair, call `markStatementReviewed`.
    - flagged = card flags, or trueStatement flags, or `flags.options[pair.false]`;
    - why = `describe(...)` of those flags.
  - `reviewQuiz` line 343: when `r.item.sentence` is true, `answerWrong` is `[]`. A pair's true sentence is never a
    reason to rewrite the card.
- `server/src/ai/prompts.js` `quizReviewPrompt`: add ONE line, and only when some item has `sentence`.
  - Put it after the "Each item is one flashcard..." paragraph.
  - Every existing line stays byte-identical (prompts-haiku anchors).
  - The line: For some cards the Yes/No question shows one sentence alone (True or False): then the true statement is
    that sentence, and the "yes_no" option that is a whole sentence is its false version. Flag that false sentence
    "two_correct" if the lesson makes it true as well, "reversed" if it is the true sentence negated or turned into its
    opposite, "giveaway" if nobody would believe it; flag the true statement "not_in_lesson" if it says anything the
    card and the lesson do not.
- `server/test/quiz-review.test.js`, new `it`s:
  - a pair item shows the sentence and the twin as yes_no, and the line appears only then;
  - a clean review sets ok, and buildQuiz can then ask the card as a statement;
  - a flagged twin sets flagged, and the card is MC;
  - a true sentence flagged not_in_lesson causes no 'the flashcards the quiz review flagged' call;
  - adding a pair makes the item stale exactly once.

## Step 9: quiz:check and run-pipeline report
What: report the pairs; the "never asked" list uses `yesNo`.
For: applier
Depends on: 3, 4
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

## Step 10: Client display and admin notice
What: show the sentence alone, word the correction, and add the admin "Make True/False statements" notice.
For: applier
Depends on: 5, 7
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

## Step 11: Codebook and docs
What: document the feature. The export CSV columns stay unchanged unless the user answers Q2 "yes".
For: applier (docs)
Depends on: 1-10
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

## Step 12: Verify
What: run the test suites and a small real-AI run.
For: verifier
Depends on: 1-11
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

## Risks
- **Checks too strict:** many pairs rejected means fewer True/False questions. Measure the reasons in Step 12 and tune the prompt, not the checks.
- **A twin that is actually true** (another item of the same list): only the review's two_correct catches it. Grade for it in Step 12.
- **The reviewer over-flags:** the card falls back to MC. That is safe.
- **Old lessons before a backfill:** concept True/False variety becomes MC, so quizzes have slightly fewer True/False questions.
- **Backfill on studied lessons:** it re-reviews the items whose pair changed. The review is not deterministic, so it
  can flag MC options it passed before. Those are left out or remade, the same as "Review again".
- **Test churn:** expected label arrays change in about 5 test files (Step 7).
- **Claude import:** expect one more round. In-progress export folders get a new waiting prompt, and their review replies go stale.
- **Rewritten cards:** a card rewritten by the review fix round has no pair until the next quiz_options run.
- **Budget:** about +1 call per lesson, plus +0-1 for reviewing pair-only cards. 500 requests a day still cover about 35-40 lessons.

## Open questions for the user
- Q1: A concept card that can't be MC and has no cleared pair. Keep today's "question + suggested answer" True/False
  (default: the quiz length never drops), or leave the card out?
- Q2: Add a `tf_form` column (statement or answer) at the END of quiz_answers.csv, so the analysis can tell the forms
  apart? Default: no. The export stays unchanged and only the DB stores `form`.
- Q3: Is word-level grounding OK? Every content word of the true sentence must be in the card's question, its answer or
  its verbatim quote, as the same word or an inflected/derived form, with no similarity score. The stricter option
  (exact lowercase words only) means more fallbacks.
- Q4: Backfill old lessons with the per-lesson admin button (about 4-6 requests each), or leave them MC-first until they are rebuilt?
- Q5: List-item cards are excluded (the brief says they read fine). Confirm.
- Q6: The correction for a false sentence reads "The true statement: ...". OK?

## (9) A simpler variant
Steps 4, 5 and 10 alone, with an empty statements Map and no AI call, already make every MC-able concept card multiple
choice. That removes the stiff True/False used for variety, at zero AI cost. The stiff form then stays only on forced
cards, and those are common (e.g. 10 of 22 cards were not clean MC in lesson 31). Ship that first if you want a quick win.
The AI pairs (Steps 1-3 and 6-9) then replace the forced and variety forms.

Not recommended: skipping the review integration, or pairing an AI true sentence with an answer-shaped false one (the
shape alone would give the answer away).
