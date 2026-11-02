What: API calls that never send the login token, notices, the two link routes, password checks.
For: sonnet-high-applier
Depends on: none (server shapes from Steps 5-7)
Status: done

Repo root: D:/claude/pr2/Research_application_pr2_after_chapter_3 (branch feat/accounts). No commits, no pushes.

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

Do NOT touch:
- `D:/claude/pr2/Research_application_pr2` (frozen real study data) and `.env` (never read, never print).
- `auth_sessions` table/CHECK and the one-live-login logic in `POST /auth/login` (:91-103); `POST /auth/password`;
  `ChangePasswordScreen.jsx`; the admin temporary-password route; the sign-up rate limiter code (:39-57).
- `server/src/export/research.js` (must never read accounts or email_tokens); `events.type` CHECK; any study table.
- `client/src/styles/tokens.css` (no new colours or radii); `client/index.html`.
- `allowScripts`/`overrides` in the root `package.json`; no other new dependency.
