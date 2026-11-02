What: the two screens email links open, shown before the sign-in gate.
For: sonnet-high-applier
Depends on: 11
Status: done

Repo root: D:/claude/pr2/Research_application_pr2_after_chapter_3 (branch feat/accounts). No commits, no pushes.

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

Do NOT touch:
- `D:/claude/pr2/Research_application_pr2` (frozen real study data) and `.env` (never read, never print).
- `auth_sessions` table/CHECK and the one-live-login logic in `POST /auth/login` (:91-103); `POST /auth/password`;
  `ChangePasswordScreen.jsx`; the admin temporary-password route; the sign-up rate limiter code (:39-57).
- `server/src/export/research.js` (must never read accounts or email_tokens); `events.type` CHECK; any study table.
- `client/src/styles/tokens.css` (no new colours or radii); `client/index.html`.
- `allowScripts`/`overrides` in the root `package.json`; no other new dependency.
