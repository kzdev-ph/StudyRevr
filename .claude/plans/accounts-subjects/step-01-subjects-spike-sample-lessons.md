What: Make 5 sample lessons (math, physics, chemistry, history, literature), run each through today's pipeline, and record where each stage breaks.
For: sonnet-high-applier (uses the real AI, about 80 of the 500 daily requests)
Depends on: none
Status: done (report: low thinking is enough; see Step 10 notes)

# Step 1: Subjects spike — sample lessons and a baseline run

**Setup:**
- In D:\claude\pr2\Research_application_pr2_after_chapter_3: if `node_modules` is missing, run `npm ci` in the repo root only.
- If `.env` is missing, copy `.env.example`. GOOGLE_API_KEY must be filled by the user; if it is empty, stop and say so.

**Files:**
- NEW `server/scripts/make-subject-samples.js` (ES module dev tool). It writes into `test-lessons/subjects/` (gitignored) using the existing devDependencies `docx`, `pptxgenjs`, `pdf-lib` and the dependency `jszip`:
  1. `math-quadratics.docx`, about 300 words.
     - Definitions: quadratic equation, roots, discriminant.
     - Real Word equations built with docx `Math` / `MathRun` / `MathFraction` / `MathSuperScript` / `MathRadical`: ax²+bx+c=0, the quadratic formula, D=b²−4ac.
     - A numbered list of 4 factoring steps.
     - A worked example x²−5x+6=0 → (x−2)(x−3)=0 → x=2 or x=3, with these lines also as Word equations.
  2. `physics-newton.pptx`, 6 slides.
     - Formulas typed as text: "F = ma", "a = Δv/Δt", "W = mg", plus units N, kg, m/s².
     - A worked example: m = 5 kg, a = 2 m/s² → F = 10 N.
     - Speaker notes on 2 slides.
     - On slide 3, a real Office equation. Put a run with the text EQ_PLACEHOLDER on the slide, then use JSZip to replace that `<a:r>…</a:r>` in `ppt/slides/slide3.xml` with:
       `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" Requires="a14"><a14:m><m:oMathPara xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:oMath>…</m:oMath></m:oMathPara></a14:m></mc:Choice><mc:Fallback/></mc:AlternateContent>`
       The `<m:oMath>` holds KE = ½mv² (`m:f` for 1/2, `m:sSup` for v²).
  3. `chemistry-moles.pdf`, 2 pages, pdf-lib Helvetica.
     - WinAnsi characters only: no π, √ or →.
     - Avogadro's number drawn as "6.022 × 10", with "23" as a separate smaller raised text, the way real PDFs do it.
     - Molar mass of H2O and CO2, with a worked example (44.01 g/mol).
     - A 3-item list.
  4. `history-katipunan.pptx`, 6 text slides: Katipunan 1892, Bonifacio, Cry of Pugad Lawin 1896, a list of 4 causes, Tejeros 1897; notes on 2 slides.
  5. `literature-poem.docx`: "The Road Not Taken" (1916, public domain) in full, then imagery / metaphor / symbolism / tone defined, then a short analysis.
- `server/scripts/run-pipeline.js` additions:
  - `--show-text`: print `raw_text` after the "Extracted…" line.
  - `--save=<file.db>`: `fs.writeFileSync(file, db.serialize())` after the run.
  - Always print at the end:
    - (a) `formatReport(lessonLeakReport(db, lessonId))` from `src/quiz/check.js`, which prints "Clean questions available: N of 10".
    - (b) "LaTeX leftovers: N": student-facing stored texts (`sections.content`, `check_questions`, `key_points.text`, `key_terms.term`/`definition`, `flashcards.front`/`back`, `quiz_distractors.choices`) matching `/\\[a-zA-Z]+|\$[^$\n]+\$|\^\{|_\{/`, with up to 5 listed.

**Run:**
- `node server/scripts/make-subject-samples.js`
- For each file: `npm run pipeline -- test-lessons/subjects/<file> --show-text --save=test-lessons/subjects/out/<name>.db > test-lessons/subjects/out/<name>.log 2>&1`
- Also run every file the user put in `test-lessons/subjects/real/`.

**Hand back a table** with one row per lesson:
- ready / failed
- each equation as it appears in `raw_text` (quote it)
- counts of sections, key terms, term cards and concept cards
- cards dropped, by reason
- outcome of the `quiz_options` and `quiz_review` stages
- clean questions N of 10, split into multiple choice and true/false
- LaTeX leftovers
- anything a student couldn't read

**Expected, from reading the code:** the docx equations go missing; the pptx equation appears as bare LaTeX; PDF superscripts are flattened; formula quotes are dropped; numeric questions fall back to true/false or are skipped.

Tests: none. `npm test` in `server/` still passes.
Done-check: 5 sample files, 5 logs, and the table handed back.
Do NOT touch: `server/src/**` (no fixes in this step). Do not commit `test-lessons/` or `.env`.
