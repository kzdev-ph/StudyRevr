## Step 2: Find stray letters in a PDF page (detection only)
What: new `server/src/services/pdf-strays.js` `findStrays(items)`. `extractPdf` counts the strays and returns `strays`; the text is unchanged in this step.
For: sonnet-high-applier
Depends on: none
Status: done
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

Do NOT touch (whole plan): pipeline/evidence.js and every grounding call (no fuzzy matching); ai/prompts.js; services/claude-exchange.js, scripts/import-lesson.js, scripts/export-lesson.js; the research export and codebook; the events and lesson_events CHECKs; the admin PIN middleware; visibleSql; status transitions in run.js; CLAUDE.md. Do not commit or push.
