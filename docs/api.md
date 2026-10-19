# API

Moved verbatim from CLAUDE.md (full original: docs/CLAUDE-full.md). CLAUDE.md keeps the short rules; this file has the detail.

## API
- `POST /api/lessons` upload + start job
- `GET /api/lessons` / `GET /api/lessons/:id` / `DELETE /api/lessons/:id` (all filtered by visibility, see Student uploads; a student may delete only their own unstudied private upload)
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
- `GET /api/admin/lessons/:id/leaks` (admin; flagged cards and skipped quiz questions, `can_regenerate`) · `POST /api/admin/flashcards/:id/regenerate` (admin; 409 `lesson_has_records` / `lesson_busy` / `card_changed`, 422 `card_not_better`)
- `POST /api/lessons/:id/quiz-options` (admin; make the missing or leaking quiz wrong answers, 202 + job status; 409 while the lesson is processing/failed/busy or nothing is missing). `GET /api/lessons?counts=1` (admin only, behind the PIN; the leak checks run only here, not on the students' list or its polls) rows carry `quiz_options: { missing, weak, status, error }`, `leaks: { cards }` and `quiz_review: { reviewed, flagged, pending, checks, status, error }`. `POST /api/admin/lessons/:id/quiz-review` (admin, "Review again"; 202, the lesson stays ready; 409 while the lesson is not ready or busy, or has nothing to review).
- `GET /api/backup` / `POST /api/backup` (JSON backup: not built; Phase 7A's database backup is `GET /api/admin/backup`)
- Phase 7A: `GET /api/settings` / `PUT /api/settings` (admin: `{ flashcard_new_per_day, allow_student_keys }`) · `POST /api/setting-events` (student, `{ setting: 'motion', value }`) · `POST /api/lessons/:id/section-versions` (admin, Prepare) · `GET /api/admin/ai-problems` (the Default AI's settings problems from the last 24 hours) · `GET /api/admin/backup` / `GET /api/admin/backup/last` · student (`X-Participant`): `GET /api/my-ai` (`{ allowed, default, providers, key }`), `POST /api/my-ai/models` (`{ provider, apiKey? }`), `POST /api/my-ai/key` (`{ provider, model, apiKey }`), `DELETE /api/my-ai/key` (403 `student_keys_off` for the first two while off) · `POST /api/sections/:id/simplify|translate` answers carry `shared`, `answered_by`, `fallback`
- Phase 7B: `POST /api/lessons` without the PIN = a student's upload (`student_uploads_off`, `upload_rate_limited`, `upload_quota`, `upload_busy`, `upload_in_flight`, `no_text`, `wrong_content`) · `GET /api/my-uploads` (student: `{ allowed, per_day, used_today, left_today, max_mb }`) · `POST /api/lessons/:id/retry` (admin, or the owner of a failed upload, free) · `POST /api/lessons/:id/share` (admin; one way) · `PUT /api/settings` also takes `{ allow_student_uploads, student_uploads_per_day }` (and `show_taglish`, feat/study-prep) · lesson rows carry `origin`, `mine`, `shared`, `can_delete`, `can_retry`, and (admin only) `owner_code`; `GET /api/lessons/:id/status` carries `can_retry`

