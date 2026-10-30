What: Formula quotes ground, worked-example answers must come from their quote, pure-math list lines need no card, and numeric options are judged by value.
For: sonnet-high-applier
Depends on: 3
Status: built, 1004/1004 green; audit batched

# Step 10: Math-aware grounding and quiz checks

- `server/src/pipeline/evidence.js` `checkEvidence`: when the quote holds `=`, `≈`, `≤`, `≥`, `→` or `⇌`, `minExplaining = Math.min(minExplaining, 1)`. Everything else is unchanged.
- `server/src/pipeline/flashcards.js` `checkConceptCards` (~l.216): drop a concept card when its answer holds a number (compared per number, as in `mathKey`) that its evidence quote doesn't. The reason is 'a number in the answer is not in its quote'. This catches invented or miscomputed results.
- `server/src/pipeline/flashcards.js` `listItems` (~l.35): a line with no word of 3 or more letters (`/\p{L}{3,}/u`) is not a list item that needs a card. Examples: "x = 2", "F = ma", "3.5 m/s". "- Igneous" is kept.
- `server/src/quiz/leaks.js` `answerInQuestion` (l.242): skip the one-word exact rule when the answer's only content word is a pure number. The whole-phrase check still applies.
- `server/src/quiz/leaks.js` `wrongOptionProblems` (l.310): add rule f "the right answer in another form (same value)" when `sameValue(wrong, correct)`. `falseStatementProblems` (l.374) gets the same as rule e.

**Tests:**
- `evidence.test.js`:
  - "Newton's second law" with quote "F = ma" → ok;
  - "Area of a circle" with quote "A = πr²" → ok;
  - a 2-word quote without an equation still fails.
- The flashcards tests (or a new `math-cards.test.js`):
  - answer "12 N" with quote "F = ma = 10 N" → dropped; "10 N" → kept;
  - pure-math list lines are skipped and word items kept.
- `quiz-leaks.test.js`:
  - "If m = 10 kg and a = 1 m/s², what is F?" → "10 N" is not a leak;
  - "Ten" is still a leak for its old case;
  - wrong option "10.0 N" for "10 N" → rule f;
  - "12 N" → no problem.

Done-check: server tests are green.
Do NOT touch: the thresholds (REWORDED, NEAR_DUPLICATE, …), the Filipino stemmer, quiz selection in `build.js`, card kinds and CHECK constraints.

## Step 1 real-AI findings (2026-10-30)
- Low thinking is enough for math/physics/chemistry (medium/high: no fewer wrong numbers, more time, inline "- " bullet run-ons). Keep default Low.
- No AI-made wrong numbers. One pipeline fault: PDF extraction flattens superscripts ("6.022 × 10^23" -> "6.022 × 1023", chemistry 3/3 runs). Separate fix needed in PDF extraction (new step 10b).
- Gaps (not fixed by thinking): pptx decks merge into 1 section; worked-example cards missing at low; true/false fallback when options rejected as reworded.

## Audit round (2026-10-30)
Sonnet audit found 4 blockers on non-math lessons (dates dropped, reworded copies passing, $ and Windows paths mangled, math prompts on non-math); all fixed in math-regressions pass, 1048/1048. Re-check batched with Step 11/12 audit. Note: looksMathy needs 3 hits, so a lesson with a single formula gets no math prompt rules (acceptable).
