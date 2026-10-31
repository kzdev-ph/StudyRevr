## Step 4: Store the upload's text warning; send it to admin and the owner
What: migration 020 adds `lessons.text_warning`. The upload stores the code and replies with its message; `shape()` exposes `{ code, message }` to admin and the owning student only.
For: sonnet-high-applier
Depends on: 3
Status: done
Changes:
- `server/src/db/migrations/020_text_warning.sql`:
  - `ALTER TABLE lessons ADD COLUMN text_warning TEXT;`, with no CHECK.
  - A comment in the style of 017 that lists the codes and says NULL means nothing found, an older lesson, or one made by a script or import.
- `server/src/services/lesson-access.js`:
  - Add `export const TEXT_WARNINGS = { scanned_pdf, short_text, damaged_text }`.
  - Move the two existing strings verbatim from `routes/lessons.js:21-24`.
  - The new string (exactly the brief's wording, straight apostrophe like `SCANNED_PDF_WARNING`): `damaged_text: "This file's text looks damaged (missing letters). Try saving it again as .docx or .pptx, or export the PDF from the source."`
  - Add `export const textWarning = (code) => (TEXT_WARNINGS[code] ? { code, message: TEXT_WARNINGS[code] } : null);`
- `server/src/routes/lessons.js`:
  - Replace `lessonWarning` with `textWarningCode(ext, wordCount, pageCount, damaged)`. Order:
    1. the scanned rule as today
    2. `damaged` gives `damaged_text`
    3. under 150 words gives `short_text`
    4. otherwise null
  - The upload passes `damaged = Boolean(extracted.damage?.reason)`.
  - Add the column to `insertLesson`. `createLesson(..., owner = null, textWarning = null)` passes it on.
  - Reply `warning: TEXT_WARNINGS[code] ?? null`, so existing replies stay identical strings.
  - Add `l.text_warning` to `SUMMARY_COLUMNS`.
  - `shape()`:
    - Take `text_warning` out of `rest`.
    - Set `out.text_warning = textWarning(code)` only when `viewer.admin || mine`; otherwise leave the key out.
    - This also covers `GET /:id`, which spreads `l.*`.
- Docs:
  - `docs/data-model.md`: the column and migration 020.
  - `docs/api.md`: the upload `warning` codes, and that rows carry `text_warning` for admin and the owner.
  - `docs/student-uploads.md`: the owner sees the line.

Tests:
- New `server/test/migration-020.test.js`, copying the `db018()` pattern from `migration-019.test.js` as `db019()`: the column exists and old rows are NULL.
- `server/test/lessons.test.js`:
  - Uploading the damaged pdf-lib fixture gives `warning === TEXT_WARNINGS.damaged_text` and a stored `text_warning` of `damaged_text`.
  - The existing scanned and tiny-docx uploads store `scanned_pdf` and `short_text`. Their reply assertions at :186 and :207 still pass unchanged.
  - A clean upload stores NULL.
- `server/test/student-uploads.test.js`:
  - The owner's list row and `GET /:id` carry `text_warning.message`.
  - After Share, another student's row and `GET /:id` have no `text_warning` key.
  - Admin's `?counts=1` row has it.

Done-check: `npm test` passes, including `lesson-access.test.js` (no new routes) and `export.test.js` (lessons.csv columns unchanged).
Do NOT touch: `export/research.js`, `export/codebook.js`, `lesson_events`/`events` (no new types), `visibleSql`/`visibleLesson`, `safeError`, `claude-exchange.js`, `middleware/admin.js`.

Do NOT touch (whole plan): pipeline/evidence.js and every grounding call (no fuzzy matching); ai/prompts.js; services/claude-exchange.js, scripts/import-lesson.js, scripts/export-lesson.js; the research export and codebook; the events and lesson_events CHECKs; the admin PIN middleware; visibleSql; status transitions in run.js; CLAUDE.md. Do not commit or push.
