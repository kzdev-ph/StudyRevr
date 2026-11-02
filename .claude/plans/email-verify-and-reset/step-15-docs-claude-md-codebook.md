What: document the feature where each area is documented.
For: haiku-xhigh-quick-fix
Depends on: 1-14
Status: todo

Repo root: D:/claude/pr2/Research_application_pr2_after_chapter_3 (branch feat/accounts). No commits, no pushes.

- Then:
  - `docs/api.md:15` (Accounts line): signup answer with email on; login 403 `email_unverified`; `POST /api/auth/verify`,
    `/auth/verify/resend` (202, 429 `email_rate_limited`, 503 `email_off`), `/auth/forgot`, `/auth/reset/check`,
    `/auth/reset` (400 `link_invalid`); admin `POST /api/admin/accounts/:code/verify`, `/resend-verification`; list `email`.
  - `docs/data-model.md:18-19`: `accounts.email_verified` (022, DEFAULT 1) and the `email_tokens` table (emptied in backups and on restore).
  - `docs/participants-sessions.md:10-14`: an "Email verification and Forgot password" bullet (email on/off rule,
    PUBLIC_URL, links in the fragment, limits, reset revokes logins); line 23: `signed_out` also covers a student's own reset by email.
  - `docs/admin.md:6-7`: Accounts shows Email not verified, Mark verified, Resend email, the email setup line; backup
    also strips `email_tokens`; `admin_events` types `email_verified_by_admin`, `verification_resent`.
  - `docs/stats-export-settings.md:18`: `email_tokens` is never read by the export.
  - `docs/parsing-and-install.md`: nodemailer in the dependency list (no install script; checked with `npm install-scripts ls`).
  - `docs/history.md`: short entry for this change and the audit note below.
  - `server/src/export/codebook.js:114`: `signed_out (signed out on this device, or the student reset their own
    password by email)`; keep the text `signed_out (` (export.test.js checks it).
  - `CLAUDE.md`: line 10 add "nodemailer for email links (`server/src/mail/`)"; line 48 add one sentence: "New sign-ups
    verify their email by link before studying, and Forgot password emails a 30-min reset link (only while SMTP_* is
    set in `.env`; links built from `PUBLIC_URL`, never the Host header); Admin > Accounts can Mark verified."; line 55
    add "and email links (`email_tokens`)" to what backup strips.
- Verify: `cd server && npm test` (codebook test); `git diff --stat` shows docs only for this step.

Do NOT touch:
- `D:/claude/pr2/Research_application_pr2` (frozen real study data) and `.env` (never read, never print).
- `auth_sessions` table/CHECK and the one-live-login logic in `POST /auth/login` (:91-103); `POST /auth/password`;
  `ChangePasswordScreen.jsx`; the admin temporary-password route; the sign-up rate limiter code (:39-57).
- `server/src/export/research.js` (must never read accounts or email_tokens); `events.type` CHECK; any study table.
- `client/src/styles/tokens.css` (no new colours or radii); `client/index.html`.
- `allowScripts`/`overrides` in the root `package.json`; no other new dependency.
