What: inject the mailer and link base into the app, add trust proxy, a reusable limiter, the email-sending service, and the unverified backstop.
For: sonnet-high-applier
Depends on: 2, 3
Status: done

Repo root: D:/claude/pr2/Research_application_pr2_after_chapter_3 (branch feat/accounts). No commits, no pushes.

- Then:
  - New `server/src/auth/limiter.js`: `createLimiter({ max, windowMs })` -> `{ limited(key, nowMs) }`, the same
    sliding window and pruning as `rateLimited` in `routes/auth.js:48-57` (true = over the limit, not counted). Leave
    the existing sign-up limiter code as it is.
  - New `server/src/services/account-email.js`: `sendVerifyEmail({ db, mailer, linkBase, account, now })` and
    `sendResetEmail(...)` -> `Promise<boolean>`: return `false` when `!mailer.configured`; else
    `issueEmailToken(db, { accountId: account.id, purpose, now })` then
    `mailer.send({ to: account.email, ...verifyMessage(linkTo(linkBase, 'verify', token)) })` (reset alike).
  - `server/src/app.js` `createApp(db, config, { ai, runner, clock, random, mailer } = {})`:
    `mailer ??= createMailer(config.mail)`; `const linkBase = config.publicUrl || fallbackBase(config.port ?? 3001)`;
    `app.set('linkBase', linkBase)`; `app.set('trust proxy', 'loopback')` next to `x-powered-by` with a comment (the
    Cloudflare tunnel connects from this computer; only its X-Forwarded-For is believed). Pass `{ mailer, linkBase }`
    (and `publicUrlSet: Boolean(config.publicUrl)` to admin) into `authRouter` and `adminAccountsRouter`.
  - `server/src/routes/auth.js:16-18`: update the comment (behind the tunnel, `trust proxy` gives each student their own IP).
  - `server/src/middleware/participant.js` `resolve` (:52): after the must-change check add
    `if (!session.email_verified) throw new HttpError(403, 'Verify your email first: open the link we sent to your Gmail inbox.', { code: 'email_unverified' });`
    and change `REVOKED.password_reset` (:9) to `'Your password was reset. Sign in with the new one.'` (now true for
    both the teacher's reset and the student's own). Update the expected text in `server/test/auth-middleware.test.js:46`.
  - `server/test/helpers.js`: `startStudyApp` takes `mailer` and `publicUrl` and passes them
    (`createApp(db, { maxUploadBytes, adminPin, clientDist: null, publicUrl }, { ai, runner, clock, random, mailer })`).
    Add exports:
    ```js
    // A mailer that sends nothing: every message is kept in `sent`; `fail: true` makes each send answer false.
    export function fakeMailer({ fail = false } = {}) {
      const sent = [];
      return { configured: true, sent, async send(message) { sent.push(message); return !fail; } };
    }
    // The one-time token in the newest email's link of that kind ('verify' | 'reset'), or null.
    export const linkToken = (mailer, kind) => new RegExp(`/#/${kind}/([A-Za-z0-9_-]{43})`).exec(mailer.sent.at(-1)?.text ?? '')?.[1] ?? null;
    ```
  - Add to `server/test/auth-middleware.test.js`: an account with `email_verified = 0` and a live session (insert
    directly) gets 403 `email_unverified` on `GET /api/stats`; `/api/auth/me` still answers 200.
- Verify: `cd server && npm test` passes in full (no behaviour change yet with email off).

Do NOT touch:
- `D:/claude/pr2/Research_application_pr2` (frozen real study data) and `.env` (never read, never print).
- `auth_sessions` table/CHECK and the one-live-login logic in `POST /auth/login` (:91-103); `POST /auth/password`;
  `ChangePasswordScreen.jsx`; the admin temporary-password route; the sign-up rate limiter code (:39-57).
- `server/src/export/research.js` (must never read accounts or email_tokens); `events.type` CHECK; any study table.
- `client/src/styles/tokens.css` (no new colours or radii); `client/index.html`.
- `allowScripts`/`overrides` in the root `package.json`; no other new dependency.
