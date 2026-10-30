What: The account API, with a growing per-account lockout stored in the database and one active login per account.
For: sonnet-high-applier
Depends on: 5
Status: done (Opus audit fixes applied, 996/996)

# Step 7: Auth routes — signup, login, one-device, lockout, timeout setting

**NEW `server/src/routes/auth.js`, `authRouter({ db, clock })`.** Mount it in `app.js` with `mount('/api', authRouter({ db, clock }))`.

Request bodies use zod strict objects:
- signup: `{ email: trimmed, lowercased z.email() max 254, password: min 8 max 200 }`
- login: `{ email, password: min 1 max 200, takeover?: boolean }`
- password: `{ current: min 1, next: min 8 max 200 }`
- Anything invalid → 400 with a plain message.

**`POST /auth/signup`:**
- `signupsAllowed(db)` false → 403 `signups_off` "Sign-ups are closed. Ask your teacher."
- In-memory limit per IP: 10 per 10 min → 429 `signup_rate_limited`.
- Hash the password, `createAccount`, `createAuthSession` → 201 `{ token, account: { email, must_change_password: false } }`.
- The study ID is never in the response.

**`POST /auth/login`:**
- No account for the email → `verifyDummy`, then 401 `login_failed` "Email or password is wrong."
- Account locked → 429 `login_locked` "Too many wrong passwords. Try again in N min." plus `retry_after_s`. The password is not checked.
- Wrong password → `recordFailedLogin` → 401 `login_failed`, or 429 if this try triggered the lock.
- Right password → `clearFailedLogins`, then in one transaction:
  - `active = activeSession(...)`;
  - if `active` exists, now − `last_seen_at` < `sessionTimeoutSeconds(db)`·1000, and `takeover` is not set → 409 `active_elsewhere` "This account is active on another device. Continue here?" No token is issued and nothing changes.
  - else if `active` exists → `revokeSessions('signed_out_elsewhere')`, which also ends that device's open study sessions;
  - then `createAuthSession` → 200 `{ token, account: { email, must_change_password } }`.

**The other routes:**
- `POST /auth/logout` (uses `sessionOf`): `revokeSessions('signed_out')` → 204.
- `GET /auth/me` (uses `sessionOf`, which touches `last_seen`; this is the presence ping) → `{ account: { email, must_change_password } }`.
- `POST /auth/password` (uses `sessionOf`):
  - wrong current password → 401 `wrong_password` "That isn't your current password.";
  - otherwise set the new hash, clear `must_change_password`, and answer 204. The session stays.

**`server/src/services/settings.js`:**
- `DEFAULT_SESSION_TIMEOUT_S = 60`.
- `sessionTimeoutSeconds(db)`: a whole number from 30 to 1800, else 60.
- `signupsAllowed(db)`: `getBoolSetting('allow_signups', true)`.
- Add `session_timeout_seconds: z.number().int().min(30).max(1800).optional()` and `allow_signups: z.boolean().optional()` to `appSettingsBody`, `describeAppSettings` and `saveAppSettings`. PUT `/api/settings` then writes `admin_events setting_changed session_timeout_seconds=45` (admin settings are logged there, not in `setting_events`).

**Liveness.** "Active elsewhere" is judged from `auth_sessions.last_seen_at`: the time of the last authenticated request made with that token (any route), written at most every 10 s.
- The client pings `GET /auth/me` every 20 s, and only while the tab is visible (Step 9).
- The 30 s study heartbeat counts too, but nothing relies on it: it runs only on study screens and stops after 5 min idle.
- A hidden or closed device stops counting after the timeout.
- A token never expires by time. The same device returning with its token just continues.

**`server/test/lesson-access.test.js` NOT_LESSON_ROUTES:** add 'POST /auth/signup', 'POST /auth/login', 'POST /auth/logout', 'GET /auth/me', 'POST /auth/password'.

**Tests:** NEW `server/test/auth-routes.test.js` (use startStudyApp and move `t.now`):
- signup gives a token that works on `/api/stats`, and the body has no `/P\d/`
- a duplicate email in other case → 409; signups off → 403
- 5 wrong passwords → 429; after 61 s, login works; a second lock lasts 120 s
- another session seen within 60 s → 409; the same login with `takeover` → 200; the old token → 401 `signed_out_elsewhere`; the old device's open study session gets `end_reason` `signed_out_elsewhere`
- after the old session has been idle longer than the timeout → 200 with no prompt
- a token used again 3 days later on the same device still works
- logout → the token gives 401 and the open study session is `signed_out`
- `me` and `password`
- PUT `/api/settings {session_timeout_seconds:45}` with the PIN → an `admin_events` row; 20 → 400

Done-check: server tests are green.
Do NOT touch: the client, `middleware/admin.js`, `routes/participants.js` (removed in Step 11).
