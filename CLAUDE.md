# StudyRevr

Open-source, mobile-first study app. Students upload a lesson (.docx / .pptx / .pdf); an AI generates a sectioned review, flashcards (Anki-style spaced repetition), and mock quizzes. Built for a Practical Research 2 study comparing traditional studying vs AI-assisted studying, so study activity must be logged and exportable.

## Stack
- Backend: Node.js (LTS) + Express, ES modules
- DB: SQLite via better-sqlite3 (single file, migrations on startup)
- Parsing: mammoth (docx), officeparser + jszip (pptx), unpdf (pdf). Reject .doc/.ppt with a clear "save as docx/pptx" message. Scanned/image-only PDFs are accepted but flagged with a warning (no OCR).
- `raw_text` format: blocks separated by a blank line, one paragraph per line inside a block. A block is a pptx slide or a PDF page (a paragraph that runs over a page seam stays whole, in the page it starts on); for docx every paragraph is its own block. Word count and the low-text warning are computed on this final text.
  - pptx slide block: slide text (bullets as `- item`, numbered as `1. item`, table rows as `a | b`), then SmartArt text read from `ppt/diagrams`, then, when the `include_speaker_notes` setting is true (default; `settings` table, no UI until Phase 7), a line `Notes:` followed by the speaker notes. Slides are emitted in deck order.
  - pdf: lines repeating on most pages (headers/footers/page numbers) are stripped; wrapped lines are reflowed into paragraphs, `word-`/`next` line-end hyphens are joined (hyphen kept), inline `»`/`•` bullets get their own line, and a page that starts lowercase after an unterminated sentence is merged into the previous paragraph.
- Uploads: multer, 20 MB limit, extension + MIME check + file signature check (zip `PK` for docx/pptx, `%PDF` for pdf)
- Validation: zod for all AI JSON output and request bodies
- Frontend: React + Vite, Recharts (charts), Motion (`motion` package, formerly Framer Motion) for animations
- Single repo: `/server` and `/client`, root scripts to run both in dev

## Conventions
- Plain JavaScript (no TypeScript) unless asked otherwise
- Keep files small and focused; one route file per feature
- No secrets in code; config via `.env` with a committed `.env.example`
- Mobile-first CSS, dark mode via `prefers-color-scheme` + manual toggle
- Respect `prefers-reduced-motion` (skip non-essential animations)
- Every AI call: strict "use only the provided lesson text" instruction, zod validation, one retry on invalid JSON, clear error surfaced to UI
- Every AI prompt that receives lesson text must explain that a `Notes:` line inside a slide block marks the teacher's spoken explanation of that slide: treat it as lesson content that elaborates the slide, not as a separate topic
- Long-running generation is async: create a job, frontend polls status

## AI Layer (provider-agnostic)
One adapter speaking the OpenAI-compatible `/v1/chat/completions` API. This covers NVIDIA NIM, Ollama (`/v1`), llama.cpp server, OpenRouter, and similar.
- Config: `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` (env defaults, overridable in Settings, stored in DB)
- Interface: `generateJSON({ system, user, schema })` → validated object
- Separate calls per feature (sections/summary, key terms, flashcards, quiz). Never one giant call.
- Chunk long lessons by paragraph (one line of `raw_text` = one paragraph), packing paragraphs up to the token budget so small local models (~8k context) work. Slide/page blocks and headings are soft boundaries: prefer to cut between blocks, never split a paragraph, and keep a slide's `Notes:` with its slide where it fits.
- Request JSON only; strip code fences before parsing

## Screens
Bottom tab bar: **Review | Flashcard | Mock Quiz | Stats**. Gear icon in header opens **Settings**. Home/upload is reachable from the header or an empty state.

### Upload
Drag-drop or pick file → progress states: Extracting → Summarizing → Flashcards → Quiz → Done. Accepts .docx, .pptx and .pdf. Warn if extracted text is very short (e.g. image-heavy slides); for PDFs with almost no text, warn that it looks scanned or image-only.

### Review
- Lesson list → lesson view
- Key points at top, estimated reading time
- Summary split into bite-sized sections with progress bar ("3/8 sections")
- After each section: 1–2 quick-check questions, tap to reveal answer
- Per section buttons: "Explain simpler" (ELI5 + everyday example) and "Filipino/Taglish" (re-explain). Generate on demand, cache in DB.
- Key terms glossary
- "View original text" toggle
- Resume where the student left off
- End card "What's next": study N due flashcards (~X min) → take quiz

### Flashcard (Anki-style)
- Row per lesson: name | Start | New / Learning / Due counts
- Study screen: front → tap to flip → Again / Hard / Good / Easy
- SM-2 scheduling. User-configurable: new cards/day (20), max reviews/day (200), learning steps (1m 10m).
- Hardcoded defaults: graduating interval 1d, easy interval 4d, starting ease 2.50, easy bonus 1.30, hard interval 1.20, relearning step 10m, min interval 1d, max interval 36500d
- Card flip animation

### Mock Quiz
- Row per lesson: name | Start | Highest score
- Default 20 multiple-choice questions, configurable in Settings (10 / 20 / 30 / 50)
- If the lesson is too short for the chosen count, generate fewer and tell the user ("This lesson supports ~12 questions"). Rough guide: 1 question per 100–150 words.
- Generate in batches of 5–10, passing earlier questions to avoid repeats; dedupe near-duplicates before saving
- **Retake**: same questions, question order and choice order shuffled, with a ~1–1.5s card-deck shuffle animation (Motion)
- **Regenerate quiz**: AI creates a new set, replaces old questions, keeps past attempts in Stats; uses a separate "AI is thinking" loading animation
- Results screen: score, each question with correct answer and explanation

### Stats
- Overview cards: study time today/this week, streak (days), cards due today, lessons uploaded/completed
- Charts (Recharts): study time per day (bar, 7/30 days), quiz score trend per lesson (line), flashcard state (donut: New / Learning / Mature), time per activity (Review vs Flashcard vs Quiz)
- Per-lesson drill-down: attempts, accuracy, time spent
- "Export CSV" of study sessions, quiz attempts, and flashcard reviews (for research analysis)

### Settings (gear icon)
- AI provider: presets (NVIDIA NIM, Ollama, llama.cpp, OpenRouter, Custom) that prefill base URL; API key; model; "Test connection"
- Quiz question count; flashcards per lesson; summary length (short / detailed); include speaker notes (`include_speaker_notes`, default on; applies to pptx uploads made after changing it)
- Flashcard: new cards/day, max reviews/day, learning steps
- Data: delete lesson, reset flashcard progress, export/import JSON backup
- About: version, GitHub link, license

## Data Model
- `lessons` (id, title, filename, raw_text, word_count, status, error, created_at)
- `jobs` (id, lesson_id, stage, status, error, updated_at)
- `sections` (id, lesson_id, position, title, content, simple_version, filipino_version, check_questions JSON)
- `key_points` (id, lesson_id, position, text)
- `key_terms` (id, lesson_id, term, definition)
- `review_progress` (lesson_id, last_section, completed_sections JSON, updated_at)
- `flashcards` (id, lesson_id, front, back, state, ease, interval, due_at, reps, lapses, step)
- `flashcard_reviews` (id, flashcard_id, rating, reviewed_at, prev_interval, new_interval)
- `quiz_questions` (id, lesson_id, question, choices JSON, answer_index, explanation)
- `quiz_attempts` (id, lesson_id, score, total, answers JSON, taken_at)
- `study_sessions` (id, lesson_id, tab, started_at, duration_sec)
- `settings` (key, value)

## API
- `POST /api/lessons` upload + start job
- `GET /api/lessons` / `GET /api/lessons/:id` / `DELETE /api/lessons/:id`
- `GET /api/lessons/:id/status`
- `POST /api/sections/:id/simplify` / `POST /api/sections/:id/translate`
- `PUT /api/lessons/:id/review-progress`
- `GET /api/lessons/:id/flashcards/due` / `POST /api/flashcards/:id/review`
- `GET /api/lessons/:id/quiz` (shuffled) / `POST /api/lessons/:id/quiz/attempt` / `POST /api/lessons/:id/quiz/regenerate`
- `POST /api/sessions`
- `GET /api/stats` / `GET /api/stats/export.csv`
- `GET /api/settings` / `PUT /api/settings` / `POST /api/settings/test-ai`
- `GET /api/backup` / `POST /api/backup`

## Build Phases
1. Repo scaffold, Express + SQLite + migrations, upload + parsing, lessons API
2. AI adapter, job pipeline, sections / key points / key terms generation
3. React app shell, tab bar, upload flow, Review tab
4. Flashcard generation + SM-2 + Flashcard tab
5. Quiz generation + attempts + shuffle animation + Mock Quiz tab
6. Session logging + Stats tab + CSV export
7. Settings, backup/import, polish, README, LICENSE (MIT)

Work one phase at a time. At the end of each phase: run it, fix errors, summarize what was built and how to test it, then stop.
