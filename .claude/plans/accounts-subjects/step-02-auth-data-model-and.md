What: Migrations for accounts and login sessions, new study-session end reasons, and pure modules for passwords, accounts and login sessions.
For: sonnet-high-applier
Depends on: none
Status: done (Opus audit fixes applied, 996/996)

# Step 2: Auth data model and store (server; no routes yet)

**Files:**
- NEW `server/src/db/migrations/018_accounts.sql` (header comments in the style of 008):
```sql
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id INTEGER NOT NULL UNIQUE REFERENCES participants(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,                 -- trimmed + lowercased in code
  password_hash TEXT NOT NULL,                -- scrypt$16384$8$1$<salt b64url>$<hash b64url>
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  lockouts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  password_changed_at TEXT);
CREATE TABLE auth_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,            -- sha256 hex; the token itself is never stored
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, revoked_at TEXT,
  revoked_reason TEXT CHECK (revoked_reason IN ('signed_out','signed_out_elsewhere','signed_out_by_admin','password_reset')));
CREATE UNIQUE INDEX idx_auth_sessions_one_active ON auth_sessions(account_id) WHERE revoked_at IS NULL;
```
- NEW `019_session_end_reasons.sql`: rebuild `study_sessions` exactly as in 008 (same columns, foreign keys, both indexes). The only change is:
  `end_reason CHECK (end_reason IN ('left','idle','background','switched','signed_out','signed_out_elsewhere','signed_out_by_admin'))`
  Copy rows with explicit columns, id included.
- NEW `server/src/auth/passwords.js` (node:crypto only; no new dependency):
  - `hashPassword(pw)`: async scrypt, N=16384, r=8, p=1, keylen 64, 16-byte salt.
  - `verifyPassword(pw, stored)`: async; a malformed hash returns false; compares with timingSafeEqual.
  - `verifyDummy(pw)`: checks against a hash made lazily once, so unknown emails take as long as real ones.
  - `temporaryPassword()`: 10 characters from `abcdefghjkmnpqrstuvwxyz23456789`, chosen with `crypto.randomInt`.
  - `PASSWORD_MIN = 8`, `PASSWORD_MAX = 200`.
- NEW `server/src/auth/accounts.js`:
  - `normalizeEmail`, `findAccountByEmail`, `findAccountByCode`.
  - `nextStudyCode(db)`:
    - n = the larger of the settings row `last_study_number` and the highest number among participants other than P00, plus 1.
    - Above 999 → HttpError 503 `signups_full`.
    - Writes `last_study_number`, so a withdrawn ID is never reused.
  - `createAccount(db, { email, passwordHash, now })`, in one transaction:
    - an email that is taken → 409 `email_taken` "An account with this email already exists. Sign in instead."
    - otherwise get the next code, INSERT the participant, INSERT the account, and return `{ accountId, participantId, code }`.
  - Lockout:
    - `MAX_FAILED = 5`, `LOCK_BASE_MS = 60_000`, `LOCK_MAX_MS = 900_000`.
    - `lockedMs(account, now)`.
    - `recordFailedLogin(db, account, now)`: at the 5th failure, `locked_until` = now + min(BASE·2^lockouts, MAX); `lockouts` + 1; `failed_logins` back to 0. Returns `{ lockedMs }`.
    - `clearFailedLogins(db, accountId)`.
  - `setPassword(db, accountId, hash, { mustChange, now })`.
- NEW `server/src/auth/sessions.js`:
  - `newToken()`: 32 random bytes, base64url.
  - `tokenHash(t)`: sha256 hex.
  - `createAuthSession(db, accountId, now)`: returns the token.
  - `findByToken(db, token)`: returns `{ id, account_id, participant_id, code, email, must_change_password, last_seen_at, revoked_at, revoked_reason }` or null.
  - `activeSession(db, accountId)`.
  - `touch(db, session, now)`: writes `last_seen_at` only when it is at least `TOUCH_MS = 10_000` old.
  - `revokeSessions(db, { accountId, participantId, reason, now })`, in one transaction:
    - revoke the active row;
    - call `endOpenSessions` with the matching study-session reason: `signed_out` → `signed_out`; `signed_out_elsewhere` → `signed_out_elsewhere`; `signed_out_by_admin` and `password_reset` → `signed_out_by_admin`.
    - Returns how many were revoked.
- `server/src/sessions/store.js:10`:
  - `END_REASONS` (what the app may send) becomes `['left','idle','background','switched','signed_out']`; `switched` goes in Step 11.
  - Add `SERVER_END_REASONS = ['signed_out_elsewhere','signed_out_by_admin']`.
  - Add `endOpenSessions(db, { participantId, reason, now })`:
    `UPDATE study_sessions SET ended_at = last_active_at, end_reason = ? WHERE participant_id = ? AND ended_at IS NULL AND last_active_at >= now − STALE_MS`
    Older open rows stay as they are and keep reading as `unclosed`.
  - In `routes/sessions.js:61`, build the 400 message from `END_REASONS`.

**Tests:**
- NEW `server/test/auth-store.test.js`:
  - a hash round trip works; a wrong password and a malformed hash return false; two hashes of the same password differ; the temporary password has the right shape
  - the first two accounts get P01 and P02, and P00 is never handed out; after P02's participant is deleted, the next signup gets P03
  - "JUAN@x.com " and "juan@x.com" collide with 409
  - a second un-revoked `auth_sessions` row for one account throws
  - `revokeSessions` sets the reason, ends a study session last active 1 min ago with that reason, and leaves one last active 10 min ago open
  - lockout: 5 failures lock for 60 s; after that expires, 5 more lock for 120 s; the wait caps at 15 min; `clearFailedLogins` resets everything
- NEW `server/test/migration-019.test.js`: an existing row survives with its id; `signed_out_elsewhere` is accepted; `bogus` is rejected.

Done-check: `npm test` in `server/` is green.
Do NOT touch: migrations 001–017, the middleware, other routes, the client.
