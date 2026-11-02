What: add the nodemailer dependency to the server workspace and confirm it has no install script.
For: haiku-xhigh-quick-fix
Depends on: none
Status: done

Repo root: D:/claude/pr2/Research_application_pr2_after_chapter_3 (branch feat/accounts). No commits, no pushes.

- Then:
  - From the repo root: `npm install nodemailer@^10.3.1 -w server` (npm 11; never `npm ci` inside a workspace).
  - nodemailer 10.3.1 has no `preinstall`/`install`/`postinstall` script and no dependencies (checked with
    `npm view nodemailer scripts dependencies`; its `prepare` only runs for git installs). Run `npm install-scripts ls`
    from the root: it must show nothing unreviewed. If it does list nodemailer, run `npm install-scripts deny nodemailer`
    and run `ls` again.
  - Only `server/package.json` (`"nodemailer": "^10.3.1"`) and `package-lock.json` change. Do not touch `overrides` or
    `allowScripts`. If the lockfile diff drops `libc` fields elsewhere, stop and report (npm version problem).
- Verify: `cd server && node -e "import('nodemailer').then(m => console.log(typeof m.default.createTransport))"` prints
  `function`; `git diff --stat` shows only the two files.

Do NOT touch:
- `D:/claude/pr2/Research_application_pr2` (frozen real study data) and `.env` (never read, never print).
- `auth_sessions` table/CHECK and the one-live-login logic in `POST /auth/login` (:91-103); `POST /auth/password`;
  `ChangePasswordScreen.jsx`; the admin temporary-password route; the sign-up rate limiter code (:39-57).
- `server/src/export/research.js` (must never read accounts or email_tokens); `events.type` CHECK; any study table.
- `client/src/styles/tokens.css` (no new colours or radii); `client/index.html`.
- `allowScripts`/`overrides` in the root `package.json`; no other new dependency.
