import { useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { EMAIL_SHAPE, inboxName } from '../lib/authForms.js';
import Notice from './Notice.jsx';

// Ask for a link to choose a new password. The server answers the same whether or not the email has an account.
export default function ForgotPassword({ initialEmail = '', onBack }) {
  const [email, setEmail] = useState(initialEmail);
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // the email the link was asked for
  const emailInput = useRef(null);

  const submit = async (event) => {
    event.preventDefault();
    const typed = email.trim();
    if (!typed || !EMAIL_SHAPE.test(typed)) {
      setProblem("That email doesn't look right. Check it and try again.");
      emailInput.current?.focus();
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await api.forgotPassword(typed);
      setDone(typed);
    } catch (err) {
      setProblem(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="stack stack--tight">
        <Notice tone="info">
          If an account uses <strong>{done}</strong>, we sent it a link to reset the password. Check {inboxName(done)} (and Spam). The link works for 30 minutes.
        </Notice>
        <button type="button" className="btn btn--primary" onClick={onBack}>
          Back to sign in
        </button>
      </div>
    );
  }

  return (
    <form className="stack stack--tight" onSubmit={submit} noValidate>
      <label className="field">
        <span className="field__label">Email</span>
        <input
          className="field__input"
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setProblem(null);
          }}
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          inputMode="email"
          aria-describedby={problem ? 'forgot-problem' : 'forgot-hint'}
          aria-invalid={problem ? true : undefined}
          ref={emailInput}
        />
      </label>
      <p id="forgot-hint" className="muted">
        We'll email you a link to choose a new password.
      </p>
      {problem && (
        <div id="forgot-problem">
          <Notice>{problem}</Notice>
        </div>
      )}
      <button type="submit" className="btn btn--primary" disabled={busy}>
        {busy ? 'Sending…' : 'Send reset link'}
      </button>
      <button type="button" className="btn btn--quiet" onClick={onBack} disabled={busy}>
        Back to sign in
      </button>
    </form>
  );
}
