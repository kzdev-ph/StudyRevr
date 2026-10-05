# StudyRevr

Open-source, mobile-first study app. Upload a lesson (.docx / .pptx / .pdf) and get a sectioned review, Anki-style flashcards, and mock quizzes. Study activity is logged and exportable for research.

> **Status:** Phase 1 of 7 — backend foundation (upload, text extraction, lessons API). The React client arrives in Phase 3.

## Running it

**Requirements:** Node.js 22.13 or newer.

```bash
npm install
cp .env.example .env     # optional; defaults work out of the box
npm run dev              # API on http://localhost:3001
npm test                 # server tests
```

The SQLite database is created at `server/data/studyrevr.db` on first start, and migrations run automatically.

### Configuration (`.env`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | API port |
| `DB_PATH` | `server/data/studyrevr.db` | SQLite file (relative to repo root) |
| `MAX_UPLOAD_MB` | `20` | Upload size limit |

`AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL` are used from Phase 2.

### Try the API

```bash
curl -F "file=@lesson.docx" http://localhost:3001/api/lessons    # upload
curl http://localhost:3001/api/lessons                           # list
curl http://localhost:3001/api/lessons/1                         # one lesson, with extracted text
curl -X DELETE http://localhost:3001/api/lessons/1               # delete
```

Supported formats: `.docx`, `.pptx` and `.pdf` (up to `MAX_UPLOAD_MB`). Slides and PDF pages are separated by a blank line in the extracted text, with one paragraph per line inside each. For PowerPoint files this includes bullet lists, tables, SmartArt text and (by default) speaker notes under a `Notes:` line; set the `include_speaker_notes` row in the `settings` table to `false` to leave notes out of future uploads. For PDFs, lines that repeat on most pages (headers, footers, page numbers) are removed and wrapped lines are rejoined into paragraphs.

Uploading returns `{ lesson, warning }`. `warning` is set when little text was extracted (for example, image-heavy slides). A PDF with almost no text gets "This PDF looks scanned or image-only; text can't be extracted." (there is no OCR). Old `.doc` / `.ppt` files are rejected with a "save as .docx/.pptx" message.

Errors are always JSON: `{ "error": { "message": "..." } }`.

## Project layout

```
server/   Express + SQLite API (ES modules)
client/   React + Vite app (placeholder until Phase 3)
```
