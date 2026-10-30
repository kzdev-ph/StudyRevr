What: Every true/false question shows "True or False", then "Question: <one statement>", then [True] [False]. No Yes/No, "Does this match?" or "Is this the answer?" anywhere.
For: sonnet-high-applier
Depends on: none
Status: built, client 212/212 + server 930/930 green, boss read the diff; visual check waits for a running app with a quiz lesson (needs API key)

# Step 4: True/False display (client only, plus docs)

**`client/src/lib/quiz.js`:**
- `questionLead`: tf → `'True or False'` for both kinds (line 24).
- Remove `yesNoAsk` and `yesNo` (lines 30–48).
- Add `lowerFirst(text)`. It lowercases the first letter only when the first word is:
  - a common opener (A, An, The, It, Its, This, That, These, Those, Any, Each, Every, One, Some, To, When, How, What, Which, Who, Where, In, On, For, By, With, From, Ang, Mga, Isang, Ito), or
  - a capitalised -ing word.
  - Names, acronyms and pH are left alone.
- Add `tfStatement(q)`. `endSentence` adds "." when the text doesn't end in `.!?` (a closing quote or bracket is allowed):
  - term: `` `${q.question} means ${lowerFirst(endSentence(q.statement))}` ``
  - concept: `` `${endSentence(q.question)} ${capitalFirst(endSentence(q.statement))}` ``
- `questionText(q)` for tf returns `tfStatement(q)`.

**`client/src/components/QuizQuestion.jsx`:**
- The tf branch (lines 49–60) renders only:
  `<h2 id="quiz-q-text" className="quiz-q__question" tabIndex={-1} ref={headingRef}><span className="quiz-q__for-label">Question:</span> {tfStatement(q)}</h2>`
- The group uses `aria-labelledby="quiz-q-text"`.
- Line 86 becomes `capitalFirst(choice)` for every question type.
- Drop the `ask` variable and the old imports.

**`client/src/components/QuizResults.jsx` (lines 42–45, 96):**
- The right answer is "True"; or `False. ` + (term card: `${m.question} means: `, otherwise `The right answer: `) + `answer_text`.
- The student's answer is shown as stored.

**Other files:**
- `client/src/styles/quiz.css:228`: change the comment to "true / false: two boxes side by side". Remove `.quiz-q__prompt` and `.quiz-q__for` only if a grep shows nothing else uses them; keep `.quiz-q__for-label`.
- `client/test/quiz.test.js:32-64`: replace the Yes/No tests:
  - lead is 'True or False' for both kinds
  - `tfStatement` of term ('Sampling', 'Picking part of a population to study') → 'Sampling means picking part of a population to study.'
  - concept ('Why sample?', 'to save time') → 'Why sample? To save time.'
  - `lowerFirst` keeps 'DNA…', 'pH…', 'Filipino…'
  - `questionText(tf) === tfStatement`
  - the module exports no `yesNo`
- Docs and codebook:
  - `docs/quiz.md:16`: rewrite the true/false sentences.
  - `CLAUDE.md:67`: "True/False display … stored and exported values stay True/False".
  - `server/src/export/codebook.js:136-141`: true/false questions are shown as "True or False" with "Question:" and one statement ("<term> means <definition>" for a term card; the card's question followed by the suggested answer for a concept card); choices, chosen_answer and right_answer stay True or False.

Done-check: `npm test` at the root is green. Manually, a true/false question shows the three lines and the results list says True/False.
Do NOT touch:
- `server/src/quiz/*`: TF_CHOICES in `build.js:33` and the 'Yes/No:' detail in `check.js:60`
- `quiz-review.test.js:114`
- the AI prompts (`prompts.js:338,348`, `prompts-haiku.js:141`; reviewer-facing only, see decision D15)
- `docs/CLAUDE-full.md` and `docs/history.md`
