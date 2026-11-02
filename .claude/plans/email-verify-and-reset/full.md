# PLAN: email verification and Forgot password (feat/accounts)

Repo root for every step: `D:/claude/pr2/Research_application_pr2_after_chapter_3` (branch `feat/accounts`).
NEVER open or touch `D:/claude/pr2/Research_application_pr2` (frozen real study data). Never read `.env` or print keys.

- Goal: new sign-ups must verify their email (one-time link sent by Gmail SMTP) before they can study, and students can
  reset a forgotten password through an emailed link that opens a "Password Reset" screen.
- Approach (decisions, and why):
  1. **Data:** migration 022 adds `accounts.email_verified INTEGER NOT NULL DEFAULT 1` (DEFAULT 1 = every existing row,
     P00's test login and every test helper insert stay verified with no extra code; only sign-up writes 0, and only
     while email is set up) and table `email_tokens` (sha256 only, purpose `verify` 24 h | `reset` 30 min). A row exists
     only while its link is usable: using it deletes it; issuing a new one deletes the old one of that purpose.
     No change to `auth_sessions` (the `password_reset` revoke reason already exists), so one-live-login is untouched.
  2. **Email off = today's behaviour.** If SMTP_HOST/SMTP_USER/SMTP_PASS are not all set, sign-up creates a verified
     account and signs in exactly as now; Forgot password / resend answer 503 `email_off` with a plain line; Admin >
     Accounts shows "Email is not set up". Nobody is locked out silently during the defense.
  3. **Email on:** sign-up creates an unverified account, starts NO login session, awaits the send (capped at 15 s) and
     answers `{ verify_email: true, email_sent }`; the client shows "Check your Gmail inbox" with "Send the link again"
     (60 s client cooldown, 3 per 15 min per account on the server). Sign-in with the right password on an unverified
     account is 403 `email_unverified` (only after the password is right, so it leaks nothing new) and shows the same
     inbox panel. `requireParticipant` also refuses unverified accounts (backstop).
  4. **Links** are `${PUBLIC_URL}/#/verify/<token>` and `#/reset/<token>`. The token sits in the URL fragment, which
     browsers never send to the server, to Cloudflare logs or in a Referer. The page does a POST (verify needs a tap on
     "Verify my email"), so email scanners that prefetch or even run the page change nothing. Verify does not sign in
     (a scanner must never get a login and take the one live session). The screen keeps the token in React state and
     `history.replaceState` removes it from the address bar and history at once; it is never stored.
  5. **PUBLIC_URL** from `.env`, validated (http/https, no user/query/hash). Empty or invalid: this computer's first LAN
     IPv4 `http://<ip>:PORT` (what `npm run study` prints), logged at startup and shown in Admin. Never the Host header:
     anyone on the Wi-Fi could send `Host: their-own.trycloudflare.com` and receive a victim's reset token.
  6. **No account enumeration:** `/auth/forgot` and `/auth/verify/resend` always answer 202 `{ ok: true }`; the email is
     sent without awaiting it, so timing is the same (one indexed lookup + a tiny insert). Per-IP limit (429, 10 per
     15 min, IPs are not secret) and per-account limit (3 per 15 min, silently skipped). Bad / expired / used / malformed
     link tokens all get the same 400 `link_invalid` message.
  7. **Reset success:** set password (must_change off), clear lockout, mark verified, delete the account's reset links,
     revoke all login sessions (`password_reset`; its study sessions end as `signed_out`, since the student did it), then
     the screen sends them to sign in with a notice. Admin temporary password flow unchanged.
  8. **trust proxy = 'loopback'**: cloudflared connects from 127.0.0.1, so without this every tunnel user shares one IP
     bucket for all limits. Only a loopback peer's X-Forwarded-For is trusted; LAN phones keep their own address.
  9. Sender is a tiny module (`server/src/mail/mailer.js`, nodemailer, injectable) so another provider can be swapped in.
     SMTP errors are logged with password and sender address redacted and no recipient; students only see plain lines.

## Step 1: Add nodemailer
- What: add the nodemailer dependency to the server workspace and confirm it has no install script.
- For: haiku-xhigh-quick-fix
- Depends on: none
- Then:
  - From the repo root: `npm install nodemailer@^10.3.1 -w server` (npm 11; never `npm ci` inside a workspace).
  - nodemailer 10.3.1 has no `preinstall`/`install`/`postinstall` script and no dependencies (checked with
    `npm view nodemailer scripts dependencies`; its `prepare` only runs for git installs). Run `npm install-scripts ls`
    from the root: it must show nothing unreviewed. If it does list nodemailer, run `npm install-scripts deny nodemailer`
    and run `ls` again.
  - Only `server/package.json` (`"nodemailer": "^10.3.1"`) and `package-lock.json` change. Do not touch `overrides` or
    `allowScripts`. If the lockfile diff drops `libc` fields elsewhere, stop and report (npm version problem).
- Verify: `cd server && node -e "import('nodemailer').then(m => console.log(typeof m.default.createTransport))"` prints
  `function`; `git diff --stat` shows only the two files.

## Step 2: Migration 022 and the token store
- What: add `accounts.email_verified` and `email_tokens`, plus the plain database functions that use them.
- For: sonnet-high-applier
- Depends on: none
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

## Step 3: Mail module and config
- What: config keys for SMTP and PUBLIC_URL, and a small swappable mail sender with the two message texts.
- For: sonnet-high-applier
- Depends on: 1
- Then:
  - New `server/src/mail/links.js`:
    - `parsePublicUrl(raw, warn = console.warn)` -> `''` for empty; on a `new URL` failure, a non-http(s) protocol,
      a username/password, a `search` or a `hash`: warn `[config] PUBLIC_URL ignored: use a plain http:// or https://
      address such as https://example.trycloudflare.com` and return `''`; else `` `${url.origin}${url.pathname}` `` with
      trailing slashes removed.
    - `fallbackBase(port, interfaces = os.networkInterfaces())` -> `http://<first non-internal IPv4>:<port>`, else
      `http://localhost:<port>` (same filter as `server/src/index.js:24`). Comment: never built from the Host header.
    - `linkTo(base, kind, token)` -> `` `${base}/#/${kind}/${token}` `` (kind `verify` | `reset`).
  - New `server/src/mail/messages.js`: `verifyMessage(link)` and `resetMessage(link)` -> `{ subject, text }`, plain text
    only (no HTML), never a study ID. Subjects "Verify your email for StudyRevr" / "Reset your StudyRevr password".
    Verify text: someone made a StudyRevr account with this email; open the link and tap "Verify my email"; works for
    24 hours and once; ignore if not you. Reset text: open the link to choose a new password; works for 30 minutes and
    once; ignore if you did not ask, your password stays the same.
  - New `server/src/mail/mailer.js`: `createMailer(mail = {}, { transport, log = console.warn } = {})`:
    - `configured = Boolean(mail.host && mail.user && mail.pass)`; when false return
      `{ configured: false, async send() { return false; } }`.
    - else `transport ??= nodemailer.createTransport({ host, port, secure: port === 465, requireTLS: port !== 465,
      auth: { user, pass }, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000 })`;
      `from = mail.from || \`StudyRevr <${mail.user}>\``.
    - `send({ to, subject, text })` -> `Promise<boolean>`, never throws: `Promise.race` of `transport.sendMail(...)` and
      a 15 s timer (clear it in `finally`); on error log one line `[mail] could not send "<subject>": <err.code>
      <err.responseCode> <message cut to 200 chars>` with every occurrence of `mail.pass` and `mail.user` replaced by
      `[redacted]`; never log the recipient. Return false.
  - `server/src/config.js` `loadConfig`: add
    `mail: { host: (env.SMTP_HOST||'').trim(), port: positiveInt(env.SMTP_PORT) || 465, user: (env.SMTP_USER||'').trim(),
    pass: (env.SMTP_PASS||'').replace(/\s+/g, ''), from: (env.MAIL_FROM||'').trim() }` (comment: Gmail shows app
    passwords in groups of four) and `publicUrl: parsePublicUrl(env.PUBLIC_URL)`.
  - New `server/test/mail.test.js`: parsePublicUrl (empty, `https://x.trycloudflare.com/` -> no slash, `http://192.168.1.5:3001`,
    `javascript:x`, `https://u:p@x`, `https://x/?a=1`, `https://x/#y` -> `''` with one warning that does not echo a
    password); fallbackBase with fake interfaces (LAN found / only internal -> localhost); createMailer off when any of
    host/user/pass is missing; with a fake transport: success -> true; a rejecting transport whose message contains the
    pass and user -> false and the logged line contains neither, nor the recipient; messages contain the link, "24
    hours" / "30 minutes", and no `/\bP\d{1,3}\b/` outside the link.
- Verify: `cd server && node --import ./test/setup.js --test --test-timeout=10000 test/mail.test.js test/providers.test.js test/settings-ai.test.js`.

## Step 4: Wiring, limiter, participant gate
- What: inject the mailer and link base into the app, add trust proxy, a reusable limiter, the email-sending service, and the unverified backstop.
- For: sonnet-high-applier
- Depends on: 2, 3
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

## Step 5: Sign-up, sign-in and verification routes
- What: sign-up asks for verification when email is on; sign-in refuses unverified accounts; verify and resend routes.
- For: sonnet-high-applier
- Depends on: 4
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

## Step 6: Forgot password and reset routes
- What: request a reset link, check a link, set the new password.
- For: sonnet-high-applier
- Depends on: 5
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

## Step 7: Admin > Accounts routes
- What: show verified and email status; Mark verified; Resend verification email.
- For: sonnet-high-applier
- Depends on: 4
- Then, in `server/src/routes/admin-accounts.js` (`adminAccountsRouter({ db, clock, requireAdmin, mailer, linkBase, publicUrlSet })`):
  - `GET /accounts` answer adds `email: { configured: mailer.configured, link_base: linkBase, link_from_env: publicUrlSet }`
    (booleans and the public base only; never host, user, pass or sender).
  - `POST /accounts/:code/verify`: `accountOr404`; in a transaction `markVerified` + `logAdminEvent(db,
    'email_verified_by_admin', account.code, now)`; `200 { verified: true }` (idempotent).
  - `POST /accounts/:code/resend-verification`: `accountOr404`; 503 `email_off` "Email is not set up on this server.
    Use Mark verified instead." when not configured; 409 `already_verified` "This account is already verified."; else
    `logAdminEvent(db, 'verification_resent', account.code, now)` and `200 { sent: await sendVerifyEmail(...) }`
    (no rate limit for admin).
  - admin_events details are study IDs only, never emails.
  - `server/test/lesson-access.test.js:297`: add `'POST /api/admin/accounts/:code/verify'` and
    `'POST /api/admin/accounts/:code/resend-verification'` to the list checked for presence.
- Verify: `cd server && node --import ./test/setup.js --test --test-timeout=10000 test/admin-accounts.test.js test/lesson-access.test.js`.

## Step 8: Backup, restore, withdrawal
- What: email links never leave in a backup or survive a restore; withdrawal lists and removes them.
- For: sonnet-high-applier
- Depends on: 2
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

## Step 9: Startup log and .env.example
- What: say at startup whether email is on and where links point; document the new names.
- For: haiku-xhigh-quick-fix
- Depends on: 4
- Then:
  - `server/src/index.js` inside the `listen` callback (:21-28): `const mailOn = Boolean(config.mail.host && config.mail.user && config.mail.pass);`
    on: `[mail] email is on (<host>:<port>); links in emails open <app.get('linkBase')>`; plus, when `!config.publicUrl`:
    `[mail] PUBLIC_URL is not set: links use this computer's Wi-Fi address, so they open only on this network`.
    off: `[mail] email is off: set SMTP_HOST, SMTP_USER and SMTP_PASS in .env. New sign-ups are not asked to verify; Forgot password is off.`
    Never print user, pass or from.
  - `.env.example`: a new block after ADMIN_PIN with NAMES ONLY (empty values) `SMTP_HOST=`, `SMTP_PORT=`, `SMTP_USER=`,
    `SMTP_PASS=`, `MAIL_FROM=`, `PUBLIC_URL=`, and comments: Gmail = host smtp.gmail.com, port 465, user = the Gmail
    address, pass = an app password (Google Account > Security > 2-Step Verification > App passwords; spaces ignored);
    leaving host/user/pass empty turns email off (sign-ups not asked to verify, Forgot password off); MAIL_FROM optional
    (default "StudyRevr <SMTP_USER>"); PUBLIC_URL = the address students open (the Cloudflare tunnel URL changes on
    every start: update it and restart), empty = this computer's Wi-Fi address and PORT.
- Verify: `cd server && npm test` passes; start the server with email unset and see the "email is off" line.

## Step 10: Server tests for the email flows
- What: route tests with the fake mailer (no real email is ever sent).
- For: sonnet-high-test-writer
- Depends on: 5, 6, 7
- Then: new `server/test/auth-email.test.js` in the style of `auth-routes.test.js` (own `api()` helper with raw fetch;
  `startStudyApp({ now, mailer: fakeMailer(), publicUrl: 'https://study.example.test' })`; `linkToken(mailer, kind)`):
  - Sign-up with email on: 201 `{ verify_email: true, email_sent: true }`, no `token`, no `auth_sessions` row,
    `email_verified = 0`, one email to the address whose link starts `https://study.example.test/#/verify/`; text has
    no study ID outside the link. With `fakeMailer({ fail: true })`: 201 `email_sent: false`, account exists.
  - Sign-in before verifying: right password 403 `email_unverified`, no session; wrong password 401 `login_failed`.
  - Verify: 200, then sign-in works; same token again, an unknown token, a malformed one, and one 24 h + 1 s later all
    give the identical 400 body `link_invalid`.
  - Resend: identical 202 body for an unknown, a verified and an unverified email; only the unverified one gets mail;
    a newer link makes the older one 400; the 4th resend in 15 min sends nothing but still answers 202; the 11th
    request from one IP is 429; requests with `X-Forwarded-For: 203.0.113.9` (from 127.0.0.1) use their own bucket.
  - Email off (no mailer): sign-up answers `{ token, account }` and the account is verified; forgot and resend are 503 `email_off`.
  - Forgot: identical status and body for known and unknown emails; only the known gets a `/#/reset/` link.
  - Reset check: `{ email }` for a live link; 400 `link_invalid` after 30 min + 1 s, after use, and for junk.
  - Reset: short password 400 and common password 400 `password_too_common` leave the link usable; then 200; old
    password 401, new one signs in; a locked account (5 wrong) is unlocked; `must_change_password` is cleared; the
    previous login token now gets 401 `password_reset`; its open study session ended `signed_out`; an unverified
    account becomes verified; a second use is 400; a newer reset link makes the older one 400.
  - Admin (extend `server/test/admin-accounts.test.js`): list carries `verified` and `email.configured`, and its JSON
    has no SMTP pass (pass `mail: { pass: 'smtp-secret-pass' }` in config via a custom createApp, or assert on the
    fields); Mark verified -> verified + `admin_events` `email_verified_by_admin` / `P01`; resend -> `{ sent: true }`
    and one email; 409 when verified; 503 without a mailer; 401 without the PIN; 404 for an unknown code.
- Verify: `cd server && npm test` all green.

## Step 11: Client libraries
- What: API calls that never send the login token, notices, the two link routes, password checks.
- For: sonnet-high-applier
- Depends on: none (server shapes from Steps 5-7)
- Then:
  - `client/src/lib/api.js` `request()` (:37-61): new option `anon = false`: `const token = admin || anon ? null : as ?? getToken();`
    and only call `onRefused` when `!as && !anon`. Add `'email_unverified'` to `SIGNED_OUT` (:30). New functions:
    ```js
    // public, for signed-out screens and email links: no token and no PIN, and a refusal never signs this device out
    resendVerification: (email) => request('/auth/verify/resend', { method: 'POST', body: { email }, anon: true }),
    verifyEmail: (token) => request('/auth/verify', { method: 'POST', body: { token }, anon: true }),
    forgotPassword: (email) => request('/auth/forgot', { method: 'POST', body: { email }, anon: true }),
    checkResetLink: (token, signal) => request('/auth/reset/check', { method: 'POST', body: { token }, signal, anon: true }),
    resetWithLink: ({ token, password }) => request('/auth/reset', { method: 'POST', body: { token, password }, anon: true }),
    // admin
    markVerified: (code) => request(`/admin/accounts/${encodeURIComponent(code)}/verify`, { method: 'POST', body: {}, admin: true }),
    resendVerificationFor: (code) => request(`/admin/accounts/${encodeURIComponent(code)}/resend-verification`, { method: 'POST', body: {}, admin: true }),
    ```
    Update the signup comment: answers `{ token, account }`, or `{ verify_email: true, email_sent }` when email is on.
  - `client/src/lib/auth.js`: `NOTICES.password_reset` -> `'Your password was reset. Sign in with the new one.'`; add
    `email_unverified: 'Verify your email first: open the link we sent to your Gmail inbox.'`; export
    `setSignInNotice = (message) => notice.set(message)`.
  - `client/src/lib/router.js`: header comment lists `#/verify/<token>` and `#/reset/<token>`; in `parseRoute` before
    the tabs: `if (first === 'verify' || first === 'reset') return { name: first, token: LINK_TOKEN.test(second ?? '') ? second : null };`
    (`LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/`); export `isPublicRoute = (r) => r.name === 'verify' || r.name === 'reset'` and
    ```js
    // Takes the one-time token out of the address bar and this history entry (no hashchange; the screen keeps it in memory).
    export const forgetLinkToken = (name) => {
      if (window.location.hash !== `#/${name}`) window.history.replaceState(null, '', `#/${name}`);
    };
    ```
  - New `client/src/lib/authForms.js`: `EMAIL_SHAPE`, `PASSWORD_MIN = 8`, `PASSWORD_MAX = 200`,
    `newPasswordProblem(password, again)` -> message or null ('Enter the new password twice.' / at least 8 / at most
    200 / 'The two passwords are not the same. Type them again.').
  - Tests: `client/test/api.test.js` add `markVerified`, `resendVerificationFor` to ADMIN and a `PUBLIC` list of the five
    public functions (include it in the classify test); new test: public calls send neither `authorization` nor
    `x-admin-pin` while a token and PIN are set; a 403 `email_unverified` on `verifyEmail` leaves `getToken() === 't1'`.
    `client/test/auth.test.js:105` regex -> `/password was reset/`; add `email_unverified` notice and `setSignInNotice`.
    `client/test/router.test.js`: verify/reset parse with a 43-char token, a bad token gives `token: null`,
    `isPublicRoute`, and `#/verify` is not an admin route. New `client/test/authForms.test.js` for `newPasswordProblem`.
- Verify: `cd client && npm test`.

## Step 12: Sign-in screen: Forgot password and Check your inbox
- What: replace the "Ask your teacher" line with "Forgot password?", and show the inbox panel after sign-up / unverified sign-in.
- For: sonnet-high-applier
- Depends on: 11
- Then:
  - New `client/src/components/CheckInbox.jsx` `({ email, sent, lead, onBack })`: optional `lead` as
    `<Notice tone="warn">`; "We sent a link to **{email}**. Open it on any device to verify your email, then sign in
    here."; muted "Can't find it? Look in Spam or Promotions. The link works for 24 hours."; when `!sent` a `<Notice>`
    "We couldn't send the email just now. Tap Send the link again, or ask your teacher."; `<p role="status"
    className="status-ok">` for "If this email still needs verifying, a new link is on its way. Only the newest link
    works."; quiet button "Send the link again" (calls `api.resendVerification(email)`, then disabled 60 s showing "Send
    again in N s"; errors shown with `<Notice>{err.message}</Notice>`); primary "Back to sign in" -> `onBack`.
  - New `client/src/components/ForgotPassword.jsx` `({ initialEmail, onBack })`: email field (same props as AuthScreen's,
    `EMAIL_SHAPE` from `lib/authForms.js`), muted hint "We'll email you a link to choose a new password.", primary
    "Send reset link" (busy "Sending…"), quiet "Back to sign in". After 202: "If an account uses **{email}**, we sent
    it a link to reset the password. Check your Gmail inbox (and Spam). The link works for 30 minutes." + primary
    "Back to sign in". Server errors (503 `email_off`, 429) shown as `<Notice>{err.message}</Notice>`.
  - `client/src/screens/AuthScreen.jsx`: mode `'in' | 'up' | 'forgot' | 'inbox'`; title map `{ in: 'Sign in', up: 'Create
    your account', forgot: 'Forgot password', inbox: 'Check your Gmail inbox' }`; state `inbox` `{ email, sent, lead }`.
    `finish(call, typed)`: `const result = await call(); if (result?.token) acceptLogin(result); else { setInbox({
    email: typed, sent: Boolean(result?.email_sent), lead: null }); setMode('inbox'); }`; in `catch`,
    `err.code === 'email_unverified'` -> `setInbox({ email: typed, sent: true, lead: err.message }); setMode('inbox')`.
    In `inbox`/`forgot` modes render the component instead of the form and links (keep the wordmark, title and the
    Researcher admin link); `onBack={() => switchTo('in')}`. Replace line 181 with
    `<button type="button" className="link-btn" onClick={() => switchTo('forgot')}>Forgot password?</button>`.
    Give the h1 `tabIndex={-1}` and a ref, focused when the mode becomes `inbox` (the email input no longer exists).
  - Do not change the takeover flow or `ChangePasswordScreen.jsx`.
- Verify: `cd client && npm test && npm run build`; manual check in Step 16's script items 2-4 and 8.

## Step 13: Public screens: Verify email and Password Reset
- What: the two screens email links open, shown before the sign-in gate.
- For: sonnet-high-applier
- Depends on: 11
- Then:
  - New `client/src/components/GateCard.jsx` `({ title, children })`: the `main.gate > .gate__inner > .gate__card.stack`
    frame with the wordmark and `<h1 className="screen-title">` copied from `AuthScreen.jsx:96-103` (AuthScreen itself unchanged).
  - New `client/src/screens/VerifyEmailScreen.jsx` `({ token: fromLink })`: `const [token] = useState(fromLink)`;
    `useEffect(() => forgetLinkToken('verify'), [])`; states `ready | busy | done | failed | missing` (missing when no
    token). Title "Verify your email". ready: "Tap the button to finish verifying your StudyRevr email." + primary
    "Verify my email" (busy "Verifying…") -> `api.verifyEmail(token)`. done: `<Notice tone="info">Your email is verified.
    You can sign in now.</Notice>` + primary "Go to sign in". failed: `<Notice>{err.message}</Notice>` + "Go to sign
    in". missing: `<Notice>This link can't be used again here. Open the newest link in your email, or sign in to get a
    new one.</Notice>`. "Go to sign in" = `navigate(paths.library())`.
  - New `client/src/screens/ResetPasswordScreen.jsx` `({ token: fromLink })` (the user's sketch): title "Password
    Reset"; same token capture and `forgetLinkToken('reset')`; on mount (AbortController) `api.checkResetLink` ->
    form, or the server's message + "Go to sign in". Form (`noValidate`): Email `<input className="field__input"
    type="email" value={email} readOnly autoComplete="username" aria-describedby="reset-email-note">` with muted
    `#reset-email-note` "The account this link is for."; `PasswordField` "Password" (Show/Hide) and "Confirm password"
    (`autoComplete="new-password"`); muted hint "At least 8 characters. Use a new password just for StudyRevr.";
    `newPasswordProblem` before calling; primary "Reset" (busy "Resetting…"). Success:
    `setSignInNotice('Your password is reset. Sign in with your new password.')`, show that as `<Notice tone="info">` +
    primary "Go to sign in". An error with `code === 'link_invalid'` switches to the bad-link state.
  - `client/src/App.jsx`: import both screens and `isPublicRoute`; right before the gate (:114), after all hooks:
    ```jsx
    // Email links open here whether or not this device is signed in (often a fresh browser on another device).
    if (isPublicRoute(route)) {
      return (
        <MotionConfig reducedMotion={reduced ? 'always' : 'never'}>
          {route.name === 'verify' ? <VerifyEmailScreen token={route.token} /> : <ResetPasswordScreen token={route.token} />}
        </MotionConfig>
      );
    }
    ```
  - `client/src/styles/participants.css` (after `.field__input`): greyed read-only field, tokens only:
    `.field__input[readonly] { background: var(--paper); color: var(--ink-2); border-style: dashed; cursor: default; }`
    (`--ink-2` text is >= 4.5:1 on `--paper` in every theme; the dashed `--ink-2` edge stays >= 3:1).
- Verify: `cd client && npm test && npm run build`; open `http://localhost:5173/#/reset/` + 43 x `a` -> bad-link message, address bar shows `#/reset`.

## Step 14: Admin > Accounts screen
- What: verified status, email setup line, Mark verified and Resend email buttons.
- For: sonnet-high-applier
- Depends on: 11
- Then:
  - `client/src/lib/accounts.js` `accountStatus`: after the lock line,
    `if (account.verified === false) return 'Email not verified';` (`=== false` keeps old rows as they were). Add a case
    to `client/test/accounts.test.js` (and that a lock still wins).
  - `client/src/components/AdminAccounts.jsx`: under the intro paragraph, when `data?.email`: configured ->
    `<p className="muted">Email is set up. Links in emails open {link_base}{link_from_env ? '' : " (PUBLIC_URL is not set: this computer's Wi-Fi address)"}.</p>`;
    not configured -> `<Notice tone="warn">Email is not set up, so new sign-ups are not asked to verify and Forgot
    password is off. Set SMTP_HOST, SMTP_USER and SMTP_PASS in .env, then restart the server.</Notice>`.
    In each row's `.accounts-actions`, when `a.verified === false && !a.test`: quiet small "Mark verified"
    (`run(() => api.markVerified(a.code).then(() => setMessage(\`${a.email} is verified.\`)))`) and, only when
    `data.email.configured`, quiet small "Resend email" (`{ sent }` -> message "Sent a new verification link to X." or
    `setProblem('The email could not be sent. The server log says why. You can use Mark verified instead.')`).
    No confirm step (nothing is destroyed). Existing Reset password / Sign out stay.
- Verify: `cd client && npm test && npm run build`; Admin > Accounts at 360 px wide: the buttons wrap, each >= 44 px.

## Step 15: Docs, CLAUDE.md, codebook
- What: document the feature where each area is documented.
- For: haiku-xhigh-quick-fix
- Depends on: 1-14
- Then:
  - `docs/api.md:15` (Accounts line): signup answer with email on; login 403 `email_unverified`; `POST /api/auth/verify`,
    `/auth/verify/resend` (202, 429 `email_rate_limited`, 503 `email_off`), `/auth/forgot`, `/auth/reset/check`,
    `/auth/reset` (400 `link_invalid`); admin `POST /api/admin/accounts/:code/verify`, `/resend-verification`; list `email`.
  - `docs/data-model.md:18-19`: `accounts.email_verified` (022, DEFAULT 1) and the `email_tokens` table (emptied in backups and on restore).
  - `docs/participants-sessions.md:10-14`: an "Email verification and Forgot password" bullet (email on/off rule,
    PUBLIC_URL, links in the fragment, limits, reset revokes logins); line 23: `signed_out` also covers a student's own reset by email.
  - `docs/admin.md:6-7`: Accounts shows Email not verified, Mark verified, Resend email, the email setup line; backup
    also strips `email_tokens`; `admin_events` types `email_verified_by_admin`, `verification_resent`.
  - `docs/stats-export-settings.md:18`: `email_tokens` is never read by the export.
  - `docs/parsing-and-install.md`: nodemailer in the dependency list (no install script; checked with `npm install-scripts ls`).
  - `docs/history.md`: short entry for this change and the audit note below.
  - `server/src/export/codebook.js:114`: `signed_out (signed out on this device, or the student reset their own
    password by email)`; keep the text `signed_out (` (export.test.js checks it).
  - `CLAUDE.md`: line 10 add "nodemailer for email links (`server/src/mail/`)"; line 48 add one sentence: "New sign-ups
    verify their email by link before studying, and Forgot password emails a 30-min reset link (only while SMTP_* is
    set in `.env`; links built from `PUBLIC_URL`, never the Host header); Admin > Accounts can Mark verified."; line 55
    add "and email links (`email_tokens`)" to what backup strips.
- Verify: `cd server && npm test` (codebook test); `git diff --stat` shows docs only for this step.

## Do NOT touch
- `D:/claude/pr2/Research_application_pr2` (frozen real study data) and `.env` (never read, never print).
- `auth_sessions` table/CHECK and the one-live-login logic in `POST /auth/login` (:91-103); `POST /auth/password`;
  `ChangePasswordScreen.jsx`; the admin temporary-password route; the sign-up rate limiter code (:39-57).
- `server/src/export/research.js` (must never read accounts or email_tokens); `events.type` CHECK; any study table.
- `client/src/styles/tokens.css` (no new colours or radii); `client/index.html`.
- `allowScripts`/`overrides` in the root `package.json`; no other new dependency.

## How to verify
- `cd server && npm test` and `cd client && npm test`: all green. `npm run build` (root) succeeds.
- `npm install-scripts ls` (root): nothing unreviewed.
- `git grep -n "SMTP_PASS\|mail.pass" server/src` shows only config.js and mailer.js.
- Manual script below, once with email off and once with a Gmail app password.

## Risks
- Gmail: needs 2-Step Verification + app password; 465/TLS; the free account sends ~500 emails a day; mails may land in
  Spam/Promotions (the screens say so). A wrong app password shows only as "could not send" + a server log line.
- The tunnel URL changes on every start: a stale PUBLIC_URL makes every emailed link dead. Admin shows the base in use.
- Links built from the LAN fallback open only on the same Wi-Fi.
- Rate limits are in memory (a restart clears them), like the existing sign-up limit.
- `trust proxy 'loopback'` also changes the admin PIN lockout key for tunnel users (now per real IP, which is better);
  a process on the host itself could spoof X-Forwarded-For (only the researcher's machine).
- An unverified sign-up still takes a study ID (never reused) and shows in Admin as "Email not verified"; withdraw it
  with `npm run participant:delete -- <email>` if it never verifies.
- Someone who signs up with another person's Gmail blocks that address (409, as today); the real owner gets the
  account back with Forgot password (which also verifies it).
- StrictMode runs the reset-check effect twice in dev: harmless (read-only, aborted).

## Audit note (auth and user data)
- Tokens: 32 random bytes, only sha256 stored, 24 h / 30 min, single use (atomic DELETE), older link replaced on issue,
  rechecked inside the write transaction after scrypt. No token is logged, stored in the browser, or put in a query string.
- No enumeration: forgot/resend always 202 with mail sent asynchronously; link failures share one message; sign-in tells
  "unverified" only after the right password. (Pre-existing and unchanged: sign-up 409 `email_taken`.)
- Links never use the Host header (host-header injection); PUBLIC_URL is validated at startup.
- Reset revokes every login session, clears lockouts and must-change, and verifies the email.
- SMTP password: only in `.env`, never returned (admin sees booleans + the public link base), never logged (redacted),
  never in backups. Logs carry no recipient email.
- Research export untouched (`email_tokens` never read; export.test scans for "@" and the token hash). Backups and
  restores drop `email_tokens`; withdrawal cascades and lists them. admin_events hold study IDs only.
- Dependency: nodemailer (zero dependencies, no install scripts).

## Manual test script (for the user)
1. Email OFF (no SMTP_* in .env): `npm run study`. Log says "email is off". Sign up a new account: you go straight in
   (as before). Admin > Accounts shows "Email is not set up". Sign out; "Forgot password?" -> enter email -> plain
   message to ask the teacher.
2. Email ON: put SMTP_HOST=smtp.gmail.com, SMTP_PORT=465, SMTP_USER, SMTP_PASS (app password) and PUBLIC_URL (the current
   tunnel URL) in .env; restart. Log says "email is on" and the link base.
3. Sign up with a Gmail you can open: you see "Check your Gmail inbox" (no app). Try Sign in with that account: refused
   with "Verify your email first…" and the inbox panel. Tap "Send the link again": button waits 60 s.
4. Open the newest email on a phone (fresh browser): the Verify page; the address bar shows `#/verify` without the
   token. Tap "Verify my email" -> verified -> Go to sign in -> sign in works. Open the same link again -> "expired or
   already used". An older link (before Send again) also fails.
5. Admin > Accounts: the account shows Signed in/out (not "Email not verified"). Make another sign-up, do not verify:
   it shows "Email not verified" with Mark verified and Resend email; Mark verified -> it can sign in.
6. Forgot password: sign-in screen -> "Forgot password?" -> your email -> the neutral message. Also try a made-up email:
   the same message, no email arrives.
7. Open the reset email: "Password Reset" with your email greyed out; type two different passwords -> message; type
   `password123` -> "too common"; a good one -> "Your password is reset" -> Go to sign in (notice shown). The old
   password fails; the new one works. A device that was signed in on that account is sent to sign-in.
8. Reuse the reset link -> "expired or already used". Wait 31 min on a new link -> the same message.
9. Check Light, Dark, AMA, AMA Dark on the four new views: no red for errors in Light/Dark, every error has an icon and
   words, buttons are at least 44 px, the greyed email is readable.
10. Download backup and open it with any SQLite viewer: `email_tokens` is empty. Research export has no "@".
