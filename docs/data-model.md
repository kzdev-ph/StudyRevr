# Data model

Moved verbatim from CLAUDE.md (full original: docs/CLAUDE-full.md). CLAUDE.md keeps the short rules; this file has the detail.

## Data Model
- `lessons` (id, title, filename, raw_text, word_count, status, error, created_at, source_kind, source_numbers JSON, source_total, origin `admin`|`student`, owner_participant_id → participants ON DELETE SET NULL, shared_at, error_kind `content`|`ai`|`other`, processed_thinking `off`|`high`|`mixed` (no longer written), thinking_level `minimal`|`low`|`medium`|`high`|`mixed`, made_by `gemini`|`claude-haiku`|`mixed`, text_warning `scanned_pdf`|`damaged_text`|`short_text`) (the four after source_total: migration 012; `processed_thinking`: migration 015; `thinking_level`: migration 016; `made_by`: migration 017; `text_warning`: migration 020)
  - `text_warning` is why the upload's text may be poor (`scanned_pdf`: a PDF with little or no text layer; `damaged_text`: letters missing; `short_text`: under 150 words). NULL means nothing was found, the lesson is older than migration 020, or it was made by a script or an import. No CHECK; the messages are `TEXT_WARNINGS` in `services/lesson-access.js`. Not exported.
  - `origin = 'student'` is a student's upload: private to `owner_participant_id` until `shared_at` is set by admin. See Student uploads.
  - `source_numbers[k]` is the real slide / page number (Word: paragraph number) of the k-th block of `raw_text`, `source_kind` is `slide` | `page` | `paragraph` and `source_total` the real count. A slide or page with no text has no block, so a block's place in `raw_text` is not its slide number. NULL on lessons uploaded before migration 005.
- `jobs` (id, lesson_id, stage, status, error, updated_at)
- `sections` (id, lesson_id, position, title, content, simple_version, filipino_version, check_questions JSON `[{ question, answer, evidence }]` (no `evidence` on lessons made before it), sources JSON, check_review JSON `{ hash, round, flags, dropped, made_by, reviewed_at }` (migration 014, the quick-check review))
  - `sources` is the sorted list of slide / page numbers the section was written from. The sections prompt labels each block (`[Slide 3]`) and asks the model for `sources`; in code each number must be a whole number within `source_total` and the number of a block that was in that call's chunk, anything else is dropped and logged, and if nothing is left it is NULL. Original text shows exactly those slides / pages; NULL (older lessons) falls back to a vocabulary match in the client, labelled approximate.
  - `simple_version` stores JSON `{ text, example }`, `filipino_version` stores JSON `{ title, content, check_questions }`; both are made on demand and cached here, the original `content` is never changed.
  - `review_progress.last_section` and `completed_sections` are 0-based indices into the lesson's sections in order.
- `key_points` (id, lesson_id, position, text)
- `key_terms` (id, lesson_id, term, definition, evidence)
- `participants` (id, code UNIQUE, created_at) (migration 008; `P00` made by the migration). Deleting a row cascades to every per-participant table.
- `accounts` (id, participant_id UNIQUE → participants ON DELETE CASCADE, email UNIQUE (trimmed, lowercase), password_hash `scrypt$N$r$p$salt$hash`, must_change_password, failed_logins, lockouts, locked_until, created_at, password_changed_at) (migration 018): the way in to one participant. Identifying data: never exported; backups keep it. `settings.last_study_number` is the highest study number handed out (never reused).
- `auth_sessions` (id, account_id → accounts ON DELETE CASCADE, token_hash UNIQUE (sha256 of the token), created_at, last_seen_at, revoked_at, revoked_reason `signed_out`|`signed_out_elsewhere`|`signed_out_by_admin`|`password_reset`) (migration 018): one live row per account (unique partial index on `account_id WHERE revoked_at IS NULL`). Emptied in backups and on restore.
- `review_progress` (participant_id, lesson_id, last_section, completed_sections JSON, updated_at), PK (participant_id, lesson_id)
- `flashcards` (id, lesson_id, front, back, state, ease, interval, due_at, reps, lapses, step, kind, evidence, position)
  - `kind` `term` | `concept`; `position` is the new-card order within the lesson. Since migration 008 the scheduling columns here are no longer read: the schedule is per participant in `flashcard_progress`.
- `flashcard_progress` (participant_id, flashcard_id, state, step, ease, interval, due_at, reps, lapses), PK (participant_id, flashcard_id)
  - state 0 new / 1 learning / 2 review / 3 relearning; `interval` in days. No row = the card is new for that participant.
- `flashcard_reviews` (id, participant_id, flashcard_id, rating, reviewed_at, prev_interval, new_interval, state, ease, time_ms, snapshot)
  - one row per answer: rating = button (1 Again … 4 Easy), `state` before the answer (daily limits count it), `ease` after, intervals in days (a learning step is a fraction of a day), `snapshot` = the participant's scheduling fields before the answer plus `existed` (for undo: a card that had no progress row gets none again; undo deletes the row).
- `quiz_questions` (id, lesson_id, question, choices JSON, answer_index, explanation)
- `quiz_attempts` (id, participant_id, lesson_id, score, total, answers JSON, taken_at, + migration 007 columns)
- `study_sessions` (id, participant_id, lesson_id (SET NULL; NULL = All lessons deck), activity `reading`|`flashcards`|`quiz`, started_at, last_active_at, ended_at, active_ms, end_reason `left`|`idle`|`background`|`switched` (old rows only)|`signed_out`|`signed_out_elsewhere`|`signed_out_by_admin` (migration 019; NULL while open), study_date) (rebuilt in migration 008)
- `events` (id, participant_id, type `stats_view`|`quiz_retake`|`review_flashcards_tap`|`section_simplify`|`section_translate`, lesson_id, attempt_id, section_index, created_at, study_date)
- `setting_events` (id, participant_id → participants ON DELETE CASCADE, study_date, setting `motion`, value `system`|`less`|`full`, created_at) (migration 011)
- `participant_ai_keys` (participant_id PK → participants ON DELETE CASCADE, provider, model, api_key, key_last4, created_at, updated_at) (migration 009): a student's own key, saved only after a passing test; never returned, exported or backed up.
- `ai_calls` (id, participant_id → participants ON DELETE CASCADE (NULL: no participant), lesson_id SET NULL, section_id, section_index (0-based), kind `simplify`|`translate`, outcome `ok`|`failed`, source `student`|`default`|`gemma` (NULL when failed), provider, model, fallback_steps, fallback_reasons, from_cache, saved_shared, error_code, ms, created_at, study_date, thinking `off`) (migration 009; `thinking` migration 015: always `off`, live calls never think)
- `admin_events` (id, type (`backup` | `setting_changed` | `lesson_shared`), detail (file name, `key=value`, `lesson N from P07`), created_at) (migration 009; the last two types in Phase 7B)
- `lesson_events` (id, participant_id → participants ON DELETE CASCADE, type `lesson_uploaded`|`lesson_upload_failed`|`lesson_deleted_by_student`|`lesson_shared`, lesson_id (plain integer, no FK), lesson_title, actor `student`|`admin`, detail, created_at, study_date) (migration 012)
- `settings` also holds `allow_student_uploads` (default `false`) and `student_uploads_per_day` (default `2`) (migration 012)
- `sections` gains `simple_made_by`, `filipino_made_by` ("provider/model" of the shared version; migration 009)
- `settings` (key, value); `allow_student_keys` (default `false`, migration 009)

