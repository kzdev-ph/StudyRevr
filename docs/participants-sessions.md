# Participants and session logging

Moved verbatim from CLAUDE.md (full original: docs/CLAUDE-full.md). CLAUDE.md keeps the short rules; this file has the detail.

## Screens
Bottom tab bar: **Review | Flashcard | Mock Quiz | Stats**. Gear icon in header opens **Settings**; beside it a chip shows the participant code in use. Lesson upload lives in **Admin** (Phase 6); the Review tab lists lessons only.

### Participants (Phase 6)
- The app is used by several students on one shared host over local Wi-Fi (`npm run study`: builds the client and the API server serves `client/dist` on one port; it prints the LAN addresses). Every student studies the same lessons.
- On open, a code screen (`ParticipantScreen.jsx`, type-only: no list, no suggestions, P00 never shown) asks for a participant code. `GET /api/participants/:code` checks it (after 5 unknown codes from one address it answers 429 `participant_locked` for 60 s, like the admin PIN); an unknown code shows "That code isn't on the list. Check with your teacher." Codes are normalised (`p7`, `P 7`, `P007` → `P07`; `P` + 1-3 digits). The code is kept in localStorage until **Settings › Switch participant**.
- Codes are created only in admin (`POST /api/admin/participants { codes: "P01-P10, P12" }`); there is no public list or create route. Migration 008 creates `P00` and gives it every record made before it (the researcher's test data).
- Every study request sends `X-Participant`; the server (`server/src/middleware/participant.js`) answers 401 `participant_required` / `participant_unknown` without a listed code, and the client then shows the code screen again.
- Shared by everyone: the teacher's lessons (and students' uploads once shared; see Student uploads), sections (and their cached rewrites), key points/terms, flashcards (the cards), `quiz_distractors`. Per participant: flashcard schedule (`flashcard_progress`), `flashcard_reviews`, daily new/review limits, quiz attempts and answers (resume, retake, previous best), review progress, sessions, events, stats.
- Withdrawal: `npm run participant:delete -- P07` (`server/scripts/delete-participant.js`) shows the rows per table (their `ai_calls` and own AI key included), asks for the code again (`--yes` skips), deletes the participant row (everything cascades), then `secure_delete` + `VACUUM` + `wal_checkpoint(TRUNCATE)` so nothing can be read back. The teacher's lessons stay; the participant's private uploads are deleted with it, shared uploads stay without an owner (see Student uploads).

### Session logging and events (Phase 6)
- A study session starts when a participant opens a lesson's Review (`reading`, any of its views), a flashcard deck (`flashcards`; the All lessons deck has lesson NULL) or the Mock Quiz (`quiz`). `client/src/lib/session.js` (pure, fake-clock tested) + `hooks/useStudySession.js`:
  - only active time counts: interactions are pointerdown, keydown, wheel, touchstart, scroll;
  - 5 min without interaction ends the session at the last interaction (`idle`; the idle minutes are not counted), the next interaction starts a new one;
  - `visibilitychange` hidden pauses the clock and sends the time at once (fetch keepalive); back within 5 min carries on, after longer the session ended when the app went away (`background`) and a new one starts;
  - heartbeat every 30 s (counting only up to the last interaction), `left` when the screen closes, `switched` on Switch participant.
- Server (`server/src/sessions/store.js`): `active_ms` only grows and never exceeds the time since the start; a session with no report for 5 min reads as `unclosed`, ended at its last report.
- Live AI requests (`ai_calls`, written by the server): one row per rewrite request not served from the shared cache, with the source / provider / model that answered, fallback steps and reasons, `from_cache`, `saved_shared`, error code and time.
- Setting changes (`setting_events`, migration 011; the `events` table and its type list are untouched): one row per change of a setting a participant makes, `POST /api/setting-events { setting: 'motion', value: 'system'|'less'|'full' }` or `{ setting: 'theme', value: 'system'|'light'|'dark'|'ama'|'ama-dark' }` (`server/src/events/settings.js`, a zod enum per setting; a value of the other setting is a 400); logged by Settings only when the choice changes, never at startup (a device that never chose shows AMA with no row).
- Self-monitoring events (`events`): `stats_view` (the app, once per Stats open; never from the admin view), `quiz_retake` (the server, when a retake starts), `review_flashcards_tap` (quiz results link), `section_simplify` / `section_translate` (every tap that opens that rewrite, cached or not, with `section_index`).
- Every `study_date` uses the flashcard day: 04:00 Asia/Manila (`server/src/stats/days.js`, built on the scheduler's `studyDay`). A study week runs Monday 04:00 to Monday 04:00.
- Planning metric (`server/src/stats/planning.js`, pure): for each due review of a review-state card (learning steps don't count), the due day comes from the answer's `snapshot.due_at`: answered that study day `on_time`, later `late` with `days_late`; not answered after its due day `still_overdue`; due today and not done yet is not counted.

