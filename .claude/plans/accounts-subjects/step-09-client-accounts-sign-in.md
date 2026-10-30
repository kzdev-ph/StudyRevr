What: Students sign up and sign in with email and password, the token goes on every study request, the takeover prompt works, and the old device returns to the sign-in screen.
For: sonnet-high-applier
Depends on: 7
Status: built, client 228/228 + server 1014 green, vite build ok; visual check pending; inline Change password in Settings not built (cut-first)

# Step 9: Client accounts — sign in and sign up, token on every request, presence, sign out

**NEW `client/src/lib/auth.js`:**
- **Token:** stored with `storedValue('studyrevr.auth-token', local)`; exports `getToken`, `setToken`, `useSignedIn`. A `storage` event for that key notifies subscribers, so all tabs sign in and out together. Add a notify hook to `lib/store.js` if needed, without changing its API.
- **Account (memory):** `setAccount`, `useAccount`, `useMustChangePassword`.
- **Signed-out notice:** kept in sessionStorage `studyrevr.signed-out`; `takeSignedOutNotice()` returns the message once. Use the server's texts for `signed_out_elsewhere`, `signed_out_by_admin` and `password_reset`.
- **`onBeforeSignOut(fn)`:** the handler may return a promise.
- **`async signOut()`:**
  1. run the handlers and await them for at most 2 s;
  2. `await api.logout()`, ignoring errors;
  3. `setToken(null)`, `setAccount(null)`, `lockAdmin()`.
- **`signedOutByServer(code)`:** clears the same state, stores the notice, and makes no server call.

**`client/src/lib/api.js` (~l.17–33):**
- `headersFor`: `const token = admin ? null : as ?? getToken()`. If there is a token, send `authorization: Bearer <token>`. Never send `x-participant`. Admin calls send the PIN and no token.
- `onRefused`:
  - 401 with `auth_required`, `session_unknown`, `signed_out_elsewhere`, `signed_out_by_admin` or `password_reset` → `signedOutByServer`;
  - 403 `password_change_required` → mark must-change;
  - `admin_pin` as today.
- Remove `checkParticipant`. Add `signup`, `login({ email, password, takeover })`, `logout`, `me(signal)`, `changePassword`.

**Study-session closing:**
- `client/src/lib/session.js`: `send`, `end` and `close` return the promise of the last report. The comment says `'signed_out'`.
- `client/src/hooks/useStudySession.js`: `who = getToken()`; `onBeforeSignOut(() => t.close('signed_out'))`.
- NEW `client/src/hooks/usePresence.js`: while signed in and visible, call `api.me()` at once and then every 20 s; pause while hidden; store the account from each reply.

**NEW `client/src/screens/AuthScreen.jsx`** (replaces ParticipantScreen; reuse its `gate` markup and `participants.css`):
- **Sign in:**
  - email field: type=email, autocomplete=email, autoCapitalize=none
  - password field with a 44 px Show/Hide toggle
  - "Sign in" button, a "Create an account" link-button, and the muted line "Forgot your password? Ask your teacher to reset it."
- **Create your account:**
  - email, password (autocomplete=new-password), "Type it again"
  - hint "At least 8 characters. Use a new password just for StudyRevr."
  - "Create account" button and an "I already have an account" link-button
- **Shared behaviour:**
  - errors are shown in `Notice`;
  - a notice from `takeSignedOutNotice()` appears on top;
  - the quiet "Researcher admin" link stays.
- **On 409 `active_elsewhere`:**
  - show `Notice` "This account is active on another device. Continue here? The other device will be signed out." with a primary "Continue here" (sends the login again with `takeover`) and a quiet "Cancel";
  - keep the password only in component state until then.

**NEW `client/src/screens/ChangePasswordScreen.jsx`:**
- heading "Choose a new password"
- the line "Your teacher gave you a temporary password. Choose your own to keep studying."
- fields: Temporary password, New password, Type it again
- "Save password" button and a quiet "Sign out"

**Wiring:**
- `client/src/App.jsx`:
  - not signed in and not on an admin route → AuthScreen;
  - must change password → ChangePasswordScreen;
  - `usePresence()`;
  - keep the focus effect.
- `Shell.jsx`: the chip shows the email's part before "@" (CSS ellipsis); aria-label "Signed in as <email>. Account settings".
- `SettingsScreen.jsx`: "Signed in as <email>" / "Everything you study is saved to this account." plus a "Sign out" button. CUT-FIRST: an inline "Change password".
- `AdminScreen.jsx:13,327`: use `useSignedIn`.
- `lib/participant.js`: keep only `normalizeCode`.
- Delete `ParticipantScreen.jsx`.

**Tests:**
- `client/test/api.test.js`:
  - STUDENT list: remove `checkParticipant`; add signup, login, logout, me, changePassword;
  - student calls send `authorization: Bearer t1` and no x-participant;
  - ADMIN calls send no authorization;
  - the switch tests become signOut tests (admin is locked after sign-out).
- `session.test.js`: `close` resolves after its report; the reason is `signed_out`.
- `helpers/scenario.mjs`: `setToken('t')`.
- NEW `client/test/auth.test.js`: signOut waits for a slow handler (up to 2 s), then calls logout, then clears the token; `signedOutByServer` shows its notice once; a storage event notifies subscribers.

Done-check: root `npm test` is green. Manual with two devices: sign up, study, sign in on the other device, see the prompt, continue; the first device is back at sign-in within about 20 s with the notice.
Do NOT touch: the server, the PIN logic in `lib/admin.js`, the answer clock, motion.

## Audit notes (Opus audit of Steps 2/5/7, added 2026-10-30)
- Presence ping (GET /auth/me) interval must be at most `session_timeout_seconds` minus 10 s (server touches last_seen at 10 s granularity). With the 30 s minimum timeout, ping every 15-20 s; otherwise a live device looks idle and is replaced without the "Continue here?" prompt. Read the timeout from the server or ping at a fixed 15 s.
- POST /auth/password now returns `{ token, account }` (new token); the client must store the new token.
- GET /api/stats no longer returns the study ID (P-code); do not read `stats.participant` in the client.
