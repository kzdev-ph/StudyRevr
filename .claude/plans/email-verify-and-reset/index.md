What: overview and shared rules. For: boss only.

# Email verification and Forgot password (feat/accounts)

Goal: new sign-ups verify their email by a one-time link (Gmail SMTP) before they can study; students reset a forgotten password through an emailed link that opens a "Password Reset" screen (email greyed out, Password, Confirm password, Reset).

User decisions: Gmail SMTP with app password in .env; links from PUBLIC_URL (Cloudflare tunnel); existing accounts count as verified; if email is not set up, sign-up behaves as today; unverified sign-ups keep their study ID (withdraw with participant:delete); user approved building ("lets just build the app", 2026-11-02).

Do NOT touch:
- `D:/claude/pr2/Research_application_pr2` (frozen real study data) and `.env` (never read, never print).
- `auth_sessions` table/CHECK and the one-live-login logic in `POST /auth/login` (:91-103); `POST /auth/password`;
  `ChangePasswordScreen.jsx`; the admin temporary-password route; the sign-up rate limiter code (:39-57).
- `server/src/export/research.js` (must never read accounts or email_tokens); `events.type` CHECK; any study table.
- `client/src/styles/tokens.css` (no new colours or radii); `client/index.html`.
- `allowScripts`/`overrides` in the root `package.json`; no other new dependency.

Shared rules: never touch D:/claude/pr2/Research_application_pr2; never read or print .env or keys; plain JS; no commits or pushes; tests must not send real mail.

| # | Title | For | Depends on | Status |
|---|---|---|---|---|
| 1 | Add nodemailer | haiku-xhigh-quick-fix | none | done |
| 2 | Migration 022 and the token store | sonnet-high-applier | none | done |
| 3 | Mail module and config | sonnet-high-applier | 1 | done |
| 4 | Wiring, limiter, participant gate | sonnet-high-applier | 2, 3 | done |
| 5 | Sign-up, sign-in and verification routes | sonnet-high-applier | 4 | done |
| 6 | Forgot password and reset routes | sonnet-high-applier | 5 | done |
| 7 | Admin > Accounts routes | sonnet-high-applier | 4 | done |
| 8 | Backup, restore, withdrawal | sonnet-high-applier | 2 | done |
| 9 | Startup log and .env.example | haiku-xhigh-quick-fix | 4 | done |
| 10 | Server tests for the email flows | sonnet-high-test-writer | 5, 6, 7 | done |
| 11 | Client libraries | sonnet-high-applier | none (server shapes from Steps 5-7) | done |
| 12 | Sign-in screen: Forgot password and Check your inbox | sonnet-high-applier | 11 | done |
| 13 | Public screens: Verify email and Password Reset | sonnet-high-applier | 11 | done |
| 14 | Admin > Accounts screen | sonnet-high-applier | 11 | done |
| 15 | Docs, CLAUDE.md, codebook | haiku-xhigh-quick-fix | 1-14 | todo |

Run order: 1 to 15 (11 can start after the server shapes exist). After step 10: sonnet-high-auditor or opus-high-reasoner audit (auth and user data). After 12-14: sonnet-high-ui-checker.
