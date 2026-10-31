## Step 5: Admin list says how many cards a full quiz needs
What: `GET /api/lessons?counts=1` rows gain `flashcards.quiz_length` (= `QUIZ_LENGTH`, `server/src/quiz/build.js:31`).
For: sonnet-high-applier
Depends on: none
Status: done
Changes:
- `routes/lessons.js` near `:249`: `flashcards: { total, status, error, quiz_length: QUIZ_LENGTH }`, importing `QUIZ_LENGTH`.
- The students' list stays without counts.
- Add one line to `docs/api.md`.
Tests: in `server/test/quiz-leaks-admin.test.js`, which already reads a `?counts=1` row:
- `row.flashcards.quiz_length === 10`
- the students' list rows have no `flashcards` key
Done-check: `npm test` passes.
Do NOT touch: `run.js` status logic, the flashcards route, `quiz/build.js`.

Do NOT touch (whole plan): pipeline/evidence.js and every grounding call (no fuzzy matching); ai/prompts.js; services/claude-exchange.js, scripts/import-lesson.js, scripts/export-lesson.js; the research export and codebook; the events and lesson_events CHECKs; the admin PIN middleware; visibleSql; status transitions in run.js; CLAUDE.md. Do not commit or push.
