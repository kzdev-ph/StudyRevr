What: overview and shared rules. For: boss only.

# AI-written True/False statements for concept cards (option B)

Goal: a True/False question from a CONCEPT card shows one natural AI-written sentence (true sentence + false twin), checked by code and by the exam review. A pair is shown only if it passed both; otherwise the card is multiple choice (or today's form if it cannot be MC). Stored/exported choices stay True/False. Tested on Gemini only; the code is provider-agnostic.

User decisions (approved 2026-10-31, defaults): Q1 keep today's form for forced cards; Q2 no new export column; Q3 word-level grounding (same word or inflected/derived form); Q4 backfill with the admin button; Q5 list-item cards out of scope; Q6 correction wording "The true statement: ...".

Shared rules: see the first part of each step file (copied from the plan). Never touch `D:\claude\pr2\Research_application_pr2` or `.env`. No commits, no pushes.

| # | Title | For | Depends on | Status |
|---|---|---|---|---|
| 1 | Migration 021 and tests | sonnet-high-applier | none | done |
| 2 | Pure statement checks | sonnet-high-applier | none | done |
| 3 | Store helpers and build options | sonnet-high-applier | 1 | done |
| 4 | Builder uses pairs | sonnet-high-applier | 3 | done |
| 5 | Attempts carry form | sonnet-high-applier | 1, 4 | done |
| 6 | The AI call | sonnet-high-applier | 2, 3 | done |
| 7 | Pipeline and admin wiring | sonnet-high-applier | 6 | done |
| 8 | Exam review checks pairs | sonnet-high-applier | 3, 4 | done |
| 9 | quiz:check report | sonnet-high-applier | 3, 4 | done |
| 10 | Client display and admin notice | sonnet-high-applier | 5, 7 | done |
| 11 | Codebook and docs | sonnet-high-applier | 1-10 | done |
| 12 | Verify (tests and regression; real-AI run needs the user) | sonnet-high-applier | 1-11 | partly done (tests and audit; real-AI run waits for the user) |

Run order: one step at a time, 1 to 12. After step 11: sonnet-high-auditor. Real-AI check (about 30 Gemini requests) only after the user says go.
