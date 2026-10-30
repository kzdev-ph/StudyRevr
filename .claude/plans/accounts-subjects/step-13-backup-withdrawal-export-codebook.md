What: Emails and logins are handled everywhere the data goes, and the docs describe accounts.
For: sonnet-high-applier
Depends on: 12, 4
Status: built, server 1063 green; boss to check D5 consent wording

# Step 13: Backup, withdrawal, export codebook and docs

- **`services/backup.js` `stripSecrets` (l.26):** `DELETE FROM auth_sessions` when the table exists. Keep `accounts`, so a restore keeps logins (decision D4). `backup-restore.test.js`: `auth_sessions` is empty, `accounts` is kept.
- **`scripts/delete-participant.js`:**
  - takes an email or a study ID;
  - TABLES gains `['accounts','account (email and password)']` and `['auth_sessions','sign-in sessions']`;
  - the confirmation asks the user to type the study ID; update the usage comment.
  - `delete-participant.test.js`: deleting by email works, and the email's bytes are gone from the db file (scan it like `student-key-wipe.test.js`).
- **Export:**
  - `export/research.js:12` comment and `codebook.js:7`: "Participants appear by study ID only (P01, P02, …). The database holds each student's email and a password hash for signing in; the export never includes them, nor settings or API keys."
  - `codebook.js:113-114` `end_reason`: replace `switched` with "signed_out (signed out on this device) | signed_out_elsewhere (the account signed in on another device) | signed_out_by_admin (the researcher signed the account out or reset its password)".
  - `export.test.js`: create an account with a known email; no file in the export zip contains that email or "scrypt$".
- **Docs:**
  - `CLAUDE.md` "Participants, sessions, admin": accounts, the hidden study ID, `Authorization: Bearer` on every study request, one active login per account plus `session_timeout_seconds`, the admin accounts list, withdrawal by email or ID. Commands: `participant:delete` takes an email.
  - `docs/participants-sessions.md`, `admin.md`, `api.md` (new endpoints; `/participants/:code` and `POST /admin/participants` removed), `data-model.md` (`accounts`, `auth_sessions`, the new end reasons, migrations 018/019), `stats-export-settings.md` (Settings: Signed in as / Sign out), plus one entry in `history.md`.

Done-check: tests are green; `grep -rn "X-Participant" CLAUDE.md docs/*.md` finds hits only in `history.md` and `CLAUDE-full.md`.
Do NOT touch: export columns, `restore.js` logic.

## Audit notes (added 2026-10-30)
- `server/scripts/delete-participant.js`: students don't know their code, so also accept an email (`findAccountByEmail`), show the email when asking to confirm, and add accounts/auth_sessions to TABLES (cascade + secure_delete + VACUUM).
- `services/backup.js`: backups now hold emails linked to P-codes and password hashes: treat as identifying data (docs). `stripSecrets`/restore must delete (or revoke) `auth_sessions` so old tokens don't come back to life.
- Research export does not touch accounts (checked); keep it so.
- Docs: tell the teacher to turn `allow_signups` off after enrolment.
