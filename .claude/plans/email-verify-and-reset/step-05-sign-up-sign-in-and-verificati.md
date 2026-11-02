What: sign-up asks for verification when email is on; sign-in refuses unverified accounts; verify and resend routes.
For: sonnet-high-applier
Depends on: 4
Status: done

Repo root: D:/claude/pr2/Research_application_pr2_after_chapter_3 (branch feat/accounts). No commits, no pushes.

- Then, all in `server/src/routes/auth.js` (`authRouter({ db, clock, mailer = { configured: false, send: async () => false }, linkBase = '' })`):
  - Schemas: `const emailBody = z.strictObject({ email })`; `const tokenBody = z.strictObject({ token: z.string().regex(TOKEN_SHAPE) })`.
  - Limiters inside the router: `emailIps = createLimiter({ max: 10, windowMs: 15 * 60_000 })`,
    `emailAccounts = createLimiter({ max: 3, windowMs: 15 * 60_000 })`. Constants for the plain messages:
    `UNVERIFIED = 'Verify your email first. Open the link we sent to your Gmail inbox, then sign in.'`,
    `VERIFY_LINK_BAD = 'This link has expired or was already used. Sign in: if your email still needs verifying, you can get a new link there.'`,
    `TOO_MANY = 'Too many requests from here. Try again in a few minutes.'` (429 `email_rate_limited`).
  - `POST /auth/signup` (:59-68): when `!mailer.configured`, unchanged (pass `verified: true`). When configured:
    `createAccount(..., verified: false)`, no `createAuthSession`, count the first email
    (`emailAccounts.limited(\`verify:${accountId}\`, now.getTime())`), `const sent = await sendVerifyEmail({ db, mailer,
    linkBase, account: { id: accountId, email: body.email }, now })`, answer `201 { verify_email: true, email_sent: sent }`.
  - `POST /auth/login`: right after `clearFailedLogins` (:89):
    `if (!account.email_verified) throw new HttpError(403, UNVERIFIED, { code: 'email_unverified' });` (before the
    one-live-login transaction; a wrong password still answers 401 `login_failed` first).
  - `POST /auth/verify` `{ token }`: `const parsed = tokenBody.safeParse(req.body ?? {})`; in one `db.transaction`:
    `findEmailToken(..., purpose 'verify', now: clock())`, `consumeEmailToken`, `markVerified`. Any failure (bad shape,
    unknown, expired, used) -> 400 `{ code: 'link_invalid' }` with `VERIFY_LINK_BAD`. Success `200 { ok: true }`; no login session.
  - `POST /auth/verify/resend` `{ email }`: 503 `email_off` "Email is not set up here. Ask your teacher to verify your
    account." when not configured; parse (400 'Enter a valid email.'); `emailIps.limited(req.ip, ...)` -> 429; look the
    account up; only when it exists, is unverified and `!emailAccounts.limited(\`verify:${id}\`)`:
    `void sendVerifyEmail(...)` (not awaited: same answer and timing either way). Always `202 { ok: true }`.
  - `server/test/lesson-access.test.js` `NOT_LESSON_ROUTES` (:41): add `'POST /auth/verify', // email link; no lesson`
    and `'POST /auth/verify/resend'`.
- Verify: `cd server && node --import ./test/setup.js --test --test-timeout=10000 test/auth-routes.test.js test/lesson-access.test.js test/auth-middleware.test.js` (existing sign-up tests run with email off, so they pass unchanged).

Do NOT touch:
- `D:/claude/pr2/Research_application_pr2` (frozen real study data) and `.env` (never read, never print).
- `auth_sessions` table/CHECK and the one-live-login logic in `POST /auth/login` (:91-103); `POST /auth/password`;
  `ChangePasswordScreen.jsx`; the admin temporary-password route; the sign-up rate limiter code (:39-57).
- `server/src/export/research.js` (must never read accounts or email_tokens); `events.type` CHECK; any study table.
- `client/src/styles/tokens.css` (no new colours or radii); `client/index.html`.
- `allowScripts`/`overrides` in the root `package.json`; no other new dependency.
