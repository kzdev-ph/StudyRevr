What: in generateConceptCards, ask a chunk once more when its flashcards reply kept under a quarter of the cards asked.
For: sonnet-high-applier
Depends on: none
Status: todo

# Step 1: One second try for a near-empty flashcards reply

Why: physics-energy (v3) got 0 concept cards from the flashcards call (the model took the prompt's `{"cards":[]}` exit on garbled text with a titles-only review), so the lesson ended with 2 term cards and a 0/10 quiz. Nothing recovers from it today (stage is done with >= 1 card, `make cards` refuses a lesson that already has cards).

## Changes
- `server/src/pipeline/flashcards.js`
  - Add `SECOND_TRY_WORDS = 400`, `SECOND_TRY_SHARE = 0.25` and
    `export const needsSecondTry = ({ kept, asked, words }) => words >= SECOND_TRY_WORDS && kept < Math.ceil(asked * SECOND_TRY_SHARE)`.
  - `reviewFor(chunk, sections, single, share = 0.5)`: replace `chunk.tokens / 2` with `chunk.tokens * share`. The first call is unchanged.
  - In the mapLimit callback of `generateConceptCards` (about lines 192-213), after the first `checkConceptCards`, add
    `if (!ctx.stopped() && needsSecondTry({ kept: cards.length, asked: targetCards, words: wordList(chunk.text).length }))`. Then:
    - Rebuild the prompt with the same arguments but `review: reviewFor(chunk, sections, single, 1)`. The system string stays byte-identical.
    - Send `user + secondTryNote(kept, targetCards)` with label `${partLabel(i, n)} (second try)` and the same schema, responseSchema and maxTokens.
    - Run `checkConceptCards` on the reply, then `cards = placeInLesson(cards, again, chunk.text)`.
    - Wrap the call in try/catch: on any error keep the first cards and report it (as `askAgain` does in quick-checks.js:91-96).
  - Note text (user message only): "Your previous reply gave only K usable card(s), but this lesson text explains more ideas than that. Write about A cards, following every rule above. Some words in the text may have lost letters or run together when the file was read: copy each "evidence" quote exactly as <lesson_text> writes it, broken words included; never repair them."
  - Add an optional callback `onReply({ label, asked, returned, kept, secondTry, error })`, called after each call. Thread it through `generateFlashcards`.
- `server/src/pipeline/run.js`, flashcards stage only (~line 158): log `[pipeline] lesson N: <label>: reply had R card(s) for about A asked, K kept[; asking once more | ; second try failed: ...]`.
- `docs/flashcards.md` (~line 14) and the call budget in `docs/ai-layer.md`: add "+1 second try for a chunk of 400+ words whose reply kept under a quarter of the cards asked".

## Tests (server/test/flashcards-generate.test.js, new describe)
1. `needsSecondTry` is true for {kept 0, asked 23, words 980}, false for {6, 23, 980} and false for {0, 23, 399}.
2. On a lesson of 400+ words built from 20 distinct sentences, a stub returning `[]` then 3 grounded cards gives: labels ['the flashcards', 'the flashcards (second try)']; `calls[1].system === calls[0].system`, and `calls[1].user` ends with the note; 3 concept cards, in lesson order.
3. A healthy first reply makes exactly 1 call.
4. An ungrounded second-try card is dropped with 'evidence not found in the lesson text'.
5. A second try that throws returns the first cards, does not throw, and `onReply` reports the error.
6. Two empty replies make exactly 2 calls.
7. A duplicate across the two replies is dropped and logged by `generateFlashcards`.
8. With a review bigger than half the chunk, the first user message has titles only and the second has the full review.

Done when `npm test` in server/ passes with NO edits to existing tests (label lists in pipeline.test.js:90/239, thinking.test.js:105 and flashcards-api.test.js:266 stay valid because those lessons are under 400 words).

## Do NOT touch
- `server/src/ai/prompts.js` and `prompts-haiku.js` (the system prompt stays byte-identical).
- The single invalid-JSON retry in `ai/client.js` `generateJSON`.
- `evidence.js` and the `checkConceptCards` rules (no fuzzy grounding).
- `targetCardCount`, `EXTRA`, `coverItems`, the first call's `reviewFor` share, `quiz/*`.
- `.env`, `D:\claude\pr2\Research_application_pr2`. No commits, no pushes.

## Known risks (do not try to solve here)
- The second try may pad with trivia; the system prompt's no-trivia rule and the quiz review still apply.
- `isDuplicate` may miss paraphrased duplicates across the two replies.
- In the file/Claude import path (`ai/file-ai.js`) calls hang rather than throw, so a near-empty reply adds one more prompt file to answer: `the-flashcards-second-try`. Mention in docs if that path documents its prompt files.
