## Step 7: Source fix: put stray letters back (recommended)
What: `applyStrays(items, placements)` writes each stray into its gap before `pageText` runs, so physics-energy and physics-newton get their letters back.
For: sonnet-high-applier
Depends on: 2 (verify with 3)
Status: done
Changes:
- `pdf-strays.js`: `export function applyStrays(items, placements)` returns a shallow-copied items array:
  - Per host, group placements by `at`. At each `at`, join the stray texts sorted by x.
  - Working from the highest `at` down, replace `chars[at]` (the space) with that text. `chars` holds code points.
  - Set each placed stray's copy to `str: ''`, keeping its `hasEOL`.
  - An item with no placement is never changed.
- `pdf.js:121`: `text.push(pageText(applyStrays(content.items, strays)))`. Keep the count.
- `docs/parsing-and-install.md`: one line.
Tests:
- `pdf-strays.test.js`: the unit fixture gives "Think carefully abut how each force affects an object.".
- Through `extractText`, the pdf-lib fixture:
  - contains "Think carefully about how each force affects an object." and "Mastering Physics"
  - has no line made only of stray letters
- A fixture where every candidate is rejected comes out byte for byte the same.
- Existing extraction tests are unchanged.
Done-check, on the real files (a scratch script, or the text dumped before and after):
- Extracted text is byte-identical for bio-cell, bio-genetics, bio-photosynthesis, chem-periodic-trends, chem-redox, math-calc-exp-log, math-calc-trig, physics-electricity, physics-waves and `test-lessons/subjects/chemistry-moles.pdf`.
- physics-energy and physics-newton are still flagged (strays 201 and 40), with broken share at or under 6%.
- Optional AI check: `npm run pipeline -- test-lessons/subjects/real/physics-energy-mit.pdf --save=...`. Expect cards > 0. This depends on the AI; the prototype proxy went from 4/53 to 20/53 phrases found.
Known limits:
- A letter can land in a neighbouring word ("sithis"), and word spaces can be lost ("deadlineis"). This is display only, since `comparable()` ignores spaces.
- Letters with no host line stay as junk lines; the warning still fires.
Do NOT touch: `evidence.js` (no fuzzy match), `pageText`'s script logic, the reflow and header code.

Do NOT touch (whole plan): pipeline/evidence.js and every grounding call (no fuzzy matching); ai/prompts.js; services/claude-exchange.js, scripts/import-lesson.js, scripts/export-lesson.js; the research export and codebook; the events and lesson_events CHECKs; the admin PIN middleware; visibleSql; status transitions in run.js; CLAUDE.md. Do not commit or push.
