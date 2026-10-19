# StudyRevr

Open-source, mobile-first study app. Students upload a lesson (.docx / .pptx / .pdf); an AI generates a sectioned review, flashcards (Anki-style spaced repetition), and mock quizzes. Built for a Practical Research 2 study comparing traditional studying vs AI-assisted studying, so study activity must be logged and exportable.

The full original of this file (every detail, history and measurement) is in `docs/CLAUDE-full.md` for reference. Topic detail lives in `docs/*.md`, named per section below; read the doc before changing that area.

Work one phase at a time. At the end of each phase: run it, fix errors, summarize what was built and how to test it, then stop.

## Stack (detail: `docs/parsing-and-install.md`)
- Node.js (LTS) + Express, ES modules; SQLite via better-sqlite3, migrations on startup; zod for every AI JSON output and request body.
- React + Vite client; animations with `motion`; Stats drawn in CSS (no chart library). Repo: `/server`, `/client`, root scripts run both.
- Parsing: mammoth (docx), officeparser + jszip (pptx, `server/src/services/pptx.js`), unpdf (pdf). Reject .doc/.ppt ("save as docx/pptx"); image-only PDFs accepted with a warning (no OCR).
- `raw_text`: blocks split by a blank line, one paragraph per line; block = slide / PDF page / docx paragraph. Word count and low-text warning use the final text. Exact pptx/pdf line rules (bullets, `Notes:` speaker notes, SmartArt, header stripping, reflow) are in the doc.
- Uploads: multer, 20 MB, extension + MIME + signature (`PK` / `%PDF`) + document part check.
- **Install: `npm ci` in the repo root only** (npm workspaces; `npm ci` in a workspace wipes root `node_modules`). Don't commit lockfile churn from npm 10 (drops `libc`). Keep `overrides` (`shell-quote` ^1.12.0) and `allowScripts` (better-sqlite3 approved, tesseract.js denied). A new dependency with an install script needs `npm install-scripts approve|deny <pkg>`, then `npm install-scripts ls` must show none unreviewed.

## Conventions
- Plain JavaScript (no TypeScript) unless asked. Small focused files; one route file per feature.
- No secrets in code; config via `.env` with a committed `.env.example`.
- Mobile-first CSS; dark mode via `prefers-color-scheme` + manual toggle.
- Long-running generation is async: create a job, frontend polls status.

### Look and motion (detail: `docs/design-and-motion.md`; tokens `client/src/styles/tokens.css`, mockups `design/`, `design/motion/`)
- A study journal: plain page with a margin column (`--mw`, `--mgap` ≥ 20px) holding the numbers that matter (`.mnote`, `.hang`); margin hairline (`.main::before`) only on pages whose margin holds numbers (`:has()` list in `shell.css`).
- Use tokens only: one small radius `--r-sm`, cards `--r-lg` + `--card-shadow` (+ `--card-edge` deck edges); primary buttons `--ink-btn` / `--on-ink-btn` / `--ink-btn-press`; every control edge `--control-border` (≥ 3:1); rules only under list rows; highlighter `.mk`; learning counts `--learn`; text links `--link`, always underlined, ≥ 4.5:1. No new colours or radii.
- Themes Light / Dark / AMA / AMA Dark. **Nothing red means wrong** in Light/Dark. In AMA red is the brand ("go": titles, margin line, header rule, primary buttons, links, the quiz teacher's-pen strike/X) and nowhere else: never an error, "Again" or a status. `--danger` only for admin-only destructive buttons; destructive buttons are outlines with trash icon + word (`.btn--destroy`), never primary-looking. Blue = focus rings / active nav (gold ring in AMA Dark); gold only a fill behind dark text.
- Wrong answers never rely on colour: keep the icon and strike shape; "Again"/errors use `--ink-2` / `--learn` + icon + word.
- Pinned bars: paper background, one top hairline, no frame. Wide screen: inside `--book-max`; respect `--safe-*` insets. Reader (`.lesson-view`) uses a slim 14px margin; desk/sheet from 56rem. Targets 44px.
- Motion: transform/opacity only (plus `stroke-dashoffset`), each < ~600 ms (deck coming out excepted), skippable by a tap, never blocking input; reduced motion = off or a plain fade.
- **`useMotionReduced()` (`client/src/lib/motion.js`) is the only source** for animation decisions (never `matchMedia` or motion's `useReducedMotion`); `MotionConfig` uses it. CSS: `@media (prefers-reduced-motion) { :root:not([data-motion='full']) … }` plus `:root[data-motion='less'] …`. Motion and theme settings are per device (localStorage), applied before first paint (`client/index.html`, kept in step by `client/test/theme.test.js`); no saved theme = AMA.
- **Answer time excludes animation and time away** (`client/src/lib/answerClock.js`, `hooks/useAnswerClock.js`): starts when usable or at first input, pauses on flip and when hidden; a flashcard can't be rated until `onTurned` (1.5 s fallback); same events → same `time_ms` under any motion setting (`client/test/clockScreens.test.js`). Never let motion settings touch the clock.

### AI rules (detail: `docs/ai-layer.md`)
- Every AI call: strict "use only the provided lesson text", zod validation, one retry on invalid JSON, request JSON only and strip code fences, clear error to the UI. Interface: `generateJSON({ system, user, schema })`.
- Separate calls per feature, never one giant call; stages in order (sections, key points, key terms, flashcards, quiz options, quiz review), parallel within a stage up to concurrency.
- Every prompt with lesson text explains that a `Notes:` line is the teacher's spoken explanation of that slide (lesson content, not a new topic).
- Content uses the lesson's own words: `KEEP_MEANING`, `NO_OBJECTIVES`, `ASK_BY_MEANING`, `RESTATE_ONLY` in `server/src/ai/prompts.js`. No invented causes/links between listed items, no rewording into new ideas, no content from learning objectives.
- Chunk by paragraph up to the token budget; prefer cutting between blocks, never split a paragraph, keep `Notes:` with its slide.
- Provider errors → actionable messages (`server/src/ai/client.js`); provider bodies logged server-side with keys redacted, never shown in the UI. **Students never see a provider message or a pointer to Settings.**
- Default provider Google AI Studio, model `gemini-3.5-flash-lite` (free tier 500 req/day, 15/min, 250K tokens/min); presets in `server/src/ai/providers.js`, per-model tuning in preset `models`, client rate limit `server/src/ai/ratelimit.js` (20% of slots kept for live calls). Model resolution: request > Settings > `.env` `AI_MODEL` > preset default; model list filtering in `server/src/ai/models.js`, free-text id always accepted.
- **Keys:** per provider (`.env` or `ai_api_key:<provider>`); only the active provider's key is sent; never logged, returned, exported or backed up (backup excludes `ai_api_key:*` and `participant_ai_keys`). Every key delete runs `wipeDeletedKeys` (`services/student-ai.js`: `secure_delete` + `wal_checkpoint(TRUNCATE)`).
- Thinking for lesson processing: setting `lesson_thinking`, default Low; only processing calls think (wrapped in `pipeline/run.js`); live calls, Prepare, quiz fallback, Regenerate, Test connection never do.
- **Live calls** (Explain simpler, Taglish; `server/src/ai/live.js`, `services/live-rewrite.js`): fallback chain student key → admin Default → Gemma → plain student error; need a participant; only Default answers become the shared cached version; every request writes an `ai_calls` row. Lesson processing never uses the chain, a student key or Gemma.
- Key terms, cards and quick checks carry an `evidence` quote checked in code against `raw_text`; ungrounded items are dropped. Sections follow the lesson (`sectionRange`, `server/src/pipeline/generate.js`).

## Participants, sessions, admin (detail: `docs/participants-sessions.md`, `docs/admin.md`)
- Shared host over Wi-Fi: `npm run study`. Students type a participant code (`P` + 1-3 digits, normalised); codes are created only in admin; P00 is the researcher's test data and never shown.
- **Every study request sends `X-Participant`**; `server/src/middleware/participant.js` answers 401 without a listed code.
- Shared: lessons, sections and cached rewrites, key points/terms, cards, `quiz_distractors`. Per participant: schedules, reviews, limits, quiz attempts, progress, sessions, events, stats.
- Sessions (`client/src/lib/session.js`, `hooks/useStudySession.js`, `server/src/sessions/store.js`): active time only, 5 min idle ends, hidden pauses, 30 s heartbeat. `study_date` uses the 04:00 Asia/Manila day (`server/src/stats/days.js`).
- Setting changes go to `setting_events`; new lesson event types go to `lesson_events` (`events.type` has a CHECK constraint: don't add types there).
- **Admin** (`#/admin`, `ADMIN_PIN` in `.env`; empty = 403 `admin_off`): `server/src/middleware/admin.js` (constant-time compare, lockout after 5 wrong PINs). Behind the PIN: all of `/api/admin`, `/api/settings/*`, lesson upload/retry/delete as teacher, make cards, quiz-options, section-versions, share. **The client sends `X-Admin-Pin` only on calls flagged `{ admin: true }` in `client/src/lib/api.js`** (`client/test/api.test.js` classifies every function); `lockAdmin()` on Switch participant and on leaving admin routes.
- Admin screens make no study records; the lesson preview (`AdminLessonScreen.jsx`) makes no AI call. Students see no upload/delete/retry/make-cards controls beyond their own uploads.
- **A lesson with records from any participant other than P00 can't be deleted, rebuilt or have cards regenerated** (409 `lesson_has_records`; `services/lesson-records.js`).
- Withdrawal: `npm run participant:delete -- P07`. Backup `GET /api/admin/backup` (strips keys); restore `npm run restore -- <file>` (refuses while a server runs).

## Student uploads (detail: `docs/student-uploads.md`)
- Off by default (`allow_student_uploads`, `student_uploads_per_day` 2). Origin `admin` | `student`; visibility is one rule, `visibleSql` / `visibleLesson` in `server/src/services/lesson-access.js`, failing closed.
- **Another student's private lesson is 404 "Lesson not found." (never 403) on every route that reaches a lesson.** `test/lesson-access.test.js` walks the live router stack: mount every router through `mount()` in `server/src/app.js` and add new routes to its tables.
- The original file is never stored; students never receive the file name or an owner's code; failures show plain messages (`lesson-access.js` constants); same pipeline with the admin Default only. Exports retitle uploads `Student upload <id>` (`server/src/export/titles.js`).

## Content pipeline, review, flashcards, quiz (detail: `docs/review.md`, `docs/flashcards.md`, `docs/quiz.md`)
- Review: key points, sections with progress, 0-2 grounded quick checks per section (`server/src/pipeline/quick-checks.js`, reviewed in `services/check-review.js`), Explain simpler / Taglish on demand and cached (Taglish only while `show_taglish` is on), key terms, original text, resume, end card.
- Flashcards: SM-2 (`server/src/flashcards/scheduler.js`, pure, takes `now` + config; defaults `server/src/flashcards/config.js`), study day 04:00 Asia/Manila, one daily budget across lessons, seeded fuzz. `recordAnswer` (`flashcards/study.js`) refuses early reviews (409 `not_due`) and new cards over the limit (409 `new_limit`).
- Card rules: every card has a grounded quote; leak rules g, i, j, k, l, m (`server/src/quiz/leaks.js`; h is info only); every list item gets a card (`quiz/list-items.js`); nothing from learning-objective blocks; cap `flashcards_max` (30).
- Quiz: built in code from cards (`server/src/quiz/build.js`, pure, seeded), up to 10 questions, ≥ 2 cards; term / list-item / concept question rules, leak rules a-f, related terms never offered against each other (`quiz/related.js`), trailing punctuation normalised, only clean forms asked. Wrong answers are made in the `quiz_options` stage (`quiz/distractors.js`), reviewed by the AI exam review (`services/quiz-review.js`, flags in `quiz/review-flags.js`). Failures of those stages leave the lesson ready. Quiz results never touch flashcard scheduling.
- Yes/No display and capitals are display only: stored and exported values stay True/False and unchanged.

## Stats, export, settings (detail: `docs/stats-export-settings.md`)
- Stats per participant (`server/src/stats/participant.js`); series colours from tokens, never colour alone; every value also written out.
- Research export (admin): only study tables, never `settings`, keys or PIN; UTF-8 BOM, CRLF, formula-prefix escaping; P00 left out unless `include_p00`; the codebook (`README.txt`) explains every file and column.

## Data model and API (detail: `docs/data-model.md`, `docs/api.md`)
Tables, columns, migrations and every endpoint are listed there.

## Commands
- `npm ci` (root) · `npm run study` (build + serve on LAN) · `npm test` (in `server/`)
- `npm run pipeline -- --thinking=minimal|low|medium|high` · `npm run quiz:check [-- --lesson <id> --db <file>]` (read-only; run before the study: "Clean questions available: N of 10")
- `npm run lesson:rebuild -- <id>` · `npm run lesson:export -- <id> <folder>` / `npm run lesson:import -- <folder> [--as-new] [--yes]` (detail: `docs/claude-import.md`)
- `npm run participant:delete -- P07` · `npm run restore -- <file>`
- Rebuild, import and restore refuse while a server runs (`services/server-check.js`).

## History
Build phases, branches, measurements and open audit findings: `docs/history.md` (measurements also in `docs/ai-layer.md` and `docs/claude-import.md`).
