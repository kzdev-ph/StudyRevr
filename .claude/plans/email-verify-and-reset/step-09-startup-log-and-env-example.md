What: say at startup whether email is on and where links point; document the new names.
For: haiku-xhigh-quick-fix
Depends on: 4
Status: done

Repo root: D:/claude/pr2/Research_application_pr2_after_chapter_3 (branch feat/accounts). No commits, no pushes.

- Then:
  - `server/src/index.js` inside the `listen` callback (:21-28): `const mailOn = Boolean(config.mail.host && config.mail.user && config.mail.pass);`
    on: `[mail] email is on (<host>:<port>); links in emails open <app.get('linkBase')>`; plus, when `!config.publicUrl`:
    `[mail] PUBLIC_URL is not set: links use this computer's Wi-Fi address, so they open only on this network`.
    off: `[mail] email is off: set SMTP_HOST, SMTP_USER and SMTP_PASS in .env. New sign-ups are not asked to verify; Forgot password is off.`
    Never print user, pass or from.
  - `.env.example`: a new block after ADMIN_PIN with NAMES ONLY (empty values) `SMTP_HOST=`, `SMTP_PORT=`, `SMTP_USER=`,
    `SMTP_PASS=`, `MAIL_FROM=`, `PUBLIC_URL=`, and comments: Gmail = host smtp.gmail.com, port 465, user = the Gmail
    address, pass = an app password (Google Account > Security > 2-Step Verification > App passwords; spaces ignored);
    leaving host/user/pass empty turns email off (sign-ups not asked to verify, Forgot password off); MAIL_FROM optional
    (default "StudyRevr <SMTP_USER>"); PUBLIC_URL = the address students open (the Cloudflare tunnel URL changes on
    every start: update it and restart), empty = this computer's Wi-Fi address and PORT.
- Verify: `cd server && npm test` passes; start the server with email unset and see the "email is off" line.

Do NOT touch:
- `D:/claude/pr2/Research_application_pr2` (frozen real study data) and `.env` (never read, never print).
- `auth_sessions` table/CHECK and the one-live-login logic in `POST /auth/login` (:91-103); `POST /auth/password`;
  `ChangePasswordScreen.jsx`; the admin temporary-password route; the sign-up rate limiter code (:39-57).
- `server/src/export/research.js` (must never read accounts or email_tokens); `events.type` CHECK; any study table.
- `client/src/styles/tokens.css` (no new colours or radii); `client/index.html`.
- `allowScripts`/`overrides` in the root `package.json`; no other new dependency.
