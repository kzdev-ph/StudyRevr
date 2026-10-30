What: No LaTeX ever reaches a student, and math lessons get math-aware instructions. Prompts for non-math text stay byte-identical.
For: sonnet-high-applier
Depends on: 3
Status: built, server 967/967 + client 212/212 green, boss read the prompts diff; real-AI done-check (LaTeX leftovers 0 on physics sample) waits for Step 1 and the API key

# Step 8: Math in AI replies and prompts

**`server/src/ai/client.js` (~l.406):** `value = mathTextDeep(parseJsonReply(content))`, before zod validation. This covers processing and live calls.

**`server/src/ai/prompts.js`:**
- Export these rule texts:
  - **MATH_TEXT:** "- Math: write formulas, numbers, units and symbols exactly as the lesson text writes them, as plain text with Unicode symbols (x², v₀, √, π, ×, ÷, ±, ≤, ≥, →, °) and fractions as a/b. Never use LaTeX, dollar signs, backslash commands or markdown."
  - **MATH_TERMS:** "- A term may be the name of a formula or quantity the lesson defines ("Kinetic energy", "Discriminant"); its definition says what it is and may end with the formula as the lesson writes it."
  - **MATH_CARDS:** "- This lesson has formulas or worked examples. Besides concepts, make cards that ask: which formula the lesson gives for a quantity (the answer is the formula as the lesson writes it); what a symbol in a formula stands for and its unit; the next step of a method the lesson shows; and the result of a worked example the lesson itself solves (the question gives the example's values, the answer is the lesson's own result with its unit, and the evidence quote holds that result). Never make up a new problem or new numbers, and never give a result the lesson does not show."
  - **MATH_OPTIONS:** "- When the correct answer is a number with a unit, a formula or an expression, each wrong answer is the same kind of thing in the same format (a number with the same unit; a formula with the same symbols), the result of a common mistake: a wrong operation, a missing square, root or factor, swapped quantities, a wrong unit conversion or a sign error. These wrong answers may use numbers that are not in the lesson (the one exception to rule 1), but must never equal the correct answer in another form (0.5 and 1/2 are the same answer)."
- Add `mathRules(text, ...rules)`, which returns `''` unless `looksMathy(text)`.
- Insert the rules into these prompts:

| Prompt | Rules added (only for math text) |
|---|---|
| `sectionsPrompt` | MATH_TEXT, plus "Keep each worked example's steps in order with its numbers and units." |
| `keyTermsPrompt` | MATH_TEXT, MATH_TERMS |
| `flashcardsPrompt` | MATH_TEXT, MATH_CARDS |
| `quickChecksPrompt`, `regenerateCardPrompt`, `regenerateCardsPrompt` | MATH_TEXT |
| `simplifyPrompt`, `translatePrompt` | MATH_TEXT (checked against the section content) |
| `distractorsPrompt` | MATH_TEXT and MATH_OPTIONS, when any card answer passes `isMathAnswer` |

**Client:**
- `client/src/styles/tokens.css`: in `--font-read` and `--font-ui`, add `'Cambria Math', 'STIX Two Math', 'Noto Sans Math'` before the generic family. This is a glyph fallback, not a colour or radius.
- Make sure `.prose`, the flashcard faces and `.quiz-opt__text` have `overflow-wrap: anywhere`; add it where it is missing.

**Tests:**
- `ai.test.js`: a scripted reply `{"answer":"$x^{2}$","n":1}` comes back as "x²".
- `content-prompts.test.js`:
  - a physics chunk gets the rules;
  - every existing prompt test text gets none (assert the system text doesn't include MATH_TEXT);
  - `distractorsPrompt` with answer "10 N" includes MATH_OPTIONS, and with "Builds confidence" it doesn't.

Done-check: tests are green; `npm run pipeline` on `physics-newton.pptx` → LaTeX leftovers 0.
Do NOT touch: `prompts-haiku.js`, `claude-exchange.js` (the Claude-import path), the existing rule texts (KEEP_MEANING etc.), `quizReviewPrompt`.
