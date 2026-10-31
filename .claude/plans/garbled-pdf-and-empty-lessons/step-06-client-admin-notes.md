## Step 6: Client: admin row notes, owner's note, admin preview
What: show the stored text warning, and a clear notice when a lesson has no cards or only a few, using existing styles only (no red, no new colours).
For: sonnet-high-applier
Depends on: 4, 5
Status: done
Changes:
- `client/src/lib/flashcardsNotice.js`. Read `quiz_length` (default 10). The `making` and `failed` branches stay exactly as they are.
  - **'few'**, when `total > 0 && total < quizLength`:
    - state: `'few'`
    - title: "Only N flashcard(s)." (singular when N is 1)
    - detail: "The mock quiz can ask at most N of 10 questions."; when N is 1, "The mock quiz needs at least 2."
    - action: `null`
  - **'empty'**, when `total === 0`, not failed, and `lesson.text_warning?.code === 'damaged_text'`:
    - state: `'empty'`
    - title: "No flashcards could be made."
    - detail: "No card's quote matched this file's damaged text. Students see "Cards aren't ready yet"." (same typographic quotes as the existing 'missing' detail)
    - action: `'Try again'`, with the same handler as Make cards
  - Anything else falls through to today's `missing` branch, unchanged.
- `client/src/components/LessonRow.jsx`:
  - `LessonStep` class:
    - failed: `lesson__extra--failed`, as today
    - `notice.state === 'empty'`: `lesson__extra lesson__extra--note`
    - otherwise: `lesson__extra`
  - A new line, placed before the step notices and rendered when `(admin || lesson.mine) && lesson.status !== 'failed' && lesson.text_warning`:
    `<div className="lesson__extra lesson__extra--note"><p className="lesson__extra-text">{lesson.text_warning.message}</p></div>`
    Check the class name of the existing note text in LessonRow and reuse it.
- `client/src/screens/AdminLessonScreen.jsx`, after the status Notice (about line 82):
  `{lesson.text_warning && <Notice tone="warn">{lesson.text_warning.message}</Notice>}`
  Use a tone that already exists in `Notice`.
- `docs/admin.md`: the lesson row now shows the text warning and the no-cards / "Only N" cards notices.

Tests:
- `client/test/uploads.test.js`, flashcardsNotice:
  - `{ total: 8, quiz_length: 10 }`: `few`, "at most 8 of 10"
  - total 1: "needs at least 2"
  - total 12: null
  - total 0 with damaged text: `empty`, 'Try again'
  - total 0 without damaged text: still `missing`, 'Make cards'
- `client/test/helpers/lessonRow.mjs` and `lessonRow.test.js`:
  - An admin row with `text_warning` shows the message.
  - The owner's row shows it.
  - A non-owner student row does not, even if the field is present.
  - A row with an `empty` notice uses `lesson__extra--note`, not `--failed`.
Done-check: `npm test` in `client/` passes, and `npm run build` works.
Do NOT touch: `client/src/lib/api.js` (no new calls; `api.test.js` unchanged), `LessonScreen.jsx`, `Processing.jsx`, `lib/warnings.js`, the student Flashcards and Quiz screens, `tokens.css`.

Do NOT touch (whole plan): pipeline/evidence.js and every grounding call (no fuzzy matching); ai/prompts.js; services/claude-exchange.js, scripts/import-lesson.js, scripts/export-lesson.js; the research export and codebook; the events and lesson_events CHECKs; the admin PIN middleware; visibleSql; status transitions in run.js; CLAUDE.md. Do not commit or push.
