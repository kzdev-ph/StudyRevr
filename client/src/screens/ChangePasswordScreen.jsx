import { useState } from 'react';
import { LogoMark } from '../components/Icons.jsx';
import Notice from '../components/Notice.jsx';
import PasswordField from '../components/PasswordField.jsx';
import { api } from '../lib/api.js';
import { acceptLogin, signOut } from '../lib/auth.js';

// The same minimum as the server's.
const PASSWORD_MIN = 8;

// Shown after the teacher reset the password: the temporary one has to be replaced before anything else opens.
export default function ChangePasswordScreen() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [shown, setShown] = useState(false);
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    if (!current || !next) return setProblem('Enter the temporary password and a new one.');
    if (next.length < PASSWORD_MIN) return setProblem(`Use at least ${PASSWORD_MIN} characters for your new password.`);
    if (next !== again) return setProblem('The two new passwords are not the same. Type them again.');
    setBusy(true);
    setProblem(null);
    try {
      acceptLogin(await api.changePassword({ current, next })); // the server swaps the token: keep the new one
    } catch (err) {
      setProblem(err.message);
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    setLeaving(true);
    await signOut();
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
          <h1 className="screen-title">Choose a new password</h1>
          <p className="muted">Your teacher gave you a temporary password. Choose your own to keep studying.</p>
          <form className="stack stack--tight" onSubmit={submit} noValidate>
            <PasswordField id="change-current" label="Temporary password" value={current} onChange={setCurrent} shown={shown} onToggle={toggle} autoComplete="current-password" invalid={Boolean(problem)} />
            <PasswordField id="change-next" label="New password" value={next} onChange={setNext} shown={shown} autoComplete="new-password" describedBy="change-hint" invalid={Boolean(problem)} />
            <PasswordField id="change-again" label="Type it again" value={again} onChange={setAgain} shown={shown} autoComplete="new-password" invalid={Boolean(problem)} />
            <p id="change-hint" className="muted">
              At least {PASSWORD_MIN} characters. Use a new password just for StudyRevr.
            </p>
            {problem && <Notice>{problem}</Notice>}
            <button type="submit" className="btn btn--primary" disabled={busy || leaving}>
              {busy ? 'Saving…' : 'Save password'}
            </button>
          </form>
          <div className="gate__links">
            <button type="button" className="btn btn--quiet" onClick={leave} disabled={busy || leaving}>
              {leaving ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
