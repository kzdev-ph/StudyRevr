What: Word and PowerPoint equations reach `raw_text` as readable Unicode, and typed LaTeX in any file is converted.
For: sonnet-high-applier
Depends on: 3
Status: built, 970/970 server + 212/212 client green, boss read the diff. Known nit: a space is left before punctuation after a pptx equation ("πr² ."). Done-check on math-quadratics.docx waits for Step 1.

# Step 6: Equations survive extraction

**`server/src/services/pptx.js`:**
- Add `nodeText(node)`. When a descendant is `{ type: 'code', metadata: { math } }`, build the text from the children:
  - text nodes as they are;
  - math nodes as `` ` ${latexToText(child.text)} ` ``;
  - nested children recursively.
- Otherwise return `node.text` unchanged, so lessons without equations take the old path.
- Use `nodeText` for paragraph/heading, list and table cells in `nodeLines`. Export `nodeLines`.
- **Before writing code:** log the AST of the Step 1 pptx fixture (or one made in the test) and confirm each run appears exactly once. officeparser 8.1 `PowerPointParser.js` ~l.762 also appends the LaTeX to `paragraph.text`, so never use both.

**`server/src/services/extract.js` (docx):**
- Read `word/document.xml` with JSZip. If it matches `/<m:oMath[\s>]/`, use `extractDocxWithMath(buffer)`:
  - `OfficeParser.parseOffice(buffer, { fileType: 'docx', ignoreNotes: true, ignoreHeadersAndFooters: true })`;
  - for each `ast.content` node of type paragraph, heading, list or table, `nodeLines(node)`; any other node type is skipped;
  - every line is its own block (`join('\n\n')`), keeping the docx rule that every paragraph is its own block.
- If that throws, log a warning and fall back to mammoth.
- Without equations: mammoth exactly as today.

**`extractText` (all file types):** `raw = mathText(raw)` before `normalizeText`.

**Tests in `server/test/extraction.test.js`:**
1. A docx built with docx `Math` ("The area is " + A=πr² using MathSuperScript, and a MathFraction 1/2) → the text holds "A=πr²" and "1/2" with the surrounding words in order, and no backslash. The existing docx tests stay byte-identical.
2. A pptxgenjs deck patched with OMML as in Step 1 → the slide line equals the exact `latexToText` output for ½mv² ("KE=(1/2)mv²"), with no backslash.
3. A PDF with "x^{2}" typed literally → "x²".

Done-check: server tests are green; re-run `npm run pipeline -- test-lessons/subjects/math-quadratics.docx --show-text` and paste the equation lines.
Do NOT touch: the mammoth path for docx without equations, the PDF reflow, source numbering, `zipguard.js`.
