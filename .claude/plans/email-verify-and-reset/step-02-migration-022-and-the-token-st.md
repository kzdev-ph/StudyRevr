What: add `accounts.email_verified` and `email_tokens`, plus the plain database functions that use them.
For: sonnet-high-applier
Depends on: none
Status: done

Repo root: D:/claude/pr2/Research_application_pr2_after_chapter_3 (branch feat/accounts). No commits, no pushes.

- Then:
  - New `server/src/db/migrations/022_email_verification.sql`:
    ```sql
    -- Email verification and password reset by email. email_verified: 1 = verified (DEFAULT 1, so every account made
    -- before 022, P00's test login and a sign-up while email is not set up count as verified); 0 = a sign-up that still
    -- has to open its link (sign-in is refused until then).
    ALTER TABLE accounts ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1 CHECK (email_verified IN (0, 1));
    -- One-time links sent by email: only the sha256 of the token is stored. A row exists only while its link is
    -- usable: using it deletes it, and a newer link of the same purpose for the account replaces it.
    --   purpose  verify (24 hours) | reset (30 minutes)
    CREATE TABLE email_tokens (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      purpose     TEXT    NOT NULL CHECK (purpose IN ('verify', 'reset')),
      token_hash  TEXT    NOT NULL UNIQUE,
      created_at  TEXT    NOT NULL,
      expires_at  TEXT    NOT NULL
    );
    CREATE INDEX idx_email_tokens_account ON email_tokens(account_id, purpose);
    ```
  - New `server/src/auth/email-tokens.js` exporting `VERIFY_TTL_MS = 24*60*60_000`, `RESET_TTL_MS = 30*60_000`,
    `TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/` (32 random bytes, base64url) and:
    - `issueEmailToken(db, { accountId, purpose, now })` -> token: `newToken()` from `./sessions.js`; in one transaction
      delete rows with `expires_at <= now`, delete this account's rows of `purpose`, insert `tokenHash(token)` with
      `expires_at = now + TTL[purpose]` (ISO strings, compared as text like the rest of the app).
    - `findEmailToken(db, { token, purpose, now })` -> `{ id, account_id, participant_id, email } | null`: null unless
      `typeof token === 'string' && TOKEN_SHAPE.test(token)`; join `accounts`; `purpose = ? AND expires_at > ?`.
    - `consumeEmailToken(db, id)` -> `DELETE ... WHERE id = ?` `.changes === 1` (false: another request used it first).
    - `markVerified(db, accountId)`: `UPDATE accounts SET email_verified = 1`, then delete the account's `verify` rows.
  - `server/src/auth/accounts.js`: add `a.email_verified` to `ACCOUNT_COLUMNS` (:12); `createAccount(db, { email,
    passwordHash, now, verified = true })` inserts `email_verified` = `verified ? 1 : 0` (:51); `listAccounts` selects
    `a.email_verified` and returns `verified: Boolean(r.email_verified)`; `setTestLogin` UPDATE (:144) also sets
    `email_verified = 1`.
  - `server/src/auth/sessions.js`: `findByToken` (:35) also selects `a.email_verified`; `revokeSessions` takes an
    optional `studyEndReason` and calls `endOpenSessions(db, { participantId, reason: studyEndReason ??
    STUDY_END_REASON[reason], now })`. Nothing else changes there.
  - New `server/test/migration-022.test.js` (copy the `db021()` pattern of `migration-021.test.js`, files `< '022'`):
    an account made before 022 reads `email_verified = 1`; `email_tokens` exists; deleting the participant removes its
    `email_tokens` rows (cascade); inserting two live `auth_sessions` rows for one account still throws (one-live-login).
  - Add to `server/test/auth-store.test.js`: issue -> find works; a second issue makes the first null; expired (now +
    TTL) is null; consume twice -> true then false; wrong purpose -> null; malformed token -> null; `createAccount(...,
    { verified: false })` stores 0; `setTestLogin` leaves P00 verified.
- Verify: `cd server && node --import ./test/setup.js --test --test-timeout=10000 test/migration-022.test.js test/auth-store.test.js test/auth-routes.test.js test/admin-accounts.test.js` all pass.

Do NOT touch:
- `D:/claude/pr2/Research_application_pr2` (frozen real study data) and `.env` (never read, never print).
- `auth_sessions` table/CHECK and the one-live-login logic in `POST /auth/login` (:91-103); `POST /auth/password`;
  `ChangePasswordScreen.jsx`; the admin temporary-password route; the sign-up rate limiter code (:39-57).
- `server/src/export/research.js` (must never read accounts or email_tokens); `events.type` CHECK; any study table.
- `client/src/styles/tokens.css` (no new colours or radii); `client/index.html`.
- `allowScripts`/`overrides` in the root `package.json`; no other new dependency.
