What: route tests with the fake mailer (no real email is ever sent).
For: sonnet-high-test-writer
Depends on: 5, 6, 7
Status: done

Repo root: D:/claude/pr2/Research_application_pr2_after_chapter_3 (branch feat/accounts). No commits, no pushes.

- Then: new `server/test/auth-email.test.js` in the style of `auth-routes.test.js` (own `api()` helper with raw fetch;
  `startStudyApp({ now, mailer: fakeMailer(), publicUrl: 'https://study.example.test' })`; `linkToken(mailer, kind)`):
  - Sign-up with email on: 201 `{ verify_email: true, email_sent: true }`, no `token`, no `auth_sessions` row,
    `email_verified = 0`, one email to the address whose link starts `https://study.example.test/#/verify/`; text has
    no study ID outside the link. With `fakeMailer({ fail: true })`: 201 `email_sent: false`, account exists.
  - Sign-in before verifying: right password 403 `email_unverified`, no session; wrong password 401 `login_failed`.
  - Verify: 200, then sign-in works; same token again, an unknown token, a malformed one, and one 24 h + 1 s later all
    give the identical 400 body `link_invalid`.
  - Resend: identical 202 body for an unknown, a verified and an unverified email; only the unverified one gets mail;
    a newer link makes the older one 400; the 4th resend in 15 min sends nothing but still answers 202; the 11th
    request from one IP is 429; requests with `X-Forwarded-For: 203.0.113.9` (from 127.0.0.1) use their own bucket.
  - Email off (no mailer): sign-up answers `{ token, account }` and the account is verified; forgot and resend are 503 `email_off`.
  - Forgot: identical status and body for known and unknown emails; only the known gets a `/#/reset/` link.
  - Reset check: `{ email }` for a live link; 400 `link_invalid` after 30 min + 1 s, after use, and for junk.
  - Reset: short password 400 and common password 400 `password_too_common` leave the link usable; then 200; old
    password 401, new one signs in; a locked account (5 wrong) is unlocked; `must_change_password` is cleared; the
    previous login token now gets 401 `password_reset`; its open study session ended `signed_out`; an unverified
    account becomes verified; a second use is 400; a newer reset link makes the older one 400.
  - Admin (extend `server/test/admin-accounts.test.js`): list carries `verified` and `email.configured`, and its JSON
    has no SMTP pass (pass `mail: { pass: 'smtp-secret-pass' }` in config via a custom createApp, or assert on the
    fields); Mark verified -> verified + `admin_events` `email_verified_by_admin` / `P01`; resend -> `{ sent: true }`
    and one email; 409 when verified; 503 without a mailer; 401 without the PIN; 404 for an unknown code.
- Verify: `cd server && npm test` all green.

Do NOT touch:
- `D:/claude/pr2/Research_application_pr2` (frozen real study data) and `.env` (never read, never print).
- `auth_sessions` table/CHECK and the one-live-login logic in `POST /auth/login` (:91-103); `POST /auth/password`;
  `ChangePasswordScreen.jsx`; the admin temporary-password route; the sign-up rate limiter code (:39-57).
- `server/src/export/research.js` (must never read accounts or email_tokens); `events.type` CHECK; any study table.
- `client/src/styles/tokens.css` (no new colours or radii); `client/index.html`.
- `allowScripts`/`overrides` in the root `package.json`; no other new dependency.
