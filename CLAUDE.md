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
- Calls within one pipeline stage run in parallel up to the concurrency limit; stages stay in order (sections, key points, key terms, flashcards, quiz options). 429/5xx/network errors retry with growing, jittered waits (Retry-After honored: header in seconds or a date, or Google's `retryDelay` in the body; at most 60 s). Request timeout is a preset value (`AI_TIMEOUT_SECONDS` overrides): Google 60 s, every other preset 300 s; a timed-out request is retried once. The reply body is read inside the timed attempt, so a stalled body is a timeout too.
- **Per-model tuning** (preset `models`): `{ timeoutMs, requestsPerMinute }` replace the preset's for that model id. Google `gemini-3.5-flash-lite`: 25 s timeout, 15 requests/min. `requestsPerMinute` is a client-side limit per host + model (`server/src/ai/ratelimit.js`) that every HTTP attempt takes a slot from, retries included; under it, a 429's Retry-After holds every call to that model.
- **Attempt log:** the client reports every HTTP attempt to `onAttempt` (`throttle` / `start` / `ok` / `fail`, failure reason `timeout` | `rate_limit` | `server` | `network` | `http_<status>`). The server logs each as `[ai] ...`, `npm run pipeline` prints them with times, and `stats` counts attempts, failures and retries by reason (timeouts included). `npm run pipeline` also wraps the process's `fetch` (`server/src/ai/netlog.js`) to log and count every HTTP request from any code and flags a mismatch with the client's count, reports event-loop stalls, and the flashcards stage logs its time split (AI calls / checks and de-duplication / saving).
- **Grounded key terms:** each key term comes with an `evidence` quote (at most 25 words) copied from the lesson. In code the quote must exist in the lesson text (case, spacing, punctuation and line-end hyphens ignored) and must say more than the term or a title; otherwise the term is dropped and logged. Evidence is stored in `key_terms.evidence` for the Review UI. Key terms are domain concepts only (no list-item examples or evaluative phrases), de-duplicated across chunks (case- and plural-insensitive, in code), at most `KEY_TERMS_MAX` (12) per lesson.
- **Key-terms merge:** a lesson split into several chunks gets one extra call (`the merged key terms`) after the per-chunk calls. It receives every candidate term with its definition/evidence versions and returns only candidate numbers (and which version): it can drop evaluative phrases, examples, weak terms and synonyms and pick the best version, but cannot add terms or write evidence. The grounding check runs again afterwards against the whole lesson. An unusable reply keeps all candidates (capped) rather than erasing the terms. Single-chunk lessons skip the call.
- Interface: `generateJSON({ system, user, schema })` → validated object
- Separate calls per feature (sections/summary, key terms, flashcards, quiz). Never one giant call.
- Chunk long lessons by paragraph (one line of `raw_text` = one paragraph), packing paragraphs up to the token budget so small local models (~8k context) work. Slide/page blocks and headings are soft boundaries: prefer to cut between blocks, never split a paragraph, and keep a slide's `Notes:` with its slide where it fits.
- Request JSON only; strip code fences before parsing

## Screens
Bottom tab bar: **Review | Flashcard | Mock Quiz | Stats**. Gear icon in header opens **Settings**; beside it a chip shows the participant code in use. Lesson upload lives in **Admin** (Phase 6); the Review tab lists lessons only.

### Participants (Phase 6)
- The app is used by several students on one shared host over local Wi-Fi (`npm run study`: builds the client and the API server serves `client/dist` on one port; it prints the LAN addresses). Every student studies the same lessons.
- On open, a code screen (`ParticipantScreen.jsx`, type-only: no list, no suggestions, P00 never shown) asks for a participant code. `GET /api/participants/:code` checks it; an unknown code shows "That code isn't on the list. Check with your teacher." Codes are normalised (`p7`, `P 7`, `P007` → `P07`; `P` + 1-3 digits). The code is kept in localStorage until **Settings › Switch participant**.
- Codes are created only in admin (`POST /api/admin/participants { codes: "P01-P10, P12" }`); there is no public list or create route. Migration 008 creates `P00` and gives it every record made before it (the researcher's test data).
- Every study request sends `X-Participant`; the server (`server/src/middleware/participant.js`) answers 401 `participant_required` / `participant_unknown` without a listed code, and the client then shows the code screen again.
- Shared by everyone: lessons, sections (and their cached rewrites), key points/terms, flashcards (the cards), `quiz_distractors`. Per participant: flashcard schedule (`flashcard_progress`), `flashcard_reviews`, daily new/review limits, quiz attempts and answers (resume, retake, previous best), review progress, sessions, events, stats.
- Withdrawal: `npm run participant:delete -- P07` (`server/scripts/delete-participant.js`) shows the rows per table, asks for the code again (`--yes` skips), deletes the participant row (everything cascades), then `secure_delete` + `VACUUM` + WAL checkpoint so nothing can be read back. Lessons stay.

### Session logging and events (Phase 6)
- A study session starts when a participant opens a lesson's Review (`reading`, any of its views), a flashcard deck (`flashcards`; the All lessons deck has lesson NULL) or the Mock Quiz (`quiz`). `client/src/lib/session.js` (pure, fake-clock tested) + `hooks/useStudySession.js`:
  - only active time counts: interactions are pointerdown, keydown, wheel, touchstart, scroll;
  - 5 min without interaction ends the session at the last interaction (`idle`; the idle minutes are not counted), the next interaction starts a new one;
  - `visibilitychange` hidden pauses the clock and sends the time at once (fetch keepalive); back within 5 min carries on, after longer the session ended when the app went away (`background`) and a new one starts;
  - heartbeat every 30 s (counting only up to the last interaction), `left` when the screen closes, `switched` on Switch participant.
- Server (`server/src/sessions/store.js`): `active_ms` only grows and never exceeds the time since the start; a session with no report for 5 min reads as `unclosed`, ended at its last report.
- Self-monitoring events (`events`): `stats_view` (the app, once per Stats open; never from the admin view), `quiz_retake` (the server, when a retake starts), `review_flashcards_tap` (quiz results link), `section_simplify` / `section_translate` (every tap that opens that rewrite, cached or not, with `section_index`).
- Every `study_date` uses the flashcard day: 04:00 Asia/Manila (`server/src/stats/days.js`, built on the scheduler's `studyDay`). A study week runs Monday 04:00 to Monday 04:00.
- Planning metric (`server/src/stats/planning.js`, pure): for each due review of a review-state card (learning steps don't count), the due day comes from the answer's `snapshot.due_at`: answered that study day `on_time`, later `late` with `days_late`; not answered after its due day `still_overdue`; due today and not done yet is not counted.

### Admin (Phase 6)
- `#/admin`, reached from Settings or the code screen. `ADMIN_PIN` in `.env` (empty: admin off, 403 `admin_off` everywhere). The client sends `X-Admin-Pin` (kept in sessionStorage after `POST /api/admin/unlock` accepts it); the server compares digests in constant time (`server/src/middleware/admin.js`); missing/wrong PIN 401 `admin_pin`; 5 wrong PINs from one address lock it for 60 s (429).
- Behind the PIN: everything under `/api/admin`, plus upload / retry / delete of lessons, `POST /api/lessons/:id/flashcards/generate`, and all of `/api/settings/*`. Section rewrites and the quiz's fallback wrong-answer call stay open (studying).
- Screen: **Participants** (add codes; summary table; a code opens `#/admin/participants/P03`, that participant's StatsView), **Research export**, **Lessons** (upload zone, list with delete; retry on the lesson's processing page; per lesson a quiz-answers retry button when that step failed or was never made). Students see no upload, delete, retry or Make cards ("Cards aren't ready yet").
- **Lesson delete is blocked** (409 `lesson_has_records`, `records` counts in the body) once a participant other than P00 has flashcard answers, quiz attempts/answers, study sessions or events on the lesson. The message says what deleting would do: remove their flashcard answers and quiz attempts (with answers), and cut their sessions and events off from the lesson (those rows stay, `lesson_id` goes NULL). P00 records do not count and go with the lesson. There is no override: a lesson becomes deletable only when those records are gone.

### Upload
Drag-drop or pick file → progress states (admin's processing page): review sections → key points → key terms → flashcards → quiz answers → done. Accepts .docx, .pptx and .pdf. Warn if extracted text is very short (e.g. image-heavy slides); for PDFs with almost no text, warn that it looks scanned or image-only.

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
- Row per lesson: name | Start | best finished score and number of attempts (`GET /api/quiz`). Lessons still preparing, without flashcards, or with only one card say why instead of Start.
- Questions come from the lesson's existing flashcards (no new grounding), built in code when a quiz starts (`server/src/quiz/build.js`, pure, seeded `random` in tests): up to 10 questions, one per card, cards picked at random; fewer if the lesson has fewer usable cards ("This lesson supports 6 questions"). A quiz needs at least 2 cards.
  - **Term card**: multiple choice "which term matches this definition?"; the 3 wrong options are other key terms of the same lesson (term cards, then `key_terms` without a card; plural-insensitive), no AI call. Fewer than 3 other terms: true / false.
  - **Concept card**: multiple choice with 3 AI-made wrong answers. Fewer than 3 saved: true / false, whose false statement is a saved wrong answer or, with none, another card's answer from the same lesson.
  - About 3 in 10 questions are true / false (choices `True` / `False`) for variety even when every card could be multiple choice. Multiple-choice options are shuffled silently.
- **Wrong answers** (`server/src/quiz/distractors.js`): made as the last step of lesson processing (the pipeline's `quiz_options` stage, after flashcards; the lesson stays `processing` until it ends, so students never wait on the AI when starting a quiz). The AI is asked (existing adapter, rate limiter, zod, one JSON retry) for 3 wrong answers per concept card, in batches of at most 15 cards so each call stays under the 25 s timeout; batches run up to the provider's concurrency. The prompt gets each card's question, answer and evidence quote, uses only that lesson content, explains `Notes:`, and asks for wrong answers similar in length and style to the correct one. In code, wrong answers that match the correct answer or each other (case-insensitive, trimmed) or run over 40 words are dropped. Saved in `quiz_distractors` and reused; a batch that fails is not saved. **Failure of this stage does not fail the lesson:** the job records `quiz_options` / `failed` with the message, the lesson is `ready`, and admin gets a retry button (`POST /api/lessons/:id/quiz-options`, also used to fill in lessons made before the stage existed; only cards still without wrong answers are asked for). **Fallback:** starting a quiz still calls `ensureDistractors` for any card without them, so the quiz starts either way (with a notice and true / false questions if that fails too). `ensureDistractors` is shared per lesson: the stage, a retry and quiz starts that overlap wait for one AI call.
- Untimed. Time per question (`time_ms`, capped at 1 h) and total time (`duration_ms`) are recorded. Quiz results never touch flashcard scheduling or `flashcard_reviews`.
- Screen (`#/quiz/:lessonId`): "Getting your quiz ready" (after 2.5 s: "The AI is thinking up answer options…"), then a ~1.2 s deck-shuffle animation (Motion; cross-fade under reduced motion; tap to skip), then one question at a time with a progress bar. After each answer: correct / not quite, the right answer and the card's "From the lesson: …" evidence; Next sits in the pinned action bar. Keys: 1-4 answer (1-2 on true / false), Enter next. Focus moves to each new question, then to Next (described by the feedback), then to the results heading.
- Results: score, percent, time, comparison with the best earlier score, the missed questions (your answer, right answer, evidence), **Retake** (same questions, new question order and option order, shuffle again) and **Back to lesson**. The Flashcards done card's main action is "Take the mock quiz".
- Tables (migration 007):
  - `quiz_distractors` (flashcard_id PK → flashcards ON DELETE CASCADE, choices JSON of 0-3 wrong answers, made_at)
  - `quiz_attempts` gains `started_at`, `finished_at` (NULL for a quiz left part-way), `duration_ms`, `retake_of` (the attempt whose questions it reused; NULL for a fresh quiz). `score` is final once finished.
  - `quiz_answers` (id, attempt_id → quiz_attempts ON DELETE CASCADE, position, flashcard_id ON DELETE SET NULL, type `mc`|`tf`, kind `term`|`concept`, question, statement (tf), choices JSON, answer_index, answer_text, evidence, chosen_index, correct, time_ms, answered_at): one row per question, written at start and filled in when answered; a full copy, so it outlives card changes. Phase 6 reads it.
  - `quiz_questions` (001) is unused: questions are built from flashcards per attempt.
- **Resume:** `POST /api/lessons/:id/quiz/attempts` without `retake_of` returns the lesson's newest unfinished attempt if it started less than 2 hours ago (200, `resumed: true`, `next_position` = first unanswered question or `null` when all are answered, `elapsed_ms` = time already spent), so a reload or coming back never creates a second attempt. Older unfinished attempts are left as they are (abandoned). A retake always starts a new attempt. The results screen offers "Review these flashcards", a plain link to the lesson's flashcard deck; it changes no scheduling.
- Endpoints: `GET /api/quiz` · `POST /api/lessons/:id/quiz/attempts` (body `{ retake_of? }`; returns questions without answers) · `POST /api/quiz/attempts/:id/answers` (`{ position, choice, time_ms }`; each question once; returns correct, answer_index, answer_text, evidence) · `POST /api/quiz/attempts/:id/finish` (`{ total_ms }`; every question answered first; returns score, missed questions, previous best).

### Stats
- Per participant (`GET /api/stats`, `server/src/stats/participant.js`); `StatsScreen.jsx` and `StatsView.jsx` are lazy-loaded so Recharts only loads on Stats.
- Study time this week: tiles (total, reading, flashcards, quiz) and a stacked bar per day Mon–Sun (Recharts) with a "Show as a table" view.
- Flashcards: reviewed this week, % Good or Easy this week, due tomorrow (cards whose `due_at` falls in the next study day), all-time line.
- Quiz scores: first and best finished score per lesson (abandoned attempts not counted), one small horizontal bar chart per lesson.
- Chart colours are existing tokens via `--series-reading` (accent), `--series-flashcards` (margin), `--series-quiz` (warn) in `stats.css` for study time; every value is also written out (tiles, labels, table). The quiz-score bars do not reuse those (they would mean two things on one screen): Best is `--accent`, First try is `--ink-2`, and a lesson with one finished quiz shows a single "Score" bar.
- Flashcard done card recap: cards studied this sitting, active time, % Good/Easy (undone answers removed; `sessionRecap` in `lib/flashcards.js`).

### Research export (admin only)
- `GET /api/admin/export.zip` (all files + `README.txt` codebook) and `GET /api/admin/export/<file>.csv`; `?include_p00=1` includes P00 (left out by default). UTF-8 with BOM, CRLF, text starting with `= + - @` prefixed with `'`. Only study tables are read, never `settings`: no names, settings, keys or PIN.
- Files: `summary`, `sessions`, `flashcard_reviews` (with due_date / due_status / days_late), `due_reviews` (planning: on_time / late / still_overdue), `quiz_attempts` (status finished / abandoned / open, `is_retake`, `retake_of`, `is_first_attempt`), `quiz_answers`, `events`.
- `summary.csv`, one row per participant, columns grouped by SDL dimension: `planning_days_active, planning_total_sessions, planning_reading_min, planning_flashcards_min, planning_quiz_min, planning_total_min, planning_first_study_date, planning_last_study_date, planning_reviews_on_time, planning_reviews_late, planning_reviews_still_overdue, planning_avg_days_late, planning_on_time_rate` (= on_time / (on_time + late + still_overdue)); `retention_cards_reviewed, retention_good_easy_pct, retention_quiz_first_pct_mean, retention_quiz_first_pct_L<lesson id>`…; `self_monitoring_stats_views, self_monitoring_quiz_retakes, self_monitoring_review_flashcards_taps, self_monitoring_simplify_taps, self_monitoring_translate_taps`. Days active = study days with active session time, a flashcard answer or a quiz answer; total sessions = sessions with active time.

### Settings (gear icon)
- AI provider: presets (Google Gemini (default), NVIDIA NIM, OpenRouter, Ollama, llama.cpp, Custom) that prefill base URL; per-provider API key (shown only as set / not set); model picker fed by `GET /api/settings/models` with a free-text fallback; "Test connection" tests the provider + model in the form before saving
- Quiz question count; flashcards per lesson; summary length (short / detailed); include speaker notes (`include_speaker_notes`, default on; applies to pptx uploads made after changing it)
- Flashcard: new cards/day, max reviews/day, learning steps
- Data: delete lesson, reset flashcard progress, export/import JSON backup
- Built in Phase 6: "Participant P03 · Switch participant" and a "Researcher admin" link
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
- `participants` (id, code UNIQUE, created_at) (migration 008; `P00` made by the migration). Deleting a row cascades to every per-participant table.
- `review_progress` (participant_id, lesson_id, last_section, completed_sections JSON, updated_at), PK (participant_id, lesson_id)
- `flashcards` (id, lesson_id, front, back, state, ease, interval, due_at, reps, lapses, step, kind, evidence, position)
  - `kind` `term` | `concept`; `position` is the new-card order within the lesson. Since migration 008 the scheduling columns here are no longer read: the schedule is per participant in `flashcard_progress`.
- `flashcard_progress` (participant_id, flashcard_id, state, step, ease, interval, due_at, reps, lapses), PK (participant_id, flashcard_id)
  - state 0 new / 1 learning / 2 review / 3 relearning; `interval` in days. No row = the card is new for that participant.
- `flashcard_reviews` (id, participant_id, flashcard_id, rating, reviewed_at, prev_interval, new_interval, state, ease, time_ms, snapshot)
  - one row per answer: rating = button (1 Again … 4 Easy), `state` before the answer (daily limits count it), `ease` after, intervals in days (a learning step is a fraction of a day), `snapshot` = the participant's scheduling fields before the answer plus `existed` (for undo: a card that had no progress row gets none again; undo deletes the row).
- `quiz_questions` (id, lesson_id, question, choices JSON, answer_index, explanation)
- `quiz_attempts` (id, participant_id, lesson_id, score, total, answers JSON, taken_at, + migration 007 columns)
- `study_sessions` (id, participant_id, lesson_id (SET NULL; NULL = All lessons deck), activity `reading`|`flashcards`|`quiz`, started_at, last_active_at, ended_at, active_ms, end_reason `left`|`idle`|`background`|`switched` (NULL while open), study_date) (rebuilt in migration 008)
- `events` (id, participant_id, type `stats_view`|`quiz_retake`|`review_flashcards_tap`|`section_simplify`|`section_translate`, lesson_id, attempt_id, section_index, created_at, study_date)
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
- Phase 6 (study routes need `X-Participant`): `GET /api/participants/:code` (check a code) · `POST /api/sessions` (`{ lesson_id, activity }`) / `POST /api/sessions/:id` (`{ active_ms, end_reason?, ended_ago_ms? }`) · `POST /api/events` (`{ type, lesson_id?, attempt_id?, section_index? }`) · `GET /api/stats`
- Admin (`X-Admin-Pin`): `POST /api/admin/unlock` · `GET /api/admin/participants` (summary rows) / `POST /api/admin/participants` (`{ codes }`) · `GET /api/admin/participants/:code/stats` · `GET /api/admin/export.zip` / `GET /api/admin/export/:file.csv` (`?include_p00=1`); upload / retry / delete lesson, make flashcards and `/api/settings/*` also need the PIN
- `GET /api/settings` / `PUT /api/settings` / `POST /api/settings/test-ai`
- AI settings (backend done in Phase 2.5): `GET /api/settings/ai` / `PUT /api/settings/ai` (active provider, per-provider model/URL/key; keys never returned), `GET /api/settings/models?provider=`, `POST /api/settings/test-ai` (tests the provider + model in the body without saving)
- `POST /api/lessons/:id/retry` (re-run a failed lesson; finished stages are kept)
- `POST /api/lessons/:id/quiz-options` (admin; make the missing quiz wrong answers, 202 + job status; 409 while the lesson is processing/failed/busy or nothing is missing). `GET /api/lessons` rows carry `quiz_options: { missing, status, error }`.
- `GET /api/backup` / `POST /api/backup`

## Build Phases
1. Repo scaffold, Express + SQLite + migrations, upload + parsing, lessons API — **done**
2. AI adapter, job pipeline, sections / key points / key terms generation — **done** (incl. Phase 2.5: provider presets with Google as default, parallel chunk calls, model selection, grounded key terms)
3. React app shell, tab bar, upload flow, Review tab — **done** (incl. `POST /api/sections/:id/simplify|translate` and review-progress save/load)
4. Flashcard generation + SM-2 + Flashcard tab — **done**
5. Quiz generation + attempts + shuffle animation + Mock Quiz tab — **done**
6. Session logging + Stats tab + CSV export — **done** (incl. participant codes, per-participant scheduling, self-monitoring events, planning metric, PIN admin, research export, withdrawal script)
7. Settings, backup/import, polish, README, LICENSE (MIT)

Phase 7 carry-over from the Phase 5 quiz audit (Low findings, not fixed yet):
- Focus ring: base.css `:focus-visible` forces `border-radius: 4px`, so `.quiz-opt` loses its 10px corners on focus.
- Wrap `.quiz-opt:hover` in `@media (hover: hover)` so it doesn't stick on touch screens.
- quiz.css and flashcards.css hardcode radii (4px, 10px, 14px) and the card shadow `rgb(14 17 38 / .08)` instead of tokens; add a shadow token and map the radii.
- Announce the question's position ("Question 3 of 10") to screen readers (`aria-describedby` on the article pointing at the counter).
- Quiz tab: the "Preparing" / "Making cards" chips change silently; add a polite live region.
- Copy repeats: "Needs 2+ cards" next to "Only 1 flashcard"; "You got every question right." under a 10 of 10 score; a correct True answer repeats the statement; drop the exclamation in "New best!".
- Small text carries meaning (0.8125rem tags, key boxes, `dt`): raise to 0.875rem.

Phase 7 carry-over from the Phase 6 audit (Low findings, not fixed yet):
- Gate: `autoFocus` opens the phone keyboard over the card and button (skip it on touch devices); the wordmark is `aria-hidden`, so nothing names the app (add a visually-hidden "StudyRevr" to the h1 or `<title>`); `NOT_LISTED` uses a straight `'` where the rest of the app uses `’`; the card is plain and uses no `--hi` / `--margin` notebook motif (e.g. a `--margin` rule down its left edge).
- Done card recap: it is the peak of the sitting but reads as a flat strip; give the Good or Easy tile `--accent-wash`.
- Stats: a missing percentage shows "–" (a screen reader says "dash"; use "No answers yet" or an `aria-label`); each lesson's quiz title is a `<p>` (make it an `<h3>`); stacked segments differ by hue only (the table covers it; add a one-line summary such as "Most active day: Tue"); the chart tooltip is hover-only (acceptable, the data is in the tiles and table).
- `.btn--small` is 40px (Lock admin, export CSV buttons); the project target is 44px.
- base.css `:focus-visible` forces `border-radius: 4px`, which squares the focus ring on the pill-shaped `.participant-chip` (same cause as the `.quiz-opt` item above).
- Admin: "Add" should read "Add codes"; the `npm run participant:delete -- P07` hint should be in `<code>`; the "Added P08." message is plain muted text (use `--ok`) and its empty `aria-live` paragraph adds a blank 12px gap.

Work one phase at a time. At the end of each phase: run it, fix errors, summarize what was built and how to test it, then stop.
