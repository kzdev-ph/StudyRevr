What: show verified and email status; Mark verified; Resend verification email.
For: sonnet-high-applier
Depends on: 4
Status: done

Repo root: D:/claude/pr2/Research_application_pr2_after_chapter_3 (branch feat/accounts). No commits, no pushes.

- Then, in `server/src/routes/admin-accounts.js` (`adminAccountsRouter({ db, clock, requireAdmin, mailer, linkBase, publicUrlSet })`):
  - `GET /accounts` answer adds `email: { configured: mailer.configured, link_base: linkBase, link_from_env: publicUrlSet }`
    (booleans and the public base only; never host, user, pass or sender).
  - `POST /accounts/:code/verify`: `accountOr404`; in a transaction `markVerified` + `logAdminEvent(db,
    'email_verified_by_admin', account.code, now)`; `200 { verified: true }` (idempotent).
  - `POST /accounts/:code/resend-verification`: `accountOr404`; 503 `email_off` "Email is not set up on this server.
    Use Mark verified instead." when not configured; 409 `already_verified` "This account is already verified."; else
    `logAdminEvent(db, 'verification_resent', account.code, now)` and `200 { sent: await sendVerifyEmail(...) }`
    (no rate limit for admin).
  - admin_events details are study IDs only, never emails.
  - `server/test/lesson-access.test.js:297`: add `'POST /api/admin/accounts/:code/verify'` and
    `'POST /api/admin/accounts/:code/resend-verification'` to the list checked for presence.
- Verify: `cd server && node --import ./test/setup.js --test --test-timeout=10000 test/admin-accounts.test.js test/lesson-access.test.js`.

Do NOT touch:
- `D:/claude/pr2/Research_application_pr2` (frozen real study data) and `.env` (never read, never print).
- `auth_sessions` table/CHECK and the one-live-login logic in `POST /auth/login` (:91-103); `POST /auth/password`;
  `ChangePasswordScreen.jsx`; the admin temporary-password route; the sign-up rate limiter code (:39-57).
- `server/src/export/research.js` (must never read accounts or email_tokens); `events.type` CHECK; any study table.
- `client/src/styles/tokens.css` (no new colours or radii); `client/index.html`.
- `allowScripts`/`overrides` in the root `package.json`; no other new dependency.
