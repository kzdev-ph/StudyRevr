## Step 3: extractText reports damage; `npm run text:check`; run-pipeline prints it
What: wire Steps 1 and 2 into `extractText`, and add a read-only check script for verifying the real files.
For: sonnet-high-applier
Depends on: 1, 2
Status: done
Changes:
- `server/src/services/extract.js`:
  - Keep `strays` from `extractPdf` (0 for docx/pptx).
  - After the final `text`:
    `const stats = textDamage(text); const damage = { ...stats, strays, reason: damageReason(stats, { strays, wordCount }) };`
  - Return `{ text, wordCount, pageCount, source, damage }`. The other fields are unchanged.
- `text-damage.js`: add `describeDamage(d)`. It returns `damaged (<reason>)` or `looks fine`, followed by `; stray letters N; broken words X.X% (b of w); unreadable characters N`.
- New `server/scripts/text-check.js`:
  - Arguments are files or folders; a folder means every .docx, .pptx and .pdf directly inside it.
  - Paths are resolved from `process.env.INIT_CWD ?? process.cwd()`, as in `quiz-check.js` and `restore.js`.
  - Per file: `assertSignature`, then `extractText`, then print one line: `name  <wordCount> words  <describeDamage>`.
  - On an error, print the message and continue.
  - No DB, no AI, no key.
- `server/package.json`: add `"text:check": "node scripts/text-check.js"`.
- Root `package.json`: add `"text:check": "npm run text:check -w server --"`.
- `server/scripts/run-pipeline.js:81-87`: destructure `damage` and print `Text check: ${describeDamage(damage)}` after the "Extracted ..." line.
- `docs/parsing-and-install.md`: add a short "Text check" bullet covering the signals, the thresholds and the script.

Tests, in `server/test/extraction.test.js`:
- The Step 2 damaged pdf-lib fixture: `damage.reason === 'stray_letters'`, `strays >= 5`.
- A docx made from the Step 1 garbled paragraph: `broken_words`, `strays === 0`.
- An existing clean pptx/pdf fixture: `reason === null`.

Done-check:
- `npm test` passes.
- `npm run text:check -- test-lessons/subjects/real` prints:
  - damaged for physics-energy (stray 201) and physics-newton (stray 40)
  - "looks fine" for the other 12 files, with the numbers from the evidence table
Do NOT touch: `routes/lessons.js` (Step 4), `claude-exchange.js`, the import/export scripts.

Do NOT touch (whole plan): pipeline/evidence.js and every grounding call (no fuzzy matching); ai/prompts.js; services/claude-exchange.js, scripts/import-lesson.js, scripts/export-lesson.js; the research export and codebook; the events and lesson_events CHECKs; the admin PIN middleware; visibleSql; status transitions in run.js; CLAUDE.md. Do not commit or push.
