# StudyRevr

Open-source, mobile-first study app. Upload a lesson (.docx / .pptx / .pdf) and get a sectioned review, Anki-style flashcards, and mock quizzes. Study activity is logged and exportable for research.

> **Status:** Phase 7A of 7 — React app with the lesson library, the Review tab (sections, quick checks, simpler / Filipino-Taglish rewrites, key points, key terms, original text, resume), the Flashcard tab (grounded cards, Anki-style SM-2 scheduling, undo), the Mock Quiz tab (questions from the lesson's flashcards, every answer logged), participant codes, active-time session logging, the Stats tab, and a PIN-protected researcher admin (lesson upload, participant codes, research CSV export, AI and study settings, "Prepare" for the rewrites, database backup). Students can optionally use their own AI key for the rewrites, with a fallback chain (their key → the app's Default → Gemma). The rest of Phase 7 (polish, LICENSE) is still to come.

## Running it

**Requirements:** Node.js 22.13 or newer.

```bash
npm ci                   # in the repo root only: it installs the server and the client (npm workspaces)
cp .env.example .env     # then add your AI key (GOOGLE_API_KEY by default); uploads work without one, AI generation needs it
npm run dev              # API on http://localhost:3001 and the app on http://localhost:5173 (Vite proxies /api)
npm test                 # server and client tests
npm run build            # production build of the client into client/dist
npm run study            # build the client and serve app + API on one port (for phones on the same Wi-Fi)
```

The SQLite database is created at `server/data/studyrevr.db` on first start, and migrations run automatically.

**Installing:** run `npm ci` (or `npm install`) in the repo root only. `server/` and `client/` are npm workspaces of the root, with one shared `package-lock.json` and `node_modules/`; running `npm ci` inside `client/` (or `server/`) deletes the root `node_modules` and installs only that workspace's packages, which breaks the server. If that happened, run `npm ci` in the root again.

### Configuration (`.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | API port |
| `DB_PATH` | `server/data/studyrevr.db` | SQLite file (relative to repo root). Git-ignored: it can hold API keys saved in Settings |
| `MAX_UPLOAD_MB` | `20` | Upload size limit |
| `ADMIN_PIN` | – | The researcher's admin PIN (upload, participant codes, AI settings, export). Empty: admin is off |
| `AI_PROVIDER` | `google` | `google`, `deepseek`, `qwen`, `nvidia-nim`, `openrouter`, `ollama`, `llamacpp` or `custom` |
| `GOOGLE_API_KEY` / `DEEPSEEK_API_KEY` / `DASHSCOPE_API_KEY` / `NVIDIA_API_KEY` / `OPENROUTER_API_KEY` | – | One key per provider; only the active provider's key is sent. Never logged or returned by the API. The Google key also serves the Gemma fallback for live rewrites |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | – | Optional overrides for the `AI_PROVIDER` provider (an older `.env` with only `AI_BASE_URL` still works: the provider is recognised from the URL) |
| `AI_EXTRA_BODY` | – | JSON object merged into every chat request for provider options, e.g. `{"reasoning_effort":"none"}` to switch thinking off. Ignored, with a warning, if it isn't a JSON object |
| `AI_CONCURRENCY` | preset | Parallel AI calls within one stage of a lesson |
| `AI_CHUNK_TOKENS` | preset | Lesson text per AI call |
| `AI_TEMPERATURE` | preset (`0.2`) | Sampling temperature (0 to 2) for the lesson calls |
| `AI_TIMEOUT_SECONDS` | preset (google `60`, others `300`) | Per AI request; a timed-out request is retried once. Raise it for slow local or reasoning models |
| `KEY_TERMS_MAX` | `12` | Key terms kept per lesson |

Provider presets (base URL, default model, chunk tokens, concurrency):

| Preset | Base URL | Default model | Chunk | Parallel |
| --- | --- | --- | --- | --- |
| `google` | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-3.5-flash-lite` | 30000 | 2 (free tier: 15 requests/min) |
| `deepseek` | `https://api.deepseek.com/v1` | `deepseek-chat` | 2400 | 2 |
| `qwen` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` (Alibaba Cloud, Singapore) | `qwen-plus` | 2400 | 2 |
| `nvidia-nim` | `https://integrate.api.nvidia.com/v1` | `deepseek-ai/deepseek-v4.1-flash` | 2400 | 2 |
| `openrouter` | `https://openrouter.ai/api/v1` | `openrouter/auto` | 2400 | 2 |
| `ollama` | `http://localhost:11434/v1` | `llama3.1:8b` | 2400 | 1 |
| `llamacpp` | `http://localhost:8080/v1` | `local` | 2400 | 1 |

Each value resolves as: a one-off request value → what is saved in the `settings` table → `.env` → the preset. The `.env` overrides (`AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, `AI_EXTRA_BODY`) belong to the `.env` provider and are not used for any other provider you switch to. The model is never fixed: any id works, and the provider's list comes from `GET /api/settings/models`. Settings keys (set in Admin › AI and study settings): `ai_provider`, and per provider `ai_model:<provider>`, `ai_base_url:<provider>`, `ai_api_key:<provider>`; plus `ai_concurrency`, `ai_chunk_tokens`, `ai_temperature`, `key_terms_max`, `summary_length` (`short`/`detailed`). Switching provider brings back that provider's last model and key. A backup (Admin › Download backup) leaves every `ai_api_key:*` out, and students' own keys too.

## Running a study session (shared host, phones on Wi-Fi)

1. In `.env`, set `ADMIN_PIN` (at least 6 characters students can't guess) and your AI key. Without `ADMIN_PIN`, admin is off.
   The PIN box in the app only says "Ask the researcher for the PIN"; it never shows where the PIN is kept (`ADMIN_PIN` in `.env`).
2. `npm run study` builds the app and starts the server. It prints the addresses phones can open, e.g. `http://192.168.1.20:3001`. On Termux, run it the same way; keep the phone awake. The host and the phones must be on the same Wi-Fi.
3. On any device, open that address, tap **Researcher admin** under the code box (or Settings › Researcher admin), and enter the PIN. In **Admin**:
   - **Lessons**: upload every lesson and wait until it is ready; the last step makes the quiz answer options, so students never wait on the AI when they start a quiz (if that step fails the lesson is still usable; use **Retry quiz answers** on its row). Students cannot upload, retry, delete or make cards. A lesson that participants (other than P00) have answered or logged study time on cannot be deleted; the app tells you how many records it would remove.
   - **Participants**: add the codes, e.g. `P01-P10`. Students can only type a code that is on this list; P00 (made by the Phase 6 migration) holds your own earlier test data.
   - **Research export**: `Download all (zip)` or single CSVs; tick **Include P00** to include your test data. `README.txt` in the zip explains every column.
   - **AI and study settings**: the Default AI (provider, key, model; the model list shows chat models only; **Test connection** tries it before you save), **New flashcards per day** (default 20), and **Allow students to use their own API key** (off by default).
   - **Prepare simpler and Taglish** on each lesson row (after processing): makes the Explain simpler and Filipino/Taglish version of every section with the Default ahead of time, within the 15 requests/min limit, with progress on the row. Run this before study day: while it runs, students' live requests use the backup AI. Afterwards study day needs no live AI calls (unless a student uses their own key).
   - **Backup**: **Download backup** saves `studyrevr-backup-YYYY-MM-DD-HHMM.db` (Manila time), a copy of the whole database made while the app runs, without any API key or the PIN; "Last backup" shows when you last did it.
4. Each student opens the address on their phone and types their code. The code stays on that phone until **Settings › Switch participant**. The header shows the code in use.
5. Withdrawal: on the host, `npm run participant:delete -- P07` shows what will be deleted and asks you to type the code again; it deletes everything recorded for that participant, their own AI key included (shared lessons stay), and rewrites the database file so nothing can be read back. Add `--yes` to skip the question.
6. Restore a backup: stop the server, then `npm run restore -- studyrevr-backup-2026-10-06-1430.db`. It refuses while the server runs (if it says a server is running but none is, it names the `.pid` file next to the database to delete), checks the file, asks you to type `RESTORE`, keeps the current database as `pre-restore-<time>.db` next to it, and brings the backup up to date. **That `pre-restore` copy still contains the API keys (yours and the students'): delete it once you have checked that the restore worked.** Afterwards enter the API key again in Admin (backups hold no keys) and check `ADMIN_PIN` in `.env`.

**Students' own AI keys (optional):** with the admin switch on, Settings shows "AI for Explain simpler and Filipino/Taglish": **Default** or **Use your own key** (Google, DeepSeek, Qwen, NVIDIA NIM or OpenRouter, a pasted key, and a chat model from the provider's list). **Test key** sends one tiny request and saves the key only if it works; the key is stored on the host under the participant code, shown back only as its last 4 characters, never exported or backed up, and removed by **Remove my key** or `participant:delete`. A student's key is used only for their own Explain simpler and Filipino/Taglish taps; lessons are always prepared with the Default.

**Delete all student keys** (Admin › AI and study settings) removes every saved student key after the study (with a confirmation). The temporary file a backup is made in sits next to the database and is deleted when the download is done (any leftover is removed when the server starts).

**Known limit: the participant code is the only identity.** The code screen is type-only by design, so a student who types another student's code is that student to the app: they can see that participant's Stats, use or replace that participant's saved AI key, and add records under that code. There is no password. The limit is accepted for a classroom study on a trusted Wi-Fi; a student's own key also travels over that Wi-Fi without encryption (plain HTTP), so students should only use a key they can delete later.

**What is logged, per participant:** flashcard schedule and every answer (Again/Hard/Good/Easy), quiz attempts and every answer (abandoned attempts and retakes included and marked), Review-tab position, study sessions (reading / flashcards / quiz) with active time, self-monitoring events (Stats views, quiz retakes, "Review these flashcards" taps, "Explain simpler" and "Filipino/Taglish" taps), and every live AI request for a rewrite (`ai_calls.csv`: which source, provider and model answered and how many fallbacks it took). Active time stops when the app goes to the background and a session ends after 5 minutes without a tap, scroll or key press. Days follow the flashcard study day: 04:00 to 04:00 Asia/Manila. The export never contains names, settings or API keys (yours or students').

The Stats tab shows each student their own study time this week (reading / flashcards / quiz), cards reviewed and % Good or Easy, first and best quiz score per lesson, and cards due tomorrow. In admin, tap a code to see that participant's Stats (this is not logged as their view).

### Try the API

Study routes need the participant header (`-H "x-participant: P01"`, a code on the list); admin routes (upload, retry, delete, making cards, AI settings, participant codes, export) need the PIN (`-H "x-admin-pin: $PIN"`).

```bash
curl -H "x-admin-pin: $PIN" -H 'content-type: application/json' -d '{"codes":"P01-P10"}' http://localhost:3001/api/admin/participants
curl http://localhost:3001/api/participants/P01                                    # is this code on the list? (404 if not)
curl -H "x-participant: P01" http://localhost:3001/api/stats                       # the Stats tab's numbers
curl -H "x-admin-pin: $PIN" -o export.zip http://localhost:3001/api/admin/export.zip   # ?include_p00=1 to include P00
curl -H "x-admin-pin: $PIN" http://localhost:3001/api/admin/export/summary.csv
curl -H "x-admin-pin: $PIN" -OJ http://localhost:3001/api/admin/backup             # studyrevr-backup-YYYY-MM-DD-HHMM.db, no keys or PIN
curl -H "x-admin-pin: $PIN" http://localhost:3001/api/settings                      # { flashcard_new_per_day, allow_student_keys } (PUT to change)
curl -H "x-participant: P01" http://localhost:3001/api/my-ai                        # the student's AI choice (allowed, default, key: { provider, model, last4 } | null)
curl -H "x-participant: P01" -X POST http://localhost:3001/api/my-ai/key -H 'content-type: application/json' \
     -d '{"provider":"deepseek","model":"deepseek-chat","apiKey":"..."}'           # Test key: saved only if a tiny request works
```

```bash
curl -H "x-admin-pin: $PIN" -F "file=@lesson.docx" http://localhost:3001/api/lessons    # upload
curl http://localhost:3001/api/lessons                           # list
curl http://localhost:3001/api/lessons/1                         # one lesson, with extracted text
curl -H "x-admin-pin: $PIN" -X DELETE http://localhost:3001/api/lessons/1               # delete
```

Supported formats: `.docx`, `.pptx` and `.pdf` (up to `MAX_UPLOAD_MB`). A `.docx`/`.pptx` that would unpack to more than 200 MB or hold more than 10,000 parts is rejected before it is read (zip-bomb guard). Slides and PDF pages are separated by a blank line in the extracted text, with one paragraph per line inside each. For PowerPoint files this includes bullet lists, tables, SmartArt text and (by default) speaker notes under a `Notes:` line; set the `include_speaker_notes` row in the `settings` table to `false` to leave notes out of future uploads. For PDFs, lines that repeat on most pages (headers, footers, page numbers) are removed and wrapped lines are rejoined into paragraphs.

Uploading returns `{ lesson, warning }`. `warning` is set when little text was extracted (for example, image-heavy slides). A PDF with almost no text gets "This PDF looks scanned or image-only; text can't be extracted." (there is no OCR). Old `.doc` / `.ppt` files are rejected with a "save as .docx/.pptx" message.

### AI generation

After an upload the lesson is `processing` and a background job runs, one lesson at a time: **sections** (with 1–2 quick-check questions each) → **key points** → **key terms** → **flashcards**. The stages run in that order (key points are written from the sections), but inside a stage the chunk calls run in parallel, up to the provider's concurrency (`AI_CONCURRENCY`). Each stage makes one AI call per chunk of lesson text (paragraphs are never split; slides/pages and headings are the preferred cut points; a slide's `Notes:` stays with its slide). Every AI reply is validated with zod and retried once if it isn't valid JSON; rate limits (429) and overloads (5xx) are retried up to 5 attempts with a growing, jittered wait. Key points state a takeaway rather than list examples; key terms are limited to domain concepts a student must be able to define (at most `KEY_TERMS_MAX`, de-duplicated across chunks). A lesson that is split into several chunks gets one extra key-terms call that keeps the best candidates: it removes examples, evaluative phrases and weak or duplicate terms, and can only choose among the candidates (by number), never write terms or evidence; the evidence is checked again afterwards. Terms are also de-duplicated in code first, ignoring case and plurals. Key terms are grounded: each comes with an `evidence` quote (at most 25 words) copied from the lesson, and a term whose quote can't be found in the lesson text (ignoring case, spacing, punctuation and line-end hyphens) is dropped and logged, so the AI can't define a term from its own knowledge. The quote is saved in `key_terms.evidence` for the Review screen.

```bash
curl http://localhost:3001/api/lessons/1/status       # { lesson: { id, status, error }, job: { stage, status, progress: { done, total }, error } }
curl http://localhost:3001/api/lessons/1              # lesson + sections, key_points, key_terms once ready
curl -H "x-admin-pin: $PIN" -X POST http://localhost:3001/api/lessons/1/retry   # re-run a failed lesson (finished stages are kept)
```

`status` is `processing`, `ready` or `failed`; `job.stage` is `sections`, `key_points`, `key_terms` or `done`; `progress.done` counts finished AI calls in the current stage. A job still running when the server stops is marked failed on the next start and can be retried.

Provider and model (Admin › AI and study settings uses these). API keys go in and never come out: responses only say `keySet: true/false`.

```bash
curl -H "x-admin-pin: $PIN" http://localhost:3001/api/settings/ai                    # active provider, each provider's model / base URL, keySet flags
curl -H "x-admin-pin: $PIN" -X PUT http://localhost:3001/api/settings/ai -H 'content-type: application/json' \
     -d '{"provider":"google","model":"gemini-3.5-flash-lite","apiKey":"..."}'   # save (any model id; "" clears a value)
curl -H "x-admin-pin: $PIN" "http://localhost:3001/api/settings/models?provider=google"   # chat models offered by the provider, sorted;
                                                                   # { models: [], freeText: true, error } if it can't be listed
curl -H "x-admin-pin: $PIN" -X POST http://localhost:3001/api/settings/test-ai -H 'content-type: application/json' \
     -d '{"provider":"google","model":"gemini-3.5-flash-lite"}'    # tiny JSON round-trip; tries what's in the body, saves nothing
```

Try the pipeline on a file without the server (uses a throw-away database, prints the results, per-call timings and retry counts):

```bash
npm run pipeline                                    # lists files in test-lessons/
npm run pipeline -- Introduction-to-Media-Channels  # partial file name is fine
npm run pipeline -- lesson.pdf --summary=short --chunk-tokens=1500 --concurrency=3
```

### Review endpoints

```bash
curl -H "x-participant: P01" -X POST http://localhost:3001/api/sections/1/simplify    # { section_id, kind, version: { text, example }, cached, shared, answered_by, fallback }
curl -H "x-participant: P01" -X POST http://localhost:3001/api/sections/1/translate   # { ..., version: { title, content, check_questions } }
curl -H "x-admin-pin: $PIN" -X POST http://localhost:3001/api/lessons/1/section-versions   # Prepare: make every missing version now (202; progress on GET /api/lessons)
curl -H "x-participant: P01" -X PUT http://localhost:3001/api/lessons/1/review-progress -H 'content-type: application/json'      -d '{"last_section":2,"completed_sections":[0,1]}'      # 0-based indices into the lesson's sections
curl -H "x-participant: P01" http://localhost:3001/api/lessons/1/review-progress      # { review_progress: { last_section, completed_sections, updated_at } | null }
```

`simplify` and `translate` answer from the shared version saved in the `sections` row (`simple_version`, `filipino_version`, as JSON) when there is one. Otherwise they make it live, through a fallback chain, one try per step with no retry waits: the student's own key (if admin allows it and they saved one) → the app's Default → `gemma-4-26b-a4b-it` on the admin's Google key → an error with "Try again". Only the Default's answer is saved as the shared version (two taps at the same time share one call); answers from a student's key or from Gemma are shown to that student only, so the next request tries the Default again. A step falls back only on a rate limit, timeout, network error or 5xx (the student's key also on a rejected key or no credit), never on a bad request; an answer that came from a fallback carries a short note ("Your key didn't work, so the default AI answered."). Every live request is logged in `ai_calls`. `simplify` gives a plain-words rewrite plus an everyday example; `translate` gives natural Filipino/Taglish for the title, content and quick-check questions, keeping the lesson's key terms in English with the Filipino meaning in parentheses. The stored summary is never changed. `GET /api/lessons/:id` returns both versions (or `null`) on each section, the saved `review_progress`, and where each section came from: `lesson.source` (`{ kind, total, numbers }`, the real slide / page / paragraph number of each block of `raw_text`; `null` for lessons uploaded before this was recorded) and `sections[].sources` (the slide / page numbers the section was written from, checked against the file's real count; `null` when unknown, and Original text then falls back to an approximate match).

Errors are always JSON: `{ "error": { "message": "..." } }`. A failing AI provider gets a message that says what to change (wrong model, wrong API key, rate limited, too slow); the provider's own reply is written to the server log with keys removed.

### Flashcards

The last pipeline stage makes the lesson's cards: **term → definition** cards straight from the grounded key terms (a long definition is cut to its first sentence), plus **question → answer** concept cards from one AI call per chunk of lesson text (the review sections written from that chunk are passed as a guide). Every card carries an `evidence` quote from the lesson that is checked in code exactly like key-term evidence; a card whose quote isn't in the lesson, whose quote only repeats the question, or whose answer is over 40 words (the prompt asks for 25) is dropped and logged. Cards are de-duplicated against each other ("What is a hypothesis?" duplicates the term card "Hypothesis"; term cards win). A lesson gets about one card per 50 words, at least 5 and at most `flashcards_max` (30); term cards take at most half, mixed in among the concept cards. Lessons uploaded before this phase get theirs from the Flashcard tab ("Make cards"), which runs only this stage and keeps the lesson readable meanwhile.

Scheduling is Anki's SM-2 (`server/src/flashcards/scheduler.js`, a pure module tested with a fake clock): learning steps `1m 10m`, graduating interval 1 day, easy interval 4 days, starting ease 2.5, easy bonus 1.3, hard interval 1.2, relearning step 10m, lapse new interval 0 (so 1 day), max interval 36500 days, at most 20 new cards and 200 reviews a day across all lessons. The study day starts at 04:00 Asia/Manila. Intervals get Anki's fuzz from a seeded generator, so the interval printed on each button is exactly what the card gets. Every answer writes a `flashcard_reviews` row (button, previous / new interval, ease, time on the card in ms, timestamp, state before the answer, and a snapshot used by Undo).

Settings rows: `flashcard_new_per_day` (20, editable in Admin), `flashcard_reviews_per_day` (200), `flashcard_learning_steps` (`1m 10m`), `flashcards_max` (30); optional overrides `flashcard_graduating_interval`, `flashcard_easy_interval`, `flashcard_starting_ease`, `flashcard_easy_bonus`, `flashcard_hard_interval`, `flashcard_relearning_steps`, `flashcard_lapse_interval`, `flashcard_min_interval`, `flashcard_max_interval`, `study_timezone`.

```bash
curl -H "x-participant: P01" http://localhost:3001/api/flashcards/decks                    # every lesson's New / Learning / Due counts, plus "All lessons"
curl -H "x-participant: P01" http://localhost:3001/api/lessons/1/flashcards/due            # the next card (with each button's interval) or next_due_at
curl -H "x-participant: P01" http://localhost:3001/api/flashcards/due                      # the same for All lessons
curl -H "x-participant: P01" -X POST http://localhost:3001/api/flashcards/5/review -H 'content-type: application/json' \
     -d '{"rating":3,"time_ms":4200,"deck":1}'                     # 1 Again, 2 Hard, 3 Good, 4 Easy -> review_id + the deck's next card
curl -H "x-participant: P01" -X POST http://localhost:3001/api/flashcards/reviews/17/undo -H 'content-type: application/json' -d '{"deck":1}'
curl -H "x-admin-pin: $PIN" -X POST http://localhost:3001/api/lessons/1/flashcards/generate   # make cards for a lesson that has none
```

In the app: Space flips the card, 1–4 answer, U or Ctrl+Z undoes. The server refuses (409 `not_due`) an answer to a review card that isn't due yet, so a card can't be reviewed early through the API or from a second tab.

### Mock Quiz

A quiz is built from the lesson's flashcards when it starts: up to 10 questions, multiple choice (4 options) or true / false, about 3 in 10 true / false. Term cards ask "which term matches this definition?" with other key terms of the lesson as the wrong options (no AI call). Concept cards use 3 wrong answers the AI writes once per card (in batches of at most 15 cards) and that are saved in `quiz_distractors` for every later quiz; a wrong answer equal to the right one or to another wrong answer is dropped. Without enough wrong answers a card becomes true / false (its false statement is a saved wrong answer or another card's answer). A short lesson gets fewer questions; if the AI call fails the quiz still starts, with a notice.

Every question is saved in `quiz_answers` when the quiz starts, and each answer the moment it is given (choice, right or wrong, time on the question, timestamp), so a quiz left part-way is still logged. `quiz_attempts` records start, finish, total time and `retake_of` (a retake asks the same questions in a new order). The quiz never changes flashcard scheduling.

```bash
curl -H "x-participant: P01" http://localhost:3001/api/quiz                                     # one row per lesson: questions it supports, best score, attempts
curl -H "x-participant: P01" -X POST http://localhost:3001/api/lessons/1/quiz/attempts          # start: questions without answers (body {"retake_of": 4} for a retake)
curl -H "x-participant: P01" -X POST http://localhost:3001/api/quiz/attempts/4/answers -H 'content-type: application/json' \
     -d '{"position":0,"choice":2,"time_ms":5200}'                      # -> correct, the right option, the card's evidence
curl -H "x-participant: P01" -X POST http://localhost:3001/api/quiz/attempts/4/finish -H 'content-type: application/json' -d '{"total_ms":61000}'
```

In the app: 1–4 answer (1–2 on true / false), Enter goes to the next question.

## Project layout

```
server/   Express + SQLite API (ES modules)
client/   React + Vite app (hash routes, Motion, no UI library); client/test has the unit tests for its pure helpers
```
