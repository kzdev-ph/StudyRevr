What: `X-Participant` gets no access anywhere, the code-check route is gone, and students never receive their study ID.
For: sonnet-high-applier
Depends on: 9
Status: built, server 1048 + client 228 green; Opus audit batched with Step 12

# Step 11: Students no longer use codes — remove the old header and migrate the remaining tests

**Source changes:**
- `middleware/participant.js`: delete the legacy `X-Participant` branch and `PARTICIPANT_HEADER`.
- Delete `server/src/routes/participants.js`, together with its import and mount in `app.js:61`. Remove 'GET /participants/:code' from NOT_LESSON_ROUTES.
- `sessions/store.js`: `END_REASONS` drops `'switched'` (the CHECK keeps it for old rows).
- `routes/stats.js`: the student response leaves out `participant`:
  `const { participant: _id, ...stats } = participantStats(...)`
  Admin's `/admin/participants/:code/stats` keeps it.

**Test migration:**
- `test/helpers.js`: `STUDY_HEADERS = { authorization: \`Bearer ${TEST_TOKEN}\`, 'x-admin-pin': TEST_PIN }`.
- Call `seedTestLogin(db)` on the db passed to `createApp` in each of these 9 files: extraction, flashcards-api, lessons, pipeline, quiz-api, section-sources, sections, settings-ai, zipguard (all `*.test.js`).
- Replace direct `x-participant` headers with `tokenFor` tokens in:
  - `backup-restore.test.js:155,164`. Line 167 called `/api/participants/P01`; use `GET /api/auth/me` with that token instead.
  - `live-ai.test.js:192`
  - `prepare-versions.test.js:51`
  - `student-uploads.test.js:46,240,262,271,278,285`
- `participants.test.js`:
  - keep the `normalizeCode` / `parseCodeList` unit tests and the isolation tests;
  - replace the code-check and code-lockout tests with: "X-Participant alone is 401 auth_required on every study route" and "a valid token works".

**Tests:** GET `/api/stats` as a student has no `participant` key.
Done-check: root `npm test` is green; `grep -rni "x-participant" server/src client/src` finds nothing.
Do NOT touch: the admin PIN, the export queries.

## Audit notes (added 2026-10-30)
- S2: until this step lands, any device can send `X-Participant: P03` and act as a signed-up account (no password). Removing the legacy branch in `middleware/participant.js` is mandatory; do not deploy before it.
- helpers: tests using STUDY_HEADERS/X-Participant move to Bearer (TEST_TOKEN / seedTestLogin).
