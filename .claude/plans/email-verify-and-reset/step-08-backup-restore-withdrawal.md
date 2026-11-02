What: email links never leave in a backup or survive a restore; withdrawal lists and removes them.
For: sonnet-high-applier
Depends on: 2
Status: done

Repo root: D:/claude/pr2/Research_application_pr2_after_chapter_3 (branch feat/accounts). No commits, no pushes.

- Then:
  - `server/src/services/backup.js` `stripSecrets` (:35-38): after `auth_sessions`, the same guarded delete for
    `email_tokens` (table may not exist in old files). Update the header comment (:7-12) to name email links.
  - `server/scripts/restore.js:125`: after `DELETE FROM auth_sessions`, `db.prepare('DELETE FROM email_tokens').run();`
    (the table exists: migrations ran just above). Update the comment.
  - `server/scripts/delete-participant.js` (:20-33): add `['email_tokens', 'email links (verify / reset)']` to the table
    list and `email_tokens: 'SELECT COUNT(*) AS n FROM email_tokens WHERE account_id IN (SELECT id FROM accounts WHERE participant_id = ?)'`
    to the account-based counts. The delete itself already cascades.
  - Tests: `server/test/backup-restore.test.js` — issue a verify token for P01 before the backup; assert the backup has
    0 `email_tokens` rows and the file bytes do not contain its hash; a restored raw file with a token row ends with 0.
    `server/test/delete-participant.test.js` — a token row of the deleted participant is gone, the other's stays.
    `server/test/export.test.js:120-135` — insert an `email_tokens` row for P01 and also assert its `token_hash` is in no export file.
- Verify: `cd server && node --import ./test/setup.js --test --test-timeout=10000 test/backup-restore.test.js test/delete-participant.test.js test/export.test.js`.

Do NOT touch:
- `D:/claude/pr2/Research_application_pr2` (frozen real study data) and `.env` (never read, never print).
- `auth_sessions` table/CHECK and the one-live-login logic in `POST /auth/login` (:91-103); `POST /auth/password`;
  `ChangePasswordScreen.jsx`; the admin temporary-password route; the sign-up rate limiter code (:39-57).
- `server/src/export/research.js` (must never read accounts or email_tokens); `events.type` CHECK; any study table.
- `client/src/styles/tokens.css` (no new colours or radii); `client/index.html`.
- `allowScripts`/`overrides` in the root `package.json`; no other new dependency.
