# PLAN: damaged PDF text, and lessons that end with no or few cards

Repo: D:\claude\pr2\Research_application_pr2_after_chapter_3 (branch feat/accounts). Never touch D:\claude\pr2\Research_application_pr2.

# Goal
1. A lesson that ends with no cards, or too few for a full quiz, is never shown to the teacher as if it were fine. Students keep seeing plain lines only.
2. Garbled extracted text ("Th nk carefu y abut") is detected at upload. The teacher gets a plain warning that stays visible later.
3. Fix the cause at the source: for this class of PDF the letters are not lost, only out of order, so they can be put back. Do NOT make grounding fuzzy.

# Findings (code read, real files measured)
- **Where "ready" is set:**
  - `server/src/pipeline/run.js:229`: all stages done.
  - `run.js:239`: a quiz_options, quiz_review or on-demand failure leaves the lesson ready.
  - `run.js:244`: sets failed.
  - The flashcards stage (`run.js:141-178`) saves whatever survives, including 0 cards (`saved()` is count > 0, `:143`). The run then continues to quiz_review and ends ready.
- **Where grounding drops cards:** `server/src/pipeline/evidence.js:55` `if (!sourceKey.includes(comparable(quote)))` gives "evidence not found in the lesson text".
  - `comparable` (`:19`) already ignores case, spaces and punctuation.
  - Called from:
    - `pipeline/flashcards.js:90` (term cards) and `:228` (concept cards)
    - `pipeline/generate.js:244,279` (key terms)
    - `pipeline/quick-checks.js:31,37`
    - `services/regenerate-card.js:63`
- **The existing warning is never stored.** `routes/lessons.js:20-30` `lessonWarning()` returns the scanned or short-text string once, in the upload reply (`:195`).
  - The client keeps it only in memory (`client/src/lib/warnings.js`). It is set in `LibraryScreen.jsx:60-61` and shown in `Processing.jsx:84` and `LessonScreen.jsx:72`.
  - Admin sees it once, in `AdminScreen.jsx:56-57`.
  - After a reload it is gone, and nothing after the upload can use it. This is why Step 4 adds one column.
- **What admin sees today:**
  - 0 cards: `client/src/lib/flashcardsNotice.js` gives "No flashcards yet … Make cards". It never says why, and Make cards gives the same result.
  - 1 to 9 cards: nothing is shown anywhere.
  - `run-pipeline` prints "(ready)".
- **What students see for an empty lesson** (already plain: no provider text, no Settings):
  - Flashcards: "Cards aren’t ready yet" (`FlashcardsScreen.jsx:64`).
  - EndCard: "This lesson has no cards yet. Your teacher can make them." (`EndCard.jsx:20`).
  - Quiz: "No flashcards yet" (`QuizScreen.jsx:108`) and the 409 from `routes/quiz.js:125`.
- **How PDF text is read** (`services/pdf.js:106-139`):
  - pdf.js `getTextContent()` per page (`:120`).
  - Items are joined in content-stream order by `pageText` (`pdf-scripts.js`).
  - Then `normalizeText`, `stripRepeatedLines` (`:125`) and reflow (`:126`).
  - `extract.js:69` calls it, then `normalizeText(mathText(raw))` (`:79`).
- **Root cause in physics-energy and physics-newton** (font `JZZZEU+ArialMT`):
  - The PDF draws some letters of a line in a separate pass. pdf.js returns them as separate items, earlier in the stream, at the right x and on the same baseline.
  - Page 1 of physics-energy:
    - item 47 `"i"` at x=105.03, width 1.44
    - item 49 `"ll"` at x=133.43, width 2.9
    - item 51 `"j"` at x=239.78, width 1.44
    - then item 187 `"Th nk carefu y abut how each force affects an ob ect."` at x=97.38, width 154.36, y=397.45, size 6.48. ("abut" is a typo in the slide itself.)
  - Each missing letter group sits where the line has a space.
  - Letters with no host line come out as junk lines (" l wi li i i l").
  - **A cheap source fix exists** (Step 7). OCR is not needed. unpdf/pdf.js 5 has no option that changes this.
- **Other files from finding 3 in the brief:**
  - math-calc-exp-log has 26 U+FFFD (prime marks), and trig and bio-genetics lost symbols. These are symbol losses, not letter losses, and are out of scope. The detector deliberately ignores small amounts.
  - chem-redox (6 cards, quiz 3/10) is not a grounding problem. Only 1 card was dropped; the AI returned few cards after a 429/503. Step 6's "Only 6 flashcards." note makes it visible; the cause is a separate issue.

# Design decisions (and why)
1. **Status stays `ready`** when there are few or no cards.
   - The review (sections, key points) is still usable.
   - Failing the lesson would hide it from students and point the teacher to Retry, which reruns the same text with the same result.
   - It keeps the rule that later-stage failures leave the lesson ready.
2. **One stored code per lesson: `lessons.text_warning`** (migration 020). Values: NULL, `scanned_pdf`, `short_text` or `damaged_text`, written at upload.
   - It reuses the existing upload warning: same strings, same reply field `warning`. The client code that shows it is unchanged.
   - The column is needed because the PDF signal can't be recomputed later: the file is never stored.
   - There is no CHECK on it, so a later code needs no table rebuild (the lesson from events.type).
3. **No or few cards is computed when the admin list is read**, not stored: the card count against `QUIZ_LENGTH` (10). Make cards, Regenerate, rebuild and import can then never leave a stale flag.
4. **Admin row** shows the text-warning line and a cards notice:
   - "No flashcards could be made." (damaged text, with Try again)
   - or "Only N flashcards." (at most N of 10 quiz questions)
   
   Both use the existing `lesson__extra--note` style, never red. The text warning carries the guidance: re-save as .docx or .pptx, or export the PDF from the source.
5. **Students: nothing is hidden.** Visibility stays one fail-closed rule.
   - Hiding by content would touch every lesson route and `lesson-access.test.js`, and could make a lesson vanish mid-study.
   - For teacher lessons, students keep the existing plain lines.
   - A student's own upload shows the same plain text-warning line in its row. It is about their file, with no provider text and no Settings.
6. **No new events and no export change.**
   - `events.type` and `lesson_events.type` both have CHECKs.
   - `lessons.csv` uses a fixed column list (`export/research.js:184`), so the new column never reaches the export.
7. **The detector has two signals:**
   - Primary, PDFs only: the count of "stray letters", i.e. letter items that sit inside a space of another item on the same line. Clean PDFs: 0 of 10. physics-energy: 201. physics-newton: 40.
   - Backstop, any file type: a broken-word share over lowercase a-z tokens.
8. **(c) Fuzzy grounding is NOT recommended.**
   - Matching a "corrected quote" against text with missing letters means accepting quote letters the lesson doesn't contain.
   - If any deletions are allowed, the AI can add short words. `not` is 3 letters, so "Energy is not conserved" would match "Energy is conserved".
   - Limiting the tolerance to i/l/j still stores AI-corrected words as "lesson text", and students see that as the evidence quote.
   - It does not fix the leftover errors, which are misplaced letters, not missing ones.
   - It hides the damage signal.
   - The source fix (Step 7) restores the real letters and keeps the check exact.
   - Also rejected: telling the AI in the prompt to copy garbled quotes as written. It keeps grounding exact, but shows garbage quotes to students and changes shared prompts.

# Threshold evidence
Measured with the repo's own `extractText` through scratch scripts; no source file was changed.
- stray = letter groups placed by Step 2's rules
- broken = broken tokens / letter-only tokens (Step 1)
- wc = extractText wordCount

| file | wc | stray | broken | U+FFFD | verdict |
|---|---|---|---|---|---|
| physics-energy-mit.pdf | 1377 | 201 (of 340 short letter items) | 134/1192 = 11.24% | 0 | DAMAGED (strays; text alone too) |
| physics-newton-mit.pdf | 641 | 40 (of 74) | 24/578 = 4.15% | 0 | DAMAGED (strays only) |
| bio-cell-mit.pdf | 743 | 0 | 0.16% | 0 | clean |
| bio-photosynthesis-mit.pdf | 1243 | 0 | 0.00% | 0 | clean |
| chem-periodic-trends-mit.pdf | 1101 | 0 | 1.01% | 0 | clean |
| physics-waves-mit.pdf | 1109 | 0 | 2.68% | 0 | clean |
| history-us2 / math-quadratics / math-statistics -lumen.pptx | 3683 / 906 / 2546 | n/a | 0.00 / 1.19 / 0.08% | 0 | clean |
| bio-genetics / chem-redox / math-calc-exp-log / math-calc-trig / physics-electricity .pdf | | 0 each | 1.00 / 0.26 / 4.27 / 0.43 / 1.27% | 0/0/26/2/0 | clean |
| other test-lessons/subjects files (docx/pptx/pdf, rich/*) | | 0 | max 1.61% | 0 | clean |
| hand-written Filipino / Taglish / Filipino-math samples | 267 / 206 / 216 | | 0 / 0 / 4.8% (6 of 125) | 0 | clean |

**Synthetic letter loss** (letters removed from clean texts, a space left where each run was):

| letters dropped | broken share | flagged? |
|---|---|---|
| i/l/j | 7.8-15.8% on all 11 texts | all |
| e, o or a | 9.4-23.7% | yes, except Filipino with e or o removed (3.4%, 4.6%) |
| t/r | mostly under 7.5% | not caught by text alone |

Filipino rarely uses e or o, which is why those two cases are missed; this is a known limitation.

**Thresholds.** A file is flagged on whichever comes first:
- strays ≥ 5 and ≥ 0.5 per 100 words
- or ≥ 80 letter tokens, ≥ 12 broken and share ≥ 7%. The highest clean share seen is 4.27% (real file) and 4.8% (sample).
- or U+FFFD ≥ 10 and ≥ 5% of words. calc-exp-log's 26 is 3.1%, so it gets no warning, on purpose.

**Repair (Step 7), measured on a prototype:**
- All 10 clean PDFs: extracted text byte-identical.
- physics-energy: 201 letter groups put back. Broken share after repair: energy 5.93%, newton 2.41%. Both are still flagged by strays.
- Proxy for evidence quotes passing: six-word phrases from the AI's own sections that are found in the lesson text.

  | file | before repair | after repair |
  |---|---|---|
  | physics-energy | 4/53 | 20/53 |
  | physics-newton | 15/36 | 16/36 |
  | bio-cell (clean baseline) | 20/81 | — |
  | chem-periodic (clean baseline) | 14/40 | — |

- Sample output:
  - "Think carefully abut how each force affects an object."
  - "Pset 6 due this Friday at 10am."
  - "Mastering Physics deadlineis next Monday."

## Step 1: Text damage check (pure function)
What: add `server/src/services/text-damage.js` with `textDamage(text)` and `damageReason(stats, { strays, wordCount })`, plus tests.
For: sonnet-high-applier
Depends on: none
Changes: a new file with exactly this logic (the thresholds above were measured with it):
```js
// Does extracted text look like letters went missing? Only all-lowercase a-z tokens are judged, so names, acronyms,
// chemical symbols (Cl, Mg), mixed-case units (mmHg), accented and ñ words, digits and symbols never count.
const NO_VOWEL_OK = new Set('ng mg nth st nd rd th pp vs mr mrs dr km cm mm nm kg ml dl hz khz mhz ghz ms ns ps pm dx dy dz dt ds dv ln lg sgn ft lb lbs pt pts qt hr hrs sq tsp tbsp mph rpm bpm ppm ppb psi pdf ppt hmm shh brr'.split(' '));
const ONSETS = new Set('bl br ch chl chr chth cl cr dr dw fl fr gh gl gn gr kh kl kn kr kw gw pw bw mn ph phl phr phth pl pr ps pn pt sc sch schr scl scr sh shr sk skr sl sm sn sp sph spl spr squ st str sv sw th thr tr ts tw wh wr ng mg dj zh'.split(' '));
const EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
export const MIN_WORDS = 80; export const MIN_BROKEN = 12; export const BROKEN_SHARE = 0.07;
export const MIN_STRAYS = 5; export const STRAYS_PER_100_WORDS = 0.5;
export const MIN_REPLACEMENT = 10; export const REPLACEMENT_SHARE = 0.05;
export function textDamage(text) {
  const s = String(text ?? ''); let words = 0; let broken = 0;
  for (const line of s.split('\n')) {
    const toks = line.split(/\s+/).filter(Boolean).map((t) => t.replace(EDGE, '')).map((t) => (/^\p{L}+$/u.test(t) ? t : null));
    toks.forEach((t, i) => {
      if (!t) return;
      words += 1;
      if (!/^[a-z]+$/.test(t)) return;
      if (t.length === 1) { // a lone consonant between two words ("where s the"); a, i, o are words (o: Filipino "or")
        if (!'aio'.includes(t) && toks[i - 1]?.length >= 2 && toks[i + 1]?.length >= 2) broken += 1;
        return;
      }
      const onset = /^[^aeiouy]*/.exec(t)[0];
      if (onset === t) { if (!NO_VOWEL_OK.has(t)) broken += 1; }                 // no vowel: "nk"; "th", "ng" allowed
      else if (onset.length >= 2 && !ONSETS.has(onset)) broken += 1;           // "nders"; "mga", "kwento", "pwede" fine
    });
  }
  return { words, broken, share: words ? broken / words : 0, replacement: (s.match(/\uFFFD/g) ?? []).length };
}
// -> 'stray_letters' | 'broken_words' | 'replacement_characters' | null
export function damageReason({ words, broken, share, replacement }, { strays = 0, wordCount = words } = {}) {
  if (strays >= MIN_STRAYS && strays * 100 >= STRAYS_PER_100_WORDS * Math.max(wordCount, 1)) return 'stray_letters';
  if (words >= MIN_WORDS && broken >= MIN_BROKEN && share >= BROKEN_SHARE) return 'broken_words';
  if (replacement >= MIN_REPLACEMENT && replacement >= REPLACEMENT_SHARE * words) return 'replacement_characters';
  return null;
}
```
Tests: `server/test/text-damage.test.js` (node:test, strict assert).
- **Garbled.** About 120 words made by repeating "Th nk carefu y abut how each force affects an ob ect. Don t forget the ang e factor and ntegra n Work." and "Next Master ng Phys cs dead ne s next Monday. Exam #2 s next Fr day at 10 am." Expect `damageReason` = 'broken_words' and share > 0.07.
- **Clean English** prose (~150 words): reason null, share < 0.02.
- **Filipino** (~150-word Aralin text using ng, mga, sa, ay, si, ni, o, kwento, pwede, tsaka, "ng mga Anak ng Bayan"): broken 0.
- **Taglish** ("Ang photosynthesis ay ang proseso kung saan…", "i-review ninyo ang notes", "Sa Monday po ang deadline"): broken 0.
- **Math prose** ("ang m ay ang slope at ang b ay ang y-intercept", "where m is the slope", "y = mx + b"), ~150 words: reason null.
- **Fixed cases:**
  - DNA, KKK, Cl, Mg, mmHg are never counted.
  - Under 80 words never flags.
  - `damageReason(cleanStats, { strays: 5, wordCount: 1000 })` is 'stray_letters'.
  - `{ strays: 4 }` gives null, and so does `{ strays: 5, wordCount: 2000 }`.
  - 26 U+FFFD in 844 words gives null; 50 in 500 words gives 'replacement_characters'.

Done-check: `npm test` in `server/` passes. The file has no imports.
Do NOT touch: anything else.

## Step 2: Find stray letters in a PDF page (detection only)
What: new `server/src/services/pdf-strays.js` `findStrays(items)`. `extractPdf` counts the strays and returns `strays`; the text is unchanged in this step.
For: sonnet-high-applier
Depends on: none
Changes:
- `pdf-strays.js` exports `findStrays(items) -> [{ stray, host, at }]`. `stray` and `host` are item indexes; `at` is the code-point index of a space in `host.str`. All rules below must hold (measured: 0 placements on 10 clean PDFs).
- **Stray candidate:** `item.str.trim()` matches `/^\p{L}{1,3}(?: \p{L}{1,3})?$/u`, and `upright(transform)` holds (same test as `pdf-scripts.js:19`; copy it or export it).
- **Host:** the first other item, by index, that meets all of these:
  - `str.length > stray.trim().length + 1`
  - it is upright, with `width > 0`
  - its size, `Math.hypot(t[2], t[3])`, is within 15% of the stray's size
  - `|host.y - stray.y| <= 0.2 * hostSize`
  - `host.x < stray.x < host.x + host.width`
- **Position, per host:**
  - Sort its strays by x, and set `chars = [...host.str]`.
  - `em(c)`, the width in ems:

    | Character | Width (em) |
    |---|---|
    | space | 0.28 |
    | `i j l I . , : ; !` and the apostrophes | 0.25 |
    | `f t r ( ) [ ] -` | 0.33 |
    | `m w M W` | 0.85 |
    | other uppercase letters | 0.68 |
    | anything else | 0.55 |

  - `scale = max(host.width - sum of stray widths, 0.5 * host.width) / sum of em(chars)`.
  - For each stray, take `d = stray.x - host.x - (widths of this host's earlier strays)`. Then `t` is the first index i where `acc + em(chars[i]) * scale / 2 > d`, with acc summing `em * scale`; if there is none, `t` is `chars.length`.
- **Gap:** the nearest k that meets all of these:
  - `chars[k]` is a space
  - `1 <= k <= len-2`
  - `|k - t| <= 1.5`
  - `chars[k-1]` and `chars[k+1]` are both cased letters (`\p{Lu}` or `\p{Ll}`), and at least one is lowercase
  
  If no k qualifies, skip the stray.
- **Duplicate guard** (faux bold): skip the stray when `chars.slice(max(0, floor(t)-2), ceil(t)+3).join('')` already contains its text.
- `pdf.js` `extractPdf`:
  - Per page: `const strays = findStrays(content.items); strayCount += strays.length;`
  - Keep `pageText(content.items)` unchanged.
  - Return `{ text, pageCount, numbers, strays: strayCount }`.

Tests: `server/test/pdf-strays.test.js`.
- **Unit test, real geometry from Findings.** Transforms `[6.48,0,0,6.48,x,397.45]`. Widths: "i" 1.44, "ll" 2.9, "j" 1.44, host 154.36. Expect 3 placements, at the spaces of "Th nk", "carefu y" and "ob ect".
- **Rejected cases:**
  - "O X" with "c" (no lowercase neighbour)
  - "the ^" with "y" (the modifier circumflex is not cased)
  - a theta after "sec(" (no space gap)
  - a stray 30% smaller than the host
  - a stray 2 points off the baseline
  - a duplicate "is" over "this is"
- **End to end with pdf-lib** (Helvetica 12; see `scriptPdf` at `server/test/extraction.test.js:491`):
  - Draw each stray first, at `x = 60 + font.widthOfTextAtSize(textBeforeGap, 12)`.
  - Then draw the host line with one space per gap. Lines:
    - "Th{i}nk carefu{ll}y about how each force affects an ob{j}ect."
    - "Next Master{i}ng Phys{i}cs dead{li}ne {i}s next Monday."
    - "Work done by a force {i}s not a vector quant{i}ty."
  - Expect `strays === 9` (measured).
- Existing pdf tests stay green, and `scriptPdf` documents give `strays: 0`.

Done-check: `npm test` (server) passes. `extractPdf` text is byte-identical to before in every existing test.
Do NOT touch: `pageText`/`convert` in `pdf-scripts.js` (exporting `upright` is fine), the reflow and header code in `pdf.js`, or `extract.js` (Step 3).

## Step 3: extractText reports damage; `npm run text:check`; run-pipeline prints it
What: wire Steps 1 and 2 into `extractText`, and add a read-only check script for verifying the real files.
For: sonnet-high-applier
Depends on: 1, 2
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

## Step 4: Store the upload's text warning; send it to admin and the owner
What: migration 020 adds `lessons.text_warning`. The upload stores the code and replies with its message; `shape()` exposes `{ code, message }` to admin and the owning student only.
For: sonnet-high-applier
Depends on: 3
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

## Step 5: Admin list says how many cards a full quiz needs
What: `GET /api/lessons?counts=1` rows gain `flashcards.quiz_length` (= `QUIZ_LENGTH`, `server/src/quiz/build.js:31`).
For: sonnet-high-applier
Depends on: none
Changes:
- `routes/lessons.js` near `:249`: `flashcards: { total, status, error, quiz_length: QUIZ_LENGTH }`, importing `QUIZ_LENGTH`.
- The students' list stays without counts.
- Add one line to `docs/api.md`.
Tests: in `server/test/quiz-leaks-admin.test.js`, which already reads a `?counts=1` row:
- `row.flashcards.quiz_length === 10`
- the students' list rows have no `flashcards` key
Done-check: `npm test` passes.
Do NOT touch: `run.js` status logic, the flashcards route, `quiz/build.js`.

## Step 6: Client: admin row notes, owner's note, admin preview
What: show the stored text warning, and a clear notice when a lesson has no cards or only a few, using existing styles only (no red, no new colours).
For: sonnet-high-applier
Depends on: 4, 5
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

## Step 7: Source fix: put stray letters back (recommended)
What: `applyStrays(items, placements)` writes each stray into its gap before `pageText` runs, so physics-energy and physics-newton get their letters back.
For: sonnet-high-applier
Depends on: 2 (verify with 3)
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

## Step 8 (optional): Say in the logs why cards went missing
What: when fewer than `QUIZ_LENGTH` cards are saved, the flashcards stage logs one line summing up the drop reasons, and `run-pipeline` prints an "Only N flashcards" line.
For: sonnet-high-applier
Depends on: none
Changes:
- `run.js` flashcards stage:
  - Tally the `onDrop` reasons in a Map.
  - After the "saved N" log, if `cards.length < QUIZ_LENGTH`, log a warning: `[pipeline] lesson <id>: only N flashcards kept; dropped: <reason> xCount, ...`.
  - Log only.
- `run-pipeline.js`: after the summary, print the same line when there are fewer than 10 flashcards.
Tests: in `pipeline.test.js`, a fake AI whose quotes are not in the text gives a warning log containing "evidence not found in the lesson text x", and the lesson status is still `ready`.
Do NOT touch: any `UPDATE lessons SET status` line in `run.js`, the stage order, `jobs.js`.

# How to verify (the whole change)
1. Run `npm test` in `server/` and `client/` (or root `npm test`).
2. Run `npm run text:check -- test-lessons/subjects/real` and `npm run text:check -- test-lessons/subjects`.
   - physics-energy and physics-newton say damaged.
   - Every other file says "looks fine", with the numbers from the evidence table.
3. With `npm run study`, as admin:
   - Upload `physics-energy-mit.pdf`:
     - The upload notice shows the damaged-text message.
     - After processing, the row shows the text-warning line and "No flashcards could be made." After Step 7 it may have cards instead.
   - Upload `physics-newton-mit.pdf`: the text line, plus "Only N flashcards." if it still makes fewer than 10.
   - Upload `bio-cell-mit.pdf`: no text line and no notice.
   - Reload: the lines are still there, and the admin preview shows the Notice.
4. As a student (uploads on, Share off), upload physics-energy:
   - The processing page shows the plain message, and their library row still has it after a reload.
   - After Share, other students see nothing new.
   - The empty-lesson screens show only the existing plain lines.
5. Research export: the lessons.csv header is unchanged. Backup and restore run migration 020.

# Test plan with the real files (test-lessons/subjects/real/)
- **Must be flagged:** physics-energy-mit.pdf (stray_letters, 201) and physics-newton-mit.pdf (stray_letters, 40). Use the Step 3 `text:check` output.
- **Must not be flagged:** bio-cell, bio-photosynthesis, chem-periodic-trends, physics-waves, and history-us2 / math-quadratics / math-statistics -lumen.pptx. The other real files must not be flagged either.
- The real files are git-ignored local files, so they are not in `npm test`. Unit and e2e tests use the measured geometry and a pdf-lib fixture that reproduces the same pattern (9 of 9 strays). The real-file check is a manual step run with `text:check`, and its numbers go in the PR description.

# Do NOT touch (the whole plan)
- `pipeline/evidence.js` and every grounding call: no fuzzy matching.
- Prompts (`ai/prompts.js`).
- The Claude import and export path: `services/claude-exchange.js`, `scripts/import-lesson.js`, `scripts/export-lesson.js`.
- The research export and codebook.
- The `events` and `lesson_events` CHECKs.
- The admin PIN middleware.
- `visibleSql`.
- The status transitions in `run.js`.
- `CLAUDE.md`: leave it to the user or boss. An optional one-line pointer under Parsing is fine.
- One task per applier run: each Step above is one run.

# Risks
- **Stray rules on PDFs outside the sample.** Faux bold, letter-spaced headings or odd kerning could, rarely, place a letter in the wrong spot.
  - Guards: cased neighbours with at least one lowercase, same size and baseline, the duplicate guard, and inner gaps only.
  - On clean PDFs it placed 0 letters, but only 10 clean PDFs were available.
  - Detection alone (Step 2) never changes text. Step 7 does, which is why it has the byte-identical check.
- **Text check.** The Filipino evidence comes from hand-written samples; there was no real Filipino PDF.
  - A formula-dense lesson could pass 7% (the highest seen is 4.27%).
  - A false positive costs one wrong warning line, not a blocked lesson.
- **Older lessons** have a NULL `text_warning` (unknown). Imported and script-made lessons are never checked.
- **"Only N flashcards."** shows on every lesson with fewer than 10 cards. That is information (the quiz can't fill 10), not an error.
- **Student uploads.** A student's damaged upload still uses up one of their uploads. Refusing it up front (as with `no_text`) is possible, but false positives would then block uploads. Not recommended.

# If time is short
- **Must do:** Steps 1, 2, 3, 4 and 6. Step 5 is one line, so do it with them.
- **Next:** Step 7. It is what actually rescues these lessons.
- **Cut first:** Step 8, then the AdminLessonScreen Notice in Step 6.
- **Never:** fuzzy grounding.
