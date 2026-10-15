# Paper motion (step 1: proposals)

Static demo only; nothing under `client/` or `server/` changed. Open `index.html` through a local server from the repo
root (it links `../../client/src/styles/tokens.css` and `../shared/board.css`), for example
`python -m http.server 8765` and then `http://localhost:8765/design/motion/`. The page has Motion (device / full /
reduced) and Theme (light / dark) switches; every frame can be replayed and every animation skipped by a tap. The box
under each frame shows what the research clock records; students never see it.

## The timing rule

`time_ms` starts when the question or card is on screen and usable (its entrance finished, skipped, or the first tap or
key), pauses while a flashcard turns over, and stops at the answer. Marks that play after an answer never hold the
next question's clock. Reduced motion follows the same rule, so the motion setting never changes a student's numbers.

Found in today's code: the quiz counts about 360 ms of animation in every question after the first
(`AnimatePresence mode="wait"`: a 180 ms exit, then a 180 ms fade-in, after the clock started) and 180 ms in the first;
flashcards count a 180 ms fade-in and the 420 ms flip. **Q0** (no wait between questions) and the answer clock ship in
step 2 whatever is picked, with a codebook line so answers before and after the fix can be told apart.

## Proposals

| ID | Where | Length | Says |
|---|---|---|---|
| F1 | Flashcards, deck start (moved from the quiz) | 3 or 4 riffles, 1.8-2.4 s (as built; the demo plays one, 600 ms) | "Getting your deck out" (never "Shuffling": the order is fixed) |
| F2 | Flashcard turn | 420 ms | Paper turning over: a 4 px lift and a fold shadow |
| F3 | Answer that brings the card back today (minutes) | 260 ms | It goes back under the deck |
| F4 | Answer that sends it away for days; deck finished | 300 ms, 200 ms | Onto a done pile in the margin; the pile squares up |
| Q0 | Next question | 0 ms | Timing fix (required) |
| Q1 | Quiz start (replaces the shuffle) | 420 ms | The test sheet is handed out |
| Q2 | After an answer is saved | 260 + 180 ms | Pen loop round your number; tick or strike |
| Q3 | Quiz progress | 150 ms per bubble | Answer-sheet bubbles fill in |
| Q4 | Results | 500 ms | The score circled like a grade |
| R1 | Key terms on first view | 380 ms | The marker slides under each term |
| R2 | Quick check, Show answer | 280 ms | Lift the card covering the answer |
| S1 | Stats day bars, once per open | 540 ms total | The week inked in |
| S2 | Waiting for a rewrite | loops, stops off screen | Ruled lines being written on (replaces the shimmer) |

All transform / opacity (plus stroke-dashoffset for the pen), under ~600 ms each (F1, the deck coming out, is the agreed exception), existing tokens only: right `--ok`,
wrong `--danger`, pen and grade `--accent`. Nothing is red.

F3 also changes the screen at rest: the study card gets the two `--card-edge` deck edges under it (it goes back under
something). In the demo the clock falls back to a 100 ms timer when the page can't paint (a hidden tab); the app's
clock starts only from a real paint or the first tap or key.

Cut: page turn between sections, stamps / confetti, right-wrong colours in the bubbles, the answer "written in ink"
(needs clip-path), a separate pile square-up (folded into F4).
