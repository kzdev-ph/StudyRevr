What: overview and shared rules. For: boss only.

# Garbled PDF text and empty lessons
Approved by the user on 2026-10-31. Original plan: full.md (agents never read it).

## Goal
- A lesson with no or few cards is never shown to the teacher as fine (status stays ready; admin row notes).
- Garbled extracted text is detected at upload and the teacher gets a plain stored warning (lessons.text_warning, migration 020).
- Source fix for PDFs whose letters are out of order (put stray letters back). No fuzzy grounding.

## Where
Work folder: D:\claude\pr2\Research_application_pr2_after_chapter_3 (branch feat/accounts). FROZEN: D:\claude\pr2\Research_application_pr2. Real test files (git-ignored): test-lessons/subjects/real/.

## Do NOT touch (all steps)
evidence.js and grounding; ai/prompts.js; claude-exchange.js, import/export scripts; research export + codebook; events/lesson_events CHECKs; admin PIN middleware; visibleSql; status transitions in run.js; no commits, no pushes.

## Shared rules
Plain JavaScript ES modules; zod for request bodies; `npm test` in server/ (and client/ for client steps) green before reporting done; client CSS tokens only, nothing red means wrong; new routes through mount() (none expected); students never see provider messages or study IDs; one step per applier run.

## Steps
| # | Title | For | Depends on | Status |
|---|---|---|---|---|
| 1 | Text damage check (pure) | sonnet-high-applier | none | done |
| 2 | Find stray letters in a PDF | sonnet-high-applier | none | done |
| 3 | extractText reports damage + text:check | sonnet-high-applier | 1, 2 | done |
| 4 | Store text warning (migration 020) | sonnet-high-applier | 3 | done |
| 5 | Admin list quiz_length | sonnet-high-applier | none | done |
| 6 | Client admin notes | sonnet-high-applier | 4, 5 | done |
| 7 | Put stray letters back | sonnet-high-applier | 2 (verify with 3) | done |
| 8 | Log card drops (optional) | sonnet-high-applier | none | skipped (optional) |
Order: 1, 2, 3, 4, 5, 6, 7; 8 optional. Audit after 4 (stored data + visibility) and at the end.
