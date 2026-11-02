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
