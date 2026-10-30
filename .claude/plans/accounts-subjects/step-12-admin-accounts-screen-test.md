What: The admin "Participants" add-codes form becomes an accounts list with Reset password and Sign out, plus a P00 test login and the two settings.
For: sonnet-high-applier
Depends on: 11
Status: built, server 1056 + client 230 green; audit running; UI check pending

# Step 12: Admin accounts screen, test login, timeout and sign-up settings

**Server:**
- NEW `server/src/routes/admin-accounts.js`, `adminAccountsRouter({ db, clock, requireAdmin })`. It starts with `router.use(requireAdmin)` and is mounted with `mount('/api/admin', adminAccountsRouter(...))`.
  - `GET /accounts` → `{ timeout_s, accounts: [...] }`, ordered by code. Each row has `{ code, email, created_at, test: code==='P00', signed_in, active_now, last_seen_at, locked_until, must_change_password }`.
  - `POST /accounts/:code/reset-password`:
    - `temporaryPassword()`, `setPassword(mustChange: true)`, `clearFailedLogins`, `revokeSessions('password_reset')`;
    - answers `{ temporary_password }`; the password is never logged;
    - writes `admin_events` `password_reset` with the code as detail.
  - `POST /accounts/:code/sign-out`: `revokeSessions('signed_out_by_admin')` → `{ signed_out: n }`; writes `admin_events` `signed_out_by_admin`.
  - `PUT /accounts/test-login {email, password}`: creates or replaces P00's account (409 if the email belongs to someone else) and revokes P00's session; writes `admin_events` `test_login_set`.
  - An unknown code → 404 "No account with that study ID."
- `server/src/auth/accounts.js`: `listAccounts(db, now, timeoutMs)`.
- `routes/admin.js`: remove `POST /participants` (adding codes) and its imports. Keep the summary and stats routes.

**Client:**
- `api.js`, all with `admin: true`: add `adminAccounts`, `resetPassword(code)`, `signOutAccount(code)`, `setTestLogin`; remove `addParticipants`. Update `api.test.js` ADMIN.
- NEW `client/src/components/AdminAccounts.jsx`:
  - **Table:** Study ID (a link to `paths.adminParticipant`), Email, Status (Active now / Signed in / Signed out / Locked until HH:MM / Must change password; P00 is "Your test login").
  - **Reset password:** an inline confirm "Give <email> a temporary password? They will be signed out.", then the password in a `Notice` with a Copy button and "Read it to the student; they choose a new one when they sign in."
  - **Sign out:** an inline confirm.
  - **Test login (P00) form:** email and password.
  - Use existing admin classes, `btn` / `btn--quiet`, and 44 px targets.
- `AdminScreen.jsx` `ParticipantsSection`:
  - remove the add-codes form;
  - retitle it "Study summary", with the help text "Each account has a study ID (P01…); students never see it. To withdraw someone: npm run participant:delete -- <email or study ID>.";
  - render `<AdminAccounts/>` above it.
- `AdminAiSettings.jsx`, following the `show_taglish` pattern:
  - a switch "Allow new sign-ups";
  - a number field "Ask before signing in on a new device while the account was active in the last … seconds" (30–1800, default 60), with the help text "Only matters when a different device signs in."

**Tests:**
- NEW `server/test/admin-accounts.test.js`:
  - the list needs the PIN and shows email and code;
  - after a reset, the old token → 401 `password_reset`; the temporary login → study route 403 → change password → 200;
  - sign-out → study session `signed_out_by_admin`;
  - after setting the P00 test login, signing in as P00 works and its records are left out of the export by default.
- Remove the add-codes test.

Done-check: tests are green; manual walk through the admin screen.
Do NOT touch: `middleware/admin.js`, the export, `GET /admin/participants`.

## Audit notes (added 2026-10-30)
- Reset password and Sign out everywhere must also clear `failed_logins`, `lockouts` and `locked_until`.
- S5 accepted risk: anyone knowing an email can keep an account locked (5 requests per lock window). Admin reset clears it.
- S6: junk sign-ups use up study numbers (never reused, stop at 999). Show a hint near the `allow_signups` switch: turn sign-ups off after enrolment. Consider tightening the signup limiter to 3/hour/IP.
- N6: behind a proxy all students share one IP for the signup limiter; document.
