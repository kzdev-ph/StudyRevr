import { useEffect, useRef, useState } from 'react';
import GateCard from '../components/GateCard.jsx';
import Notice from '../components/Notice.jsx';
import PasswordField from '../components/PasswordField.jsx';
import { api } from '../lib/api.js';
import { requestForgotForm, setSignInNotice } from '../lib/auth.js';
import { newPasswordProblem, PASSWORD_MIN } from '../lib/authForms.js';
import { forgetLinkToken, navigate, paths } from '../lib/router.js';

const MISSING = "This link can't be used again here. Open the newest link in your email, or sign in to get a new one.";
const DONE = 'Your password is reset. Sign in with your new password.';

// Opened from the link in the reset email, signed in or not. The token stays in memory (taken out of the address bar);
// the link is checked on arrival so a dead one never shows the form.
export default function ResetPasswordScreen({ token: fromLink }) {
  const [token, setToken] = useState(fromLink);
  const [state, setState] = useState(token ? 'checking' : 'bad'); // checking | form | bad | done
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [shown, setShown] = useState(false);
  const [problem, setProblem] = useState(null);
  const [badMessage, setBadMessage] = useState(MISSING);
  const [busy, setBusy] = useState(false);

  const checking = useRef(null); // the running check of the link, so a newer link can cancel it
  const latest = useRef(token); // the token the screen is for now, to drop a late answer about an older link

  useEffect(() => () => checking.current?.abort(), []);

  // A link arrives (on mount, or another one opened in this same tab, which does not remount the screen): keep its token,
  // start over, take it out of the address bar and check it. The route drops the token after that, so null is ignored.
  useEffect(() => {
    if (!fromLink) return;
    checking.current?.abort();
    const controller = new AbortController();
    checking.current = controller;
    latest.current = fromLink;
    setToken(fromLink);
    setState('checking');
    setEmail('');
    setPassword('');
    setAgain('');
    setShown(false);
    setProblem(null);
    setBadMessage(MISSING);
    setBusy(false);
    forgetLinkToken('reset');
    api.checkResetLink(fromLink, controller.signal).then(
      (res) => {
        if (controller.signal.aborted) return;
        setEmail(res?.email || '');
        setState('form');
      },
      (err) => {
        if (err.name === 'AbortError' || controller.signal.aborted) return;
        setBadMessage(err.message);
        setState('bad');
      },
    );
  }, [fromLink]);

  const submit = async (event) => {
    event.preventDefault();
    const found = newPasswordProblem(password, again);
    if (found) {
      setProblem(found);
      document.getElementById('reset-password')?.focus();
      return;
    }
    const used = token;
    setBusy(true);
    setProblem(null);
    try {
      await api.resetWithLink({ token: used, password });
      setSignInNotice(DONE);
      if (latest.current !== used) return; // a newer link replaced this one meanwhile
      setPassword('');
      setAgain('');
      setState('done');
    } catch (err) {
      if (latest.current !== used) return;
      if (err.code === 'link_invalid') {
        setBadMessage(err.message);
        setState('bad');
      } else {
        setProblem(err.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const toSignIn = () => navigate(paths.library());
  const signInButton = (
    <button type="button" className="btn btn--primary" onClick={toSignIn}>
      Go to sign in
    </button>
  );
  const edited = () => setProblem(null);

  return (
    <GateCard title="Password Reset">
      {state === 'checking' && (
        <p className="muted" aria-live="polite">
          Checking your link…
        </p>
      )}
      {state === 'bad' && (
        <>
          <Notice>{badMessage}</Notice>
          {signInButton}
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => {
              requestForgotForm();
              toSignIn();
            }}
          >
            Send a new link
          </button>
        </>
      )}
      {state === 'done' && (
        <>
          <Notice tone="info">{DONE}</Notice>
          {signInButton}
        </>
      )}
      {state === 'form' && (
        <form className="stack stack--tight" onSubmit={submit} noValidate>
          <label className="field">
            <span className="field__label">Email</span>
            <input
              className="field__input"
              type="email"
              value={email}
              readOnly
              autoComplete="username"
              aria-describedby="reset-email-note"
            />
          </label>
          <p id="reset-email-note" className="muted">
            The account this link is for.
          </p>
          <PasswordField
            id="reset-password"
            label="Password"
            value={password}
            onChange={(value) => {
              setPassword(value);
              edited();
            }}
            shown={shown}
            onToggle={() => setShown((value) => !value)}
            autoComplete="new-password"
            describedBy={problem ? 'reset-problem' : 'reset-hint'}
            invalid={Boolean(problem)}
          />
          <PasswordField
            id="reset-again"
            label="Confirm password"
            value={again}
            onChange={(value) => {
              setAgain(value);
              edited();
            }}
            shown={shown}
            autoComplete="new-password"
            invalid={Boolean(problem)}
          />
          <p id="reset-hint" className="muted">
            At least {PASSWORD_MIN} characters. Use a new password just for StudyRevr.
          </p>
          {problem && (
            <div id="reset-problem">
              <Notice>{problem}</Notice>
            </div>
          )}
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? 'Resetting…' : 'Reset'}
          </button>
        </form>
      )}
    </GateCard>
  );
}
