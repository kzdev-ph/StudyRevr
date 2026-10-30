What: Study requests are identified by `Authorization: Bearer <token>`; the identity check, its error codes and last-seen updates live in one place.
For: sonnet-high-applier
Depends on: 2
Status: done (Opus audit fixes applied, 996/996)

# Step 5: Token auth in the middleware (old code header kept for now) and test helpers

**`server/src/middleware/participant.js`:**
- `participantOf(db, req)` is memoised per request (a WeakMap keyed by `req`):
  1. **Bearer token present.** Look it up with `findByToken`.
     - Not found → 401 `session_unknown` "Please sign in again."
     - Revoked → 401, with the code taken from `revoked_reason` (`signed_out` maps to `session_unknown`):
       - `signed_out_elsewhere`: "You were signed out because your account was opened on another device."
       - `signed_out_by_admin`: "Your teacher signed you out. Sign in again."
       - `password_reset`: "Your teacher reset your password. Sign in with the new one."
     - `must_change_password` → 403 `password_change_required` "Choose a new password first."
     - Otherwise `touch(db, session, now)`, with `now = req.app.get('clock')?.() ?? new Date()`, and return `{ id: participant_id, code, accountId, sessionId }`.
  2. **LEGACY, removed in Step 11 (say so in a comment):** no Authorization header but `X-Participant` present → behaviour unchanged from today.
  3. **Neither** → null.
- Export `sessionOf(db, req)`: the same Bearer lookup and 401s, but without the must-change gate (for the `/auth` routes).
- `requireParticipant`: null → 401 `auth_required` "Sign in first."

**Other files:**
- `server/src/app.js`: `app.set('clock', clock)` right after `express()`.
- `server/test/helpers.js`:
  - `tokenFor(db, code, now)`, cached per db:
    - a missing participant gives `'no-such-token'`;
    - otherwise create, if missing, an account (`<code lowercased>@test.invalid`, `password_hash 'test'`) and an active session (`createAuthSession`), and return the token.
  - `t.call({ as })` sends `authorization: Bearer ${tokenFor(t.db, as, new Date(t.now))}` instead of x-participant.
  - Add `TEST_TOKEN = 'test-token-p00'` and `seedTestLogin(db)`: a P00 account plus an active session whose `token_hash = tokenHash(TEST_TOKEN)`. These are used in Step 11.
  - `STUDY_HEADERS` is unchanged for now. Update the comments at lines 57–66.
- Fix the assertions that name the old identity codes:
  - `lesson-access.test.js:159`: 'participant_required' → 'auth_required'.
  - In `participants.test.js`, only where a test sends no identity (→ `auth_required`) or an unknown code through `as` (→ `session_unknown`). Tests of `/api/participants/:code` stay as they are.

**Tests:** NEW `server/test/auth-middleware.test.js`:
- a token works on GET `/api/stats` and POST `/api/sessions`
- an unknown token → 401 `session_unknown`
- each revoke reason → 401 with its code
- `must_change` → 403
- `last_seen_at` moves only after 10 s on the fake clock
- a valid token plus `X-Participant: P02` acts as the token's participant

Done-check: server and client tests are green; the running app still works with codes.
Do NOT touch: `middleware/admin.js`, the client, the routes.
