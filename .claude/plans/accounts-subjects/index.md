What: overview and shared rules. For: boss only.

# Accounts, one-device login, True/False, any-subject support

Approved by the user on 2026-10-30. Original plan: full.md (agents never read it).

## Goal
- Email + password signup/login fully replaces participant codes (hidden study ID P## stays linked to each account; export never has emails).
- One-device login: newest login wins with a "Continue here?" prompt; admin setting `session_timeout_seconds` (default 60, 30-1800); admin Sign out / Reset password.
- True/False quiz layout: `True or False` / `Question: <one statement>` / [True] [False]. No Yes/No, "Does this match?" or "Is this the answer?" anywhere.
- Any-subject support: lessons with formulas/numbers reach ready with readable Unicode math (no LaTeX shown), grounded cards, a sensible quiz.

## Where
- Work folder: D:\claude\pr2\Research_application_pr2_after_chapter_3 (branch feat/accounts, clone of GitHub main).
- FROZEN, never touch: D:\claude\pr2\Research_application_pr2 (real study data was collected there).
- Database starts empty. No migration of old P-codes.

## Do NOT touch (all steps)
- The old folder, real study data, any .env content (never print or commit it).
- Research export columns, except removing anything that would expose email.
- The admin PIN mechanism (`middleware/admin.js`, `X-Admin-Pin`).
- The Claude-import path (`prompts-haiku.js`, `claude-exchange.js`) unless a step says so.
- No commits, no pushes, no branch changes. The boss asks for commits later.

## User decisions (all follow the reasoner's recommendations unless noted)
- D1 concept true/false = question + suggested answer joined as one sentence; no AI rewrite.
- D2 math shown as Unicode text, no KaTeX, no new dependency.
- D3 only the lesson's own worked examples; no invented problems.
- D4 backup keeps `accounts`, drops `auth_sessions`.
- D5 emails stored in the DB; export stays pseudonymous; docs/consent wording updated later.
- D6 end reasons: signed_out, signed_out_elsewhere, signed_out_by_admin (switched kept as legacy).
- D7 timeout/sign-up settings are logged in `admin_events`.
- D8 `allow_signups` switch, default on. D9 plain HTTP on the LAN accepted. D10 P00 test login set by admin. D11 tokens never expire by time.
- D13 OPEN: Step 1 needs GOOGLE_API_KEY and ADMIN_PIN in the new folder's `.env` (user must fill; optional real teacher files in test-lessons/subjects/real/).

## Shared rules (paste into every applier brief)
- Plain JavaScript (ES modules), no TypeScript. Small focused files; one route file per feature.
- zod for every request body and AI JSON output. No secrets in code; config via `.env` / committed `.env.example`.
- Install: `npm ci` in the REPO ROOT only (npm workspaces). No new dependency unless the step says so; a dependency with an install script needs `npm install-scripts approve|deny`.
- Tests: `npm test` in `server/` (and client tests in `client/test`); every step's tests must be green before it is reported done.
- Every study route needs identity; new routes must be mounted through `mount()` in `server/src/app.js` and listed in the tables of `server/test/lesson-access.test.js`.
- Client CSS: tokens only (`client/src/styles/tokens.css`), no new colours or radii, targets 44px, mobile-first; nothing red means wrong in Light/Dark; wrong answers never rely on colour alone; motion via `useMotionReduced()` only.
- Students never see provider messages or study IDs. Export: UTF-8 BOM, CRLF, formula-prefix escaping; the codebook explains every column.
- `events.type` has a CHECK constraint: never add types there (use `lesson_events`).

## Steps
| # | Title | For | Depends on | Status |
|---|---|---|---|---|
| 1 | Subjects spike (needs API key) | sonnet-high-applier | none | built (see step file) |
| 2 | Auth data model and store | sonnet-high-applier | none | done (audited, fixes in) |
| 3 | Math text converter (pure) | sonnet-high-applier | none | done |
| 4 | True/False display (client) | sonnet-high-applier | none | built, tests green; visual check pending |
| 5 | Token auth in middleware | sonnet-high-applier | 2 | done (audited, fixes in) |
| 6 | Equations survive extraction | sonnet-high-applier | 3 | built, tests green; real-file check waits for Step 1 |
| 7 | Auth routes | sonnet-high-applier | 5 | done (audited, fixes in) |
| 8 | Math in AI replies and prompts | sonnet-high-applier | 3 | built, tests green; real-AI check waits for Step 1 |
| 9 | Client accounts screens + token | sonnet-high-applier | 7 | built, visual check pending |
| 10 | Math-aware grounding and quiz checks | sonnet-high-applier | 3 | built (see step file) |
| 11 | Remove X-Participant, migrate tests | sonnet-high-applier | 9 | built, audit with 12 |
| 12 | Admin accounts, test login, settings | sonnet-high-applier | 11 | built, audit + UI check pending |
| 13 | Backup, withdrawal, export, docs | sonnet-high-applier | 12, 4 | built |
| 14 | Subjects after-run, demo lessons | sonnet-high-applier | 1, 6, 8, 10 | todo |

Order: 2, 3, 4 first (no key needed), then 5, 6, 7, 8, 9, 10, 11, 12, 13; Step 1 as soon as the key is in `.env`; Step 14 last. One step per applier run. Audit: Step 2, 5, 7, 11, 12 (auth/user data) by opus-high-reasoner; UI steps 4, 9, 12 by sonnet-high-ui-checker; others by sonnet-high-auditor.
Cut order if late: Change password in Settings, header email chip, allow_signups switch, signup rate limiter, docx equation path, sameValue checks, font fallback. Never cut: 2, 5, 7, 9, 11, reset/sign-out in 12, Step 4, Steps 3 and 8, no-email export in 13.
