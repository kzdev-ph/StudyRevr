-- Accounts: a student signs up with an email and a password and is handed the next study code (P01, P02, ...).
-- The participant row stays the owner of all study data, so every table that points at participants keeps working;
-- an account is the way in to one participant. Deleting a participant deletes the account and its login sessions
-- (cascade), so withdrawal still removes everything.
--   email                 trimmed and lowercased in code before it is stored or looked up
--   password_hash         scrypt$<N>$<r>$<p>$<salt, base64url>$<hash, base64url>; the password itself is never stored
--   must_change_password  1 after an admin reset, until the student picks a new password
--   failed_logins         wrong passwords since the last good sign-in or lockout
--   lockouts              how many times this account has been locked (each lock lasts longer, up to 15 minutes)
--   locked_until          sign-in is refused until this time (NULL when not locked)
CREATE TABLE accounts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id        INTEGER NOT NULL UNIQUE REFERENCES participants(id) ON DELETE CASCADE,
  email                 TEXT    NOT NULL UNIQUE,
  password_hash         TEXT    NOT NULL,
  must_change_password  INTEGER NOT NULL DEFAULT 0,
  failed_logins         INTEGER NOT NULL DEFAULT 0,
  lockouts              INTEGER NOT NULL DEFAULT 0,
  locked_until          TEXT,
  created_at            TEXT    NOT NULL,
  password_changed_at   TEXT
);

-- Login sessions: one signed-in browser per account at a time. Signing in somewhere else revokes the old row.
--   token_hash      sha256 hex of the token the browser holds; the token itself is never stored
--   revoked_at      NULL while the session is live
--   revoked_reason  signed_out | signed_out_elsewhere (signed in on another device) | signed_out_by_admin | password_reset
CREATE TABLE auth_sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash      TEXT    NOT NULL UNIQUE,
  created_at      TEXT    NOT NULL,
  last_seen_at    TEXT    NOT NULL,
  revoked_at      TEXT,
  revoked_reason  TEXT    CHECK (revoked_reason IN ('signed_out', 'signed_out_elsewhere', 'signed_out_by_admin', 'password_reset'))
);
CREATE UNIQUE INDEX idx_auth_sessions_one_active ON auth_sessions(account_id) WHERE revoked_at IS NULL;
