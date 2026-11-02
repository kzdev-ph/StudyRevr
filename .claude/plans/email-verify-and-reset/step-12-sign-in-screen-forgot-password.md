What: replace the "Ask your teacher" line with "Forgot password?", and show the inbox panel after sign-up / unverified sign-in.
For: sonnet-high-applier
Depends on: 11
Status: done

Repo root: D:/claude/pr2/Research_application_pr2_after_chapter_3 (branch feat/accounts). No commits, no pushes.

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

Do NOT touch:
- `D:/claude/pr2/Research_application_pr2` (frozen real study data) and `.env` (never read, never print).
- `auth_sessions` table/CHECK and the one-live-login logic in `POST /auth/login` (:91-103); `POST /auth/password`;
  `ChangePasswordScreen.jsx`; the admin temporary-password route; the sign-up rate limiter code (:39-57).
- `server/src/export/research.js` (must never read accounts or email_tokens); `events.type` CHECK; any study table.
- `client/src/styles/tokens.css` (no new colours or radii); `client/index.html`.
- `allowScripts`/`overrides` in the root `package.json`; no other new dependency.
