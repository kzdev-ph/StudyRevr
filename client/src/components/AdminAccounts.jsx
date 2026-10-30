import { useCallback, useEffect, useState } from 'react';
import Notice from './Notice.jsx';
import PasswordField from './PasswordField.jsx';
import { api } from '../lib/api.js';
import { accountStatus } from '../lib/accounts.js';
import { paths } from '../lib/router.js';

// Admin > Accounts: who has signed up (email and study ID, visible here only), a temporary password, sign out
// everywhere, and P00's own test login. Admin screens make no study records.
export default function AdminAccounts() {
  const [data, setData] = useState(null);
  const [pending, setPending] = useState(null); // { code, email, kind: 'reset' | 'signout' }
  const [temporary, setTemporary] = useState(null); // { email, password }
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [testPassword, setTestPassword] = useState('');
  const [shown, setShown] = useState(false);

  const load = useCallback(async (signal) => {
    try {
      setData(await api.adminAccounts(signal));
    } catch (err) {
      if (err.name !== 'AbortError') setProblem(err.message);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const run = async (work) => {
    setBusy(true);
    setProblem(null);
    setMessage('');
    try {
      await work();
      await load();
    } catch (err) {
      setProblem(err.message);
    } finally {
      setBusy(false);
    }
  };

  const confirm = () =>
    run(async () => {
      const { code, email, kind } = pending;
      setPending(null);
      if (kind === 'reset') {
        const { temporary_password: password } = await api.resetPassword(code);
        setCopied(false);
        setTemporary({ email, password });
      } else {
        await api.signOutAccount(code);
        setMessage(`${email} is signed out.`);
      }
    });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(temporary.password);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const saveTest = (event) => {
    event.preventDefault();
    run(async () => {
      await api.setTestLogin(testEmail.trim(), testPassword);
      setTestPassword('');
      setMessage('Saved. Sign in with this email and password to try the app as a student; its records stay out of the export.');
    });
  };
  const testValid = testEmail.includes('@') && testPassword.length >= 8;

  return (
    <section className="admin-section" aria-labelledby="admin-accounts">
      <h2 id="admin-accounts" className="admin-section__title">
        Accounts
      </h2>
      <p className="muted">
        Emails are shown here only. They are never in the export or shown to other students.
        {data ? ` A device counts as active for ${data.timeout_s} seconds after its last activity.` : ''}
      </p>
      {problem && <Notice onDismiss={() => setProblem(null)}>{problem}</Notice>}
      {temporary && (
        <Notice
          tone="info"
          onDismiss={() => setTemporary(null)}
          action={
            <button type="button" className="btn btn--quiet btn--small" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          }
        >
          <p>
            Temporary password for {temporary.email}: <strong className="accounts-temp">{temporary.password}</strong>
          </p>
          <p>Read it to the student; they choose a new one when they sign in. It is shown only once.</p>
        </Notice>
      )}
      <p role="status" className="status-ok">
        {message}
      </p>
      {data && data.accounts.length === 0 && <p className="muted">No one has signed up yet.</p>}
      {data && data.accounts.length > 0 && (
        <div className="table-wrap" role="region" aria-label="Accounts" tabIndex={0}>
          <table className="data-table accounts-table">
            <caption className="visually-hidden">Accounts, with study ID, email and status</caption>
            <thead>
              <tr>
                <th scope="col">Study ID</th>
                <th scope="col">Email</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.accounts.map((a) => (
                <tr key={a.code}>
                  <th scope="row">
                    <a href={paths.adminParticipant(a.code)} aria-label={`${a.code} stats`}>
                      {a.code}
                    </a>
                  </th>
                  <td className="accounts-email">{a.email}</td>
                  <td className="accounts-status">{accountStatus(a)}</td>
                  <td className="accounts-cell">
                    {pending && pending.code === a.code ? (
                      <div className="stack stack--tight" role="group" aria-label={pending.kind === 'reset' ? 'Reset password' : 'Sign out'}>
                        <p>
                          {pending.kind === 'reset'
                            ? `Give ${pending.email} a temporary password? They will be signed out.`
                            : `Sign ${pending.email} out everywhere?`}
                        </p>
                        <div className="accounts-actions">
                          <button type="button" className="btn btn--danger btn--destroy btn--plain btn--small" onClick={confirm} disabled={busy}>
                            {pending.kind === 'reset' ? 'Reset password' : 'Sign out'}
                          </button>
                          <button type="button" className="btn btn--quiet btn--small" onClick={() => setPending(null)} disabled={busy}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="accounts-actions">
                        <button type="button" className="btn btn--quiet btn--small" disabled={busy} onClick={() => setPending({ code: a.code, email: a.email, kind: 'reset' })}>
                          Reset password
                        </button>
                        <button type="button" className="btn btn--quiet btn--small" disabled={busy} onClick={() => setPending({ code: a.code, email: a.email, kind: 'signout' })}>
                          Sign out
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form className="stack stack--tight" onSubmit={saveTest}>
        <h3 className="admin-sub">Test login (P00)</h3>
        <p id="admin-test-note" className="muted">
          Your own account for trying the app as a student. Setting it again replaces the email and password and signs that login out. Its records are left out of the
          export unless you include P00.
        </p>
        <div className="admin-add">
          <label className="field">
            <span className="field__label">Email</span>
            <input className="field__input" type="email" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby="admin-test-note" />
          </label>
          <PasswordField id="admin-test-password" label="Password (8 or more characters)" value={testPassword} onChange={setTestPassword} shown={shown} onToggle={() => setShown((s) => !s)} autoComplete="new-password" />
          <button type="submit" className="btn btn--primary" disabled={busy || !testValid}>
            Save test login
          </button>
        </div>
      </form>
    </section>
  );
}
