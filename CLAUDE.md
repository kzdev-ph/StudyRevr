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
- Provider errors become actionable messages (`server/src/ai/client.js`): 400 check the model in Settings (unless the body says the key is invalid, as Google's does: then the key), 401/403 check the API key in Settings, 404 model or base URL, 429 rate limited, try again shortly, timeout the provider is slow, retry. The provider's own error body is logged server-side with keys redacted and never shown in the UI.
- Every AI prompt that receives lesson text must explain that a `Notes:` line inside a slide block marks the teacher's spoken explanation of that slide: treat it as lesson content that elaborates the slide, not as a separate topic
- Long-running generation is async: create a job, frontend polls status

## AI Layer (provider-agnostic)
One adapter speaking the OpenAI-compatible `/v1/chat/completions` API. This covers Google Gemini, NVIDIA NIM, Ollama (`/v1`), llama.cpp server, OpenRouter, and similar.
- **Default provider: Google AI Studio** (Gemini, OpenAI-compatible endpoint, free tier ~15 requests/min). Key in `.env` as `GOOGLE_API_KEY`.
- **Presets** (`server/src/ai/providers.js`): `google` (default), `nvidia-nim`, `openrouter`, `ollama`, `llamacpp`, plus `custom`. A preset is a base URL, default model, chunk tokens, concurrency, temperature (0.2), the `.env` key name and whether `response_format` json_schema is supported. Google: ~30000-token chunks, concurrency 2, json_schema on. The other presets keep small-model chunking (2400 tokens). Default model: `gemini-3.5-flash-lite` (id confirmed from Google's `/models`; a `models/` prefix is always stripped).
- **Model resolution order, per provider:** one-off request value (e.g. test-ai body) > Settings (`settings` table) > `.env` (`AI_MODEL`) > preset default. The model is never fixed: `GET /api/settings/models` lists the provider's chat models (embedding, image, video, TTS, live/audio, ASR, rerank etc. are filtered out) and a free-text model id is always accepted if `/models` fails or is empty. The active provider and each provider's last model are saved separately (`ai_provider`, `ai_model:<provider>`), so switching providers restores that provider's model.
- **Keys are per provider:** `GOOGLE_API_KEY`, `NVIDIA_API_KEY`, `OPENROUTER_API_KEY` in `.env`, or saved in Settings (`ai_api_key:<provider>`). Only the active provider's key is ever sent. The API returns only a "key set: yes/no" flag; keys are never logged or returned, and a backup export must exclude `ai_api_key:*`. The SQLite file holds saved keys, so it is git-ignored.
- Optional `.env` overrides `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, `AI_EXTRA_BODY` (JSON merged into the request body, zod-validated, ignored if invalid) apply only to the `.env` provider (`AI_PROVIDER`). Tuning: `AI_CONCURRENCY`, `AI_CHUNK_TOKENS`, `AI_TEMPERATURE`, `KEY_TERMS_MAX`.
- Calls within one pipeline stage run in parallel up to the concurrency limit; stages stay in order (sections, key points, key terms, flashcards). 429/5xx/network errors retry with growing, jittered waits (Retry-After honored: header in seconds or a date, or Google's `retryDelay` in the body; at most 60 s). Request timeout is a preset value (`AI_TIMEOUT_SECONDS` overrides): Google 60 s, every other preset 300 s; a timed-out request is retried once. The reply body is read inside the timed attempt, so a stalled body is a timeout too.
- **Per-model tuning** (preset `models`): `{ timeoutMs, requestsPerMinute }` replace the preset's for that model id. Google `gemini-3.5-flash-lite`: 25 s timeout, 15 requests/min. `requestsPerMinute` is a client-side limit per host + model (`server/src/ai/ratelimit.js`) that every HTTP attempt takes a slot from, retries included; under it, a 429's Retry-After holds every call to that model.
- **Attempt log:** the client reports every HTTP attempt to `onAttempt` (`throttle` / `start` / `ok` / `fail`, failure reason `timeout` | `rate_limit` | `server` | `network` | `http_<status>`). The server logs each as `[ai] ...`, `npm run pipeline` prints them with times, and `stats` counts attempts, failures and retries by reason (timeouts included).
- **Grounded key terms:** each key term comes with an `evidence` quote (at most 25 words) copied from the lesson. In code the quote must exist in the lesson text (case, spacing, punctuation and line-end hyphens ignored) and must say more than the term or a title; otherwise the term is dropped and logged. Evidence is stored in `key_terms.evidence` for the Review UI. Key terms are domain concepts only (no list-item examples or evaluative phrases), de-duplicated across chunks (case- and plural-insensitive, in code), at most `KEY_TERMS_MAX` (12) per lesson.
- **Key-terms merge:** a lesson split into several chunks gets one extra call (`the merged key terms`) after the per-chunk calls. It receives every candidate term with its definition/evidence versions and returns only candidate numbers (and which version): it can drop evaluative phrases, examples, weak terms and synonyms and pick the best version, but cannot add terms or write evidence. The grounding check runs again afterwards against the whole lesson. An unusable reply keeps all candidates (capped) rather than erasing the terms. Single-chunk lessons skip the call.
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
- Defaults (code, each overridable by a `settings` row; see `server/src/flashcards/config.js`): graduating interval 1d, easy interval 4d, starting ease 2.50, easy bonus 1.30, hard interval 1.20, relearning step 10m, lapse new interval 0 (then min 1d), min interval 1d, max interval 36500d
- The study day starts at 04:00 Asia/Manila. Daily limits are one budget across all lessons ("All lessons" is the parent deck). Queue order: due (re)learning cards, due reviews, new cards (lesson order); learn ahead 20 min when nothing else is left.
- Intervals are fuzzed like Anki (±25/15/5%), from a seeded generator (seed = card id + reps), so the interval on a button is exactly what the card gets and tests are deterministic. The scheduler (`server/src/flashcards/scheduler.js`) is pure: it takes `now` and the config.
- Card generation is the pipeline's `flashcards` stage (also `POST /api/lessons/:id/flashcards/generate` for a lesson with no cards; the lesson stays ready while it runs). Term cards come from the grounded key terms; concept Q → A cards come from one AI call per chunk (the chunk's review sections as a guide). Every card has an `evidence` quote checked in code like key terms; answers over 40 words (prompt asks ≤ 25) are dropped; cards are de-duplicated against each other (term cards win). About one card per 50 words, at least 5, at most `flashcards_max` (30); term cards take at most half.
- Card flip animation (Motion, 3D; cross-fade under reduced motion). Space flips, 1-4 answer, U / Ctrl+Z undo (multi-level within a session). "From the lesson: …" evidence under the answer. Done state says when the next card is due.

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
- AI provider: presets (Google Gemini (default), NVIDIA NIM, OpenRouter, Ollama, llama.cpp, Custom) that prefill base URL; per-provider API key (shown only as set / not set); model picker fed by `GET /api/settings/models` with a free-text fallback; "Test connection" tests the provider + model in the form before saving
- Quiz question count; flashcards per lesson; summary length (short / detailed); include speaker notes (`include_speaker_notes`, default on; applies to pptx uploads made after changing it)
- Flashcard: new cards/day, max reviews/day, learning steps
- Data: delete lesson, reset flashcard progress, export/import JSON backup
- About: version, GitHub link, license

## Data Model
- `lessons` (id, title, filename, raw_text, word_count, status, error, created_at, source_kind, source_numbers JSON, source_total)
  - `source_numbers[k]` is the real slide / page number (Word: paragraph number) of the k-th block of `raw_text`, `source_kind` is `slide` | `page` | `paragraph` and `source_total` the real count. A slide or page with no text has no block, so a block's place in `raw_text` is not its slide number. NULL on lessons uploaded before migration 005.
- `jobs` (id, lesson_id, stage, status, error, updated_at)
- `sections` (id, lesson_id, position, title, content, simple_version, filipino_version, check_questions JSON, sources JSON)
  - `sources` is the sorted list of slide / page numbers the section was written from. The sections prompt labels each block (`[Slide 3]`) and asks the model for `sources`; in code each number must be a whole number within `source_total` and the number of a block that was in that call's chunk, anything else is dropped and logged, and if nothing is left it is NULL. Original text shows exactly those slides / pages; NULL (older lessons) falls back to a vocabulary match in the client, labelled approximate.
  - `simple_version` stores JSON `{ text, example }`, `filipino_version` stores JSON `{ title, content, check_questions }`; both are made on demand and cached here, the original `content` is never changed.
  - `review_progress.last_section` and `completed_sections` are 0-based indices into the lesson's sections in order.
- `key_points` (id, lesson_id, position, text)
- `key_terms` (id, lesson_id, term, definition, evidence)
- `review_progress` (lesson_id, last_section, completed_sections JSON, updated_at)
- `flashcards` (id, lesson_id, front, back, state, ease, interval, due_at, reps, lapses, step, kind, evidence, position)
  - state 0 new / 1 learning / 2 review / 3 relearning; `kind` `term` | `concept`; `position` is the new-card order within the lesson; `interval` in days.
- `flashcard_reviews` (id, flashcard_id, rating, reviewed_at, prev_interval, new_interval, state, ease, time_ms, snapshot)
  - one row per answer: rating = button (1 Again … 4 Easy), `state` before the answer (daily limits count it), `ease` after, intervals in days (a learning step is a fraction of a day), `snapshot` = the card's scheduling fields before the answer (for undo; undo deletes the row).
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
- `GET /api/flashcards/decks` / `GET /api/flashcards/due` (All lessons) / `POST /api/flashcards/reviews/:id/undo` / `POST /api/lessons/:id/flashcards/generate`
- `GET /api/lessons/:id/quiz` (shuffled) / `POST /api/lessons/:id/quiz/attempt` / `POST /api/lessons/:id/quiz/regenerate`
- `POST /api/sessions`
- `GET /api/stats` / `GET /api/stats/export.csv`
- `GET /api/settings` / `PUT /api/settings` / `POST /api/settings/test-ai`
- AI settings (backend done in Phase 2.5): `GET /api/settings/ai` / `PUT /api/settings/ai` (active provider, per-provider model/URL/key; keys never returned), `GET /api/settings/models?provider=`, `POST /api/settings/test-ai` (tests the provider + model in the body without saving)
- `POST /api/lessons/:id/retry` (re-run a failed lesson; finished stages are kept)
- `GET /api/backup` / `POST /api/backup`

## Build Phases
1. Repo scaffold, Express + SQLite + migrations, upload + parsing, lessons API — **done**
2. AI adapter, job pipeline, sections / key points / key terms generation — **done** (incl. Phase 2.5: provider presets with Google as default, parallel chunk calls, model selection, grounded key terms)
3. React app shell, tab bar, upload flow, Review tab — **done** (incl. `POST /api/sections/:id/simplify|translate` and review-progress save/load)
4. Flashcard generation + SM-2 + Flashcard tab — **done**
5. Quiz generation + attempts + shuffle animation + Mock Quiz tab
6. Session logging + Stats tab + CSV export
7. Settings, backup/import, polish, README, LICENSE (MIT)

Work one phase at a time. At the end of each phase: run it, fix errors, summarize what was built and how to test it, then stop.
