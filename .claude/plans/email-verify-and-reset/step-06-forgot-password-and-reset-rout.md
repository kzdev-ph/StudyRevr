What: request a reset link, check a link, set the new password.
For: sonnet-high-applier
Depends on: 5
Status: done

Repo root: D:/claude/pr2/Research_application_pr2_after_chapter_3 (branch feat/accounts). No commits, no pushes.

- Then, in `server/src/routes/auth.js`:
  - `RESET_LINK_BAD = 'This reset link has expired or was already used. Ask for a new one with "Forgot password?".'`,
    `RESET_OFF = 'Password reset by email is not available here. Ask your teacher to reset your password.'`.
  - `POST /auth/forgot` `{ email }`: 503 `email_off` (RESET_OFF) when not configured; parse; IP limit 429 (shared
    `emailIps`); look up; if the account exists and `!emailAccounts.limited(\`reset:${id}\`)`: `void sendResetEmail(...)`.
    Always `202 { ok: true }` (unverified accounts get a reset link too: it proves the inbox).
  - `POST /auth/reset/check` `{ token }`: `safeParse`, `findEmailToken(purpose 'reset')`; null -> 400 `link_invalid`
    RESET_LINK_BAD; else `res.set('cache-control', 'no-store').json({ email: link.email })`. Read-only.
  - `POST /auth/reset` `{ token, password }`:
    ```js
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const link = findEmailToken(db, { token, purpose: 'reset', now: clock() });
    if (!link) throw linkBad(); // 400 link_invalid, RESET_LINK_BAD
    const body = parseBody(resetBody, req.body, `Choose a password of ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`);
    assertNotCommon(body.password, link.email);
    const hash = await hashPassword(body.password);
    db.transaction(() => {
      const now = clock();
      const live = findEmailToken(db, { token, purpose: 'reset', now }); // scrypt took a while: look again
      if (!live || !consumeEmailToken(db, live.id)) throw linkBad();
      setPassword(db, live.account_id, hash, { mustChange: false, now });
      clearFailedLogins(db, live.account_id);
      markVerified(db, live.account_id); // they proved they read this inbox
      db.prepare("DELETE FROM email_tokens WHERE account_id = ? AND purpose = 'reset'").run(live.account_id);
      revokeSessions(db, { accountId: live.account_id, participantId: live.participant_id, reason: 'password_reset', studyEndReason: 'signed_out', now });
    })();
    res.json({ ok: true });
    ```
    with `resetBody = z.strictObject({ token: z.string().regex(TOKEN_SHAPE), password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX) })`.
    A too-short or common password leaves the link usable.
  - `server/test/lesson-access.test.js` `NOT_LESSON_ROUTES`: add `'POST /auth/forgot'`, `'POST /auth/reset/check'`, `'POST /auth/reset'`.
- Verify: same command as Step 5; then a smoke test in Step 9.

Do NOT touch:
- `D:/claude/pr2/Research_application_pr2` (frozen real study data) and `.env` (never read, never print).
- `auth_sessions` table/CHECK and the one-live-login logic in `POST /auth/login` (:91-103); `POST /auth/password`;
  `ChangePasswordScreen.jsx`; the admin temporary-password route; the sign-up rate limiter code (:39-57).
- `server/src/export/research.js` (must never read accounts or email_tokens); `events.type` CHECK; any study table.
- `client/src/styles/tokens.css` (no new colours or radii); `client/index.html`.
- `allowScripts`/`overrides` in the root `package.json`; no other new dependency.
