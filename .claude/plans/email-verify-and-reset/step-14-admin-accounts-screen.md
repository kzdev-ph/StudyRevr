What: verified status, email setup line, Mark verified and Resend email buttons.
For: sonnet-high-applier
Depends on: 11
Status: done

Repo root: D:/claude/pr2/Research_application_pr2_after_chapter_3 (branch feat/accounts). No commits, no pushes.

- Then:
  - `client/src/lib/accounts.js` `accountStatus`: after the lock line,
    `if (account.verified === false) return 'Email not verified';` (`=== false` keeps old rows as they were). Add a case
    to `client/test/accounts.test.js` (and that a lock still wins).
  - `client/src/components/AdminAccounts.jsx`: under the intro paragraph, when `data?.email`: configured ->
    `<p className="muted">Email is set up. Links in emails open {link_base}{link_from_env ? '' : " (PUBLIC_URL is not set: this computer's Wi-Fi address)"}.</p>`;
    not configured -> `<Notice tone="warn">Email is not set up, so new sign-ups are not asked to verify and Forgot
    password is off. Set SMTP_HOST, SMTP_USER and SMTP_PASS in .env, then restart the server.</Notice>`.
    In each row's `.accounts-actions`, when `a.verified === false && !a.test`: quiet small "Mark verified"
    (`run(() => api.markVerified(a.code).then(() => setMessage(\`${a.email} is verified.\`)))`) and, only when
    `data.email.configured`, quiet small "Resend email" (`{ sent }` -> message "Sent a new verification link to X." or
    `setProblem('The email could not be sent. The server log says why. You can use Mark verified instead.')`).
    No confirm step (nothing is destroyed). Existing Reset password / Sign out stay.
- Verify: `cd client && npm test && npm run build`; Admin > Accounts at 360 px wide: the buttons wrap, each >= 44 px.

Do NOT touch:
- `D:/claude/pr2/Research_application_pr2` (frozen real study data) and `.env` (never read, never print).
- `auth_sessions` table/CHECK and the one-live-login logic in `POST /auth/login` (:91-103); `POST /auth/password`;
  `ChangePasswordScreen.jsx`; the admin temporary-password route; the sign-up rate limiter code (:39-57).
- `server/src/export/research.js` (must never read accounts or email_tokens); `events.type` CHECK; any study table.
- `client/src/styles/tokens.css` (no new colours or radii); `client/index.html`.
- `allowScripts`/`overrides` in the root `package.json`; no other new dependency.
