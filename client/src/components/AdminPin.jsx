import { useState } from 'react';
import Notice from './Notice.jsx';
import { api } from '../lib/api.js';
import { setAdminPin } from '../lib/admin.js';

// Asks for the admin PIN and checks it on the server before admin opens.
export default function AdminPin() {
  const [pin, setPin] = useState('');
  const [problem, setProblem] = useState(null);
  const [checking, setChecking] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setChecking(true);
    setProblem(null);
    try {
      await api.unlockAdmin(pin);
      setAdminPin(pin);
    } catch (err) {
      setProblem(err.message);
    } finally {
      setChecking(false);
    }
  };

  return (
    <form className="stack stack--tight" onSubmit={submit}>
      <label className="field">
        <span className="field__label">Admin PIN</span>
        <input
          className="field__input"
          type="password"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          autoComplete="current-password"
          aria-invalid={problem ? true : undefined}
          aria-describedby="admin-pin-note"
          autoFocus
        />
      </label>
      {problem && <Notice>{problem}</Notice>}
      <p id="admin-pin-note" className="muted">
        Ask the researcher for the PIN.
      </p>
      <div>
        <button type="submit" className="btn btn--primary" disabled={checking || !pin}>
          {checking ? 'Checking…' : 'Open admin'}
        </button>
      </div>
    </form>
  );
}
