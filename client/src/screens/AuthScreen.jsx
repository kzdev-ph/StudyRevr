import { useEffect, useRef, useState } from 'react';
import { LogoMark } from '../components/Icons.jsx';
import Notice from '../components/Notice.jsx';
import PasswordField from '../components/PasswordField.jsx';
import { api } from '../lib/api.js';
import { acceptLogin, clearForgotRequest, peekForgotRequest, takeSignedOutNotice } from '../lib/auth.js';
import { EMAIL_SHAPE, forgotFooter, inboxName, PASSWORD_MIN } from '../lib/authForms.js';
import { paths } from '../lib/router.js';
import CheckInbox from '../components/CheckInbox.jsx';
import ForgotPassword from '../components/ForgotPassword.jsx';

const TITLES = { in: 'Sign in', up: 'Create your account', forgot: 'Forgot password' };
// On a phone, focusing the field at once opens the keyboard over the card and its button; there, the student taps it.
const TOUCH = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

// Shown until this device is signed in: sign in with an email and password, or create an account.
export default function AuthScreen() {
  const [mode, setMode] = useState(() => (peekForgotRequest() ? 'forgot' : 'in')); // 'in' | 'up' | 'forgot' | 'inbox'
  const [inbox, setInbox] = useState({ email: '', sent: true, lead: null });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [shown, setShown] = useState(false);
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);
  const [takeover, setTakeover] = useState(false); // the account is active on another device: ask before replacing it
  const [notice, setNotice] = useState(null);
  const [health, setHealth] = useState(undefined); // the server's health answer: undefined until it comes, null if the call failed
  const footer = forgotFooter(health);
  const emailInput = useRef(null);
  const title = useRef(null);
  const signingUp = mode === 'up';

  useEffect(() => {
    const controller = new AbortController();
    api.health(controller.signal).then(
      (res) => setHealth(res ?? null),
      () => {
        if (!controller.signal.aborted) setHealth(null);
      },
    );
    return () => controller.abort();
  }, []);

  // The email field is gone in the inbox panel: put focus on the title so a screen reader announces it.
  useEffect(() => {
    if (mode === 'inbox') title.current?.focus();
  }, [mode]);

  // The request to open on the Forgot password form is used up once the screen has shown it.
  useEffect(() => {
    clearForgotRequest();
  }, []);

  // Why this device is back here (signed out by another device or by the teacher). Taken once; a second run of the
  // effect (Strict Mode) finds nothing and keeps what the first one found.
  useEffect(() => {
    const message = takeSignedOutNotice();
    if (message) setNotice(message);
  }, []);

  const switchTo = (next) => {
    setMode(next);
    setProblem(null);
    setTakeover(false);
    setPassword('');
    setAgain('');
    setShown(false);
    emailInput.current?.focus();
  };

  const finish = async (call, typed) => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await call();
      if (result?.token) acceptLogin(result);
      else {
        // Signed up: the account waits for its email to be verified.
        setInbox({ email: typed, sent: Boolean(result?.email_sent), lead: null });
        setMode('inbox');
      }
    } catch (err) {
      if (err.code === 'active_elsewhere') setTakeover(true);
      else if (err.code === 'email_unverified') {
        // The panel's body already says where the link went; the amber lead only needs to say why we are here.
        setInbox({ email: typed, sent: true, lead: 'Verify your email first, then sign in.' });
        setMode('inbox');
      } else setProblem(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (event) => {
    event.preventDefault();
    const typed = email.trim();
    if (!typed || !password) {
      setProblem('Enter your email and password.');
      emailInput.current?.focus();
      return;
    }
    if (!EMAIL_SHAPE.test(typed)) {
      setProblem("That email doesn't look right. Check it and try again.");
      emailInput.current?.focus();
      return;
    }
    if (signingUp) {
      if (password.length < PASSWORD_MIN) return setProblem(`Use at least ${PASSWORD_MIN} characters for your password.`);
      if (password !== again) return setProblem('The two passwords are not the same. Type them again.');
      return finish(() => api.signup({ email: typed, password }), typed);
    }
    return finish(() => api.login({ email: typed, password }), typed);
  };

  const continueHere = () => finish(() => api.login({ email: email.trim(), password, takeover: true }), email.trim());
  const cancelTakeover = () => {
    setTakeover(false);
    setPassword('');
  };

  // Typing in either field clears what was shown about the last try.
  const edited = () => {
    setProblem(null);
    setNotice(null);
  };

  const toggle = () => setShown((value) => !value);

  return (
    <main className="gate" id="main">
      <div className="gate__inner">
        <div className="gate__card stack">
          <span className="wordmark">
            <LogoMark />
            <span>StudyRevr</span>
          </span>
          <h1 className="screen-title" tabIndex={-1} ref={title}>
            {mode === 'inbox' ? `Check ${inboxName(inbox.email)}` : TITLES[mode]}
          </h1>
          {mode === 'inbox' && <CheckInbox email={inbox.email} sent={inbox.sent} lead={inbox.lead} onBack={() => switchTo('in')} />}
          {mode === 'forgot' && <ForgotPassword initialEmail={email.trim()} onBack={() => switchTo('in')} />}
          {(mode === 'in' || mode === 'up') && notice && <Notice tone="info" onDismiss={() => setNotice(null)}>{notice}</Notice>}
          {(mode === 'in' || mode === 'up') && (
          <form className="stack stack--tight" onSubmit={submit} noValidate>
            <label className="field">
              <span className="field__label">Email</span>
              <input
                className="field__input"
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  edited();
                }}
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                inputMode="email"
                aria-describedby={problem ? 'gate-problem' : undefined}
                aria-invalid={problem ? true : undefined}
                ref={emailInput}
                autoFocus={!TOUCH}
                disabled={takeover}
              />
            </label>
            <PasswordField
              id="gate-password"
              label="Password"
              value={password}
              onChange={(value) => {
                setPassword(value);
                edited();
              }}
              shown={shown}
              onToggle={toggle}
              autoComplete={signingUp ? 'new-password' : 'current-password'}
              describedBy={signingUp ? 'gate-hint' : problem ? 'gate-problem' : undefined}
              invalid={Boolean(problem)}
            />
            {signingUp && (
              <PasswordField id="gate-again" label="Type it again" value={again} onChange={(value) => { setAgain(value); edited(); }} shown={shown} autoComplete="new-password" invalid={Boolean(problem)} />
            )}
            {signingUp && (
              <p id="gate-hint" className="muted">
                At least {PASSWORD_MIN} characters. Use a new password just for StudyRevr.
              </p>
            )}
            {problem && (
              <div id="gate-problem">
                <Notice>{problem}</Notice>
              </div>
            )}
            {takeover ? (
              <div className="stack stack--tight">
                <Notice tone="warn">This account is active on another device. Continue here? The other device will be signed out.</Notice>
                <button type="button" className="btn btn--primary" onClick={continueHere} disabled={busy}>
                  {busy ? 'Signing in…' : 'Continue here'}
                </button>
                <button type="button" className="btn btn--quiet" onClick={cancelTakeover} disabled={busy}>
                  Cancel
                </button>
              </div>
            ) : (
              <button type="submit" className="btn btn--primary" disabled={busy}>
                {signingUp ? (busy ? 'Creating…' : 'Create account') : busy ? 'Signing in…' : 'Sign in'}
              </button>
            )}
          </form>
          )}
          {(mode === 'in' || mode === 'up') && !takeover && (
            <div className="gate__links">
              {signingUp ? (
                <button type="button" className="link-btn" onClick={() => switchTo('in')}>
                  I already have an account
                </button>
              ) : (
                <>
                  <button type="button" className="link-btn" onClick={() => switchTo('up')}>
                    Create an account
                  </button>
                  {/* one slot, so nothing jumps while the server has not answered: empty, then the link or the teacher line */}
                  <div className="gate__forgot">
                    {footer === 'link' && (
                      <button type="button" className="link-btn" onClick={() => switchTo('forgot')}>
                        Forgot password?
                      </button>
                    )}
                    {footer === 'teacher' && <p className="muted">Forgot your password? Ask your teacher to reset it.</p>}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        {/* the researcher's way in: below the page, quiet (students don't need it) */}
        <a className="link-btn gate__admin" href={paths.admin()}>
          Researcher admin
        </a>
      </div>
    </main>
  );
}
