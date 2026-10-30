import { useEffect, useRef, useState } from 'react';
import { LogoMark } from '../components/Icons.jsx';
import Notice from '../components/Notice.jsx';
import PasswordField from '../components/PasswordField.jsx';
import { api } from '../lib/api.js';
import { acceptLogin, takeSignedOutNotice } from '../lib/auth.js';
import { paths } from '../lib/router.js';

// The same minimum as the server's.
const PASSWORD_MIN = 8;
// A simple shape check before calling the server (which has the final say): something@something.something, no spaces.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// On a phone, focusing the field at once opens the keyboard over the card and its button; there, the student taps it.
const TOUCH = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

// Shown until this device is signed in: sign in with an email and password, or create an account.
export default function AuthScreen() {
  const [mode, setMode] = useState('in'); // 'in' | 'up'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [shown, setShown] = useState(false);
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);
  const [takeover, setTakeover] = useState(false); // the account is active on another device: ask before replacing it
  const [notice, setNotice] = useState(null);
  const emailInput = useRef(null);
  const signingUp = mode === 'up';

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

  const finish = async (call) => {
    setBusy(true);
    setProblem(null);
    try {
      acceptLogin(await call());
    } catch (err) {
      if (err.code === 'active_elsewhere') setTakeover(true);
      else setProblem(err.message);
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
      return finish(() => api.signup({ email: typed, password }));
    }
    return finish(() => api.login({ email: typed, password }));
  };

  const continueHere = () => finish(() => api.login({ email: email.trim(), password, takeover: true }));
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
          <h1 className="screen-title">{signingUp ? 'Create your account' : 'Sign in'}</h1>
          {notice && <Notice tone="info" onDismiss={() => setNotice(null)}>{notice}</Notice>}
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
          {!takeover && (
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
                  <p className="muted">Forgot your password? Ask your teacher to reset it.</p>
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
