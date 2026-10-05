# StudyRevr

Open-source, mobile-first study app. Upload a lesson (.docx / .pptx / .pdf) and get a sectioned review, Anki-style flashcards, and mock quizzes. Study activity is logged and exportable for research.

> **Status:** Phase 3 of 7 — React app with the lesson library, upload, processing screen and the Review tab (sections, quick checks, simpler / Filipino-Taglish rewrites, key points, key terms, original text, resume). Flashcard, Mock Quiz, Stats and Settings are placeholders until their phases.

## Running it

**Requirements:** Node.js 22.13 or newer.

```bash
npm install
cp .env.example .env     # then add your AI key (GOOGLE_API_KEY by default); uploads work without one, AI generation needs it
npm run dev              # API on http://localhost:3001 and the app on http://localhost:5173 (Vite proxies /api)
npm test                 # server and client tests
npm run build            # production build of the client into client/dist
```

The SQLite database is created at `server/data/studyrevr.db` on first start, and migrations run automatically.

### Configuration (`.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | API port |
| `DB_PATH` | `server/data/studyrevr.db` | SQLite file (relative to repo root). Git-ignored: it can hold API keys saved in Settings |
| `MAX_UPLOAD_MB` | `20` | Upload size limit |
| `AI_PROVIDER` | `google` | `google`, `nvidia-nim`, `openrouter`, `ollama`, `llamacpp` or `custom` |
| `GOOGLE_API_KEY` / `NVIDIA_API_KEY` / `OPENROUTER_API_KEY` | – | One key per provider; only the active provider's key is sent. Never logged or returned by the API |
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
| `nvidia-nim` | `https://integrate.api.nvidia.com/v1` | `deepseek-ai/deepseek-v4.1-flash` | 2400 | 2 |
| `openrouter` | `https://openrouter.ai/api/v1` | `openrouter/auto` | 2400 | 2 |
| `ollama` | `http://localhost:11434/v1` | `llama3.1:8b` | 2400 | 1 |
| `llamacpp` | `http://localhost:8080/v1` | `local` | 2400 | 1 |

Each value resolves as: a one-off request value → what is saved in the `settings` table → `.env` → the preset. The `.env` overrides (`AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, `AI_EXTRA_BODY`) belong to the `.env` provider and are not used for any other provider you switch to. The model is never fixed: any id works, and the provider's list comes from `GET /api/settings/models`. Settings keys (the Settings screen arrives in Phase 7): `ai_provider`, and per provider `ai_model:<provider>`, `ai_base_url:<provider>`, `ai_api_key:<provider>`; plus `ai_concurrency`, `ai_chunk_tokens`, `ai_temperature`, `key_terms_max`, `summary_length` (`short`/`detailed`). Switching provider brings back that provider's last model and key. **A backup export (Phase 7) must leave `ai_api_key:*` out.**

### Try the API

```bash
curl -F "file=@lesson.docx" http://localhost:3001/api/lessons    # upload
curl http://localhost:3001/api/lessons                           # list
curl http://localhost:3001/api/lessons/1                         # one lesson, with extracted text
curl -X DELETE http://localhost:3001/api/lessons/1               # delete
```

Supported formats: `.docx`, `.pptx` and `.pdf` (up to `MAX_UPLOAD_MB`). A `.docx`/`.pptx` that would unpack to more than 200 MB or hold more than 10,000 parts is rejected before it is read (zip-bomb guard). Slides and PDF pages are separated by a blank line in the extracted text, with one paragraph per line inside each. For PowerPoint files this includes bullet lists, tables, SmartArt text and (by default) speaker notes under a `Notes:` line; set the `include_speaker_notes` row in the `settings` table to `false` to leave notes out of future uploads. For PDFs, lines that repeat on most pages (headers, footers, page numbers) are removed and wrapped lines are rejoined into paragraphs.

Uploading returns `{ lesson, warning }`. `warning` is set when little text was extracted (for example, image-heavy slides). A PDF with almost no text gets "This PDF looks scanned or image-only; text can't be extracted." (there is no OCR). Old `.doc` / `.ppt` files are rejected with a "save as .docx/.pptx" message.

### AI generation

After an upload the lesson is `processing` and a background job runs, one lesson at a time: **sections** (with 1–2 quick-check questions each) → **key points** → **key terms**. The stages run in that order (key points are written from the sections), but inside a stage the chunk calls run in parallel, up to the provider's concurrency (`AI_CONCURRENCY`). Each stage makes one AI call per chunk of lesson text (paragraphs are never split; slides/pages and headings are the preferred cut points; a slide's `Notes:` stays with its slide). Every AI reply is validated with zod and retried once if it isn't valid JSON; rate limits (429) and overloads (5xx) are retried up to 5 attempts with a growing, jittered wait. Key points state a takeaway rather than list examples; key terms are limited to domain concepts a student must be able to define (at most `KEY_TERMS_MAX`, de-duplicated across chunks). A lesson that is split into several chunks gets one extra key-terms call that keeps the best candidates: it removes examples, evaluative phrases and weak or duplicate terms, and can only choose among the candidates (by number), never write terms or evidence; the evidence is checked again afterwards. Terms are also de-duplicated in code first, ignoring case and plurals. Key terms are grounded: each comes with an `evidence` quote (at most 25 words) copied from the lesson, and a term whose quote can't be found in the lesson text (ignoring case, spacing, punctuation and line-end hyphens) is dropped and logged, so the AI can't define a term from its own knowledge. The quote is saved in `key_terms.evidence` for the Review screen.

```bash
curl http://localhost:3001/api/lessons/1/status       # { lesson: { id, status, error }, job: { stage, status, progress: { done, total }, error } }
curl http://localhost:3001/api/lessons/1              # lesson + sections, key_points, key_terms once ready
curl -X POST http://localhost:3001/api/lessons/1/retry   # re-run a failed lesson (finished stages are kept)
```

`status` is `processing`, `ready` or `failed`; `job.stage` is `sections`, `key_points`, `key_terms` or `done`; `progress.done` counts finished AI calls in the current stage. A job still running when the server stops is marked failed on the next start and can be retried.

Provider and model (backend only; the Settings screen arrives in Phase 7). API keys go in and never come out: responses only say `keySet: true/false`.

```bash
curl http://localhost:3001/api/settings/ai                    # active provider, each provider's model / base URL, keySet flags
curl -X PUT http://localhost:3001/api/settings/ai -H 'content-type: application/json' \
     -d '{"provider":"google","model":"gemini-3.5-flash-lite","apiKey":"..."}'   # save (any model id; "" clears a value)
curl "http://localhost:3001/api/settings/models?provider=google"   # chat models offered by the provider, sorted;
                                                                   # { models: [], freeText: true, error } if it can't be listed
curl -X POST http://localhost:3001/api/settings/test-ai -H 'content-type: application/json' \
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
curl -X POST http://localhost:3001/api/sections/1/simplify    # { section_id, kind, version: { text, example }, cached }
curl -X POST http://localhost:3001/api/sections/1/translate   # { ..., version: { title, content, check_questions } }
curl -X PUT http://localhost:3001/api/lessons/1/review-progress -H 'content-type: application/json'      -d '{"last_section":2,"completed_sections":[0,1]}'      # 0-based indices into the lesson's sections
curl http://localhost:3001/api/lessons/1/review-progress      # { review_progress: { last_section, completed_sections, updated_at } | null }
```

`simplify` and `translate` call the active AI provider once per section and kind, save the result in the `sections` row (`simple_version`, `filipino_version`, as JSON) and answer from that cache afterwards; two taps at the same time share one call. `simplify` gives a plain-words rewrite plus an everyday example; `translate` gives natural Filipino/Taglish for the title, content and quick-check questions, keeping the lesson's key terms in English with the Filipino meaning in parentheses. The stored summary is never changed. `GET /api/lessons/:id` returns both versions (or `null`) on each section, the saved `review_progress`, and where each section came from: `lesson.source` (`{ kind, total, numbers }`, the real slide / page / paragraph number of each block of `raw_text`; `null` for lessons uploaded before this was recorded) and `sections[].sources` (the slide / page numbers the section was written from, checked against the file's real count; `null` when unknown, and Original text then falls back to an approximate match).

Errors are always JSON: `{ "error": { "message": "..." } }`. A failing AI provider gets a message that says what to change (wrong model, wrong API key, rate limited, too slow); the provider's own reply is written to the server log with keys removed.

## Project layout

```
server/   Express + SQLite API (ES modules)
client/   React + Vite app (hash routes, Motion, no UI library); client/test has the unit tests for its pure helpers
```
