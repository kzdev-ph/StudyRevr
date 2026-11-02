What: config keys for SMTP and PUBLIC_URL, and a small swappable mail sender with the two message texts.
For: sonnet-high-applier
Depends on: 1
Status: done

Repo root: D:/claude/pr2/Research_application_pr2_after_chapter_3 (branch feat/accounts). No commits, no pushes.

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

Do NOT touch:
- `D:/claude/pr2/Research_application_pr2` (frozen real study data) and `.env` (never read, never print).
- `auth_sessions` table/CHECK and the one-live-login logic in `POST /auth/login` (:91-103); `POST /auth/password`;
  `ChangePasswordScreen.jsx`; the admin temporary-password route; the sign-up rate limiter code (:39-57).
- `server/src/export/research.js` (must never read accounts or email_tokens); `events.type` CHECK; any study table.
- `client/src/styles/tokens.css` (no new colours or radii); `client/index.html`.
- `allowScripts`/`overrides` in the root `package.json`; no other new dependency.
