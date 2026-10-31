## Step 8 (optional): Say in the logs why cards went missing
What: when fewer than `QUIZ_LENGTH` cards are saved, the flashcards stage logs one line summing up the drop reasons, and `run-pipeline` prints an "Only N flashcards" line.
For: sonnet-high-applier
Depends on: none
Status: todo
Changes:
- `run.js` flashcards stage:
  - Tally the `onDrop` reasons in a Map.
  - After the "saved N" log, if `cards.length < QUIZ_LENGTH`, log a warning: `[pipeline] lesson <id>: only N flashcards kept; dropped: <reason> xCount, ...`.
  - Log only.
- `run-pipeline.js`: after the summary, print the same line when there are fewer than 10 flashcards.
Tests: in `pipeline.test.js`, a fake AI whose quotes are not in the text gives a warning log containing "evidence not found in the lesson text x", and the lesson status is still `ready`.
Do NOT touch: any `UPDATE lessons SET status` line in `run.js`, the stage order, `jobs.js`.

Do NOT touch (whole plan): pipeline/evidence.js and every grounding call (no fuzzy matching); ai/prompts.js; services/claude-exchange.js, scripts/import-lesson.js, scripts/export-lesson.js; the research export and codebook; the events and lesson_events CHECKs; the admin PIN middleware; visibleSql; status transitions in run.js; CLAUDE.md. Do not commit or push.
