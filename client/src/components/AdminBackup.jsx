import { useEffect, useState } from 'react';
import Notice from './Notice.jsx';
import { api } from '../lib/api.js';

const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// Admin: a copy of the whole database (lessons, participants, everything recorded) without any API key or PIN,
// made while the app runs. `npm run restore -- <file>` on the host puts one back.
export default function AdminBackup() {
  const [last, setLast] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .lastBackup(controller.signal)
      .then((data) => setLast(data.last))
      .catch((err) => err.name !== 'AbortError' && setLast(null));
    return () => controller.abort();
  }, []);

  const backup = async () => {
    setBusy(true);
    setProblem(null);
    setMessage('');
    try {
      const name = await api.downloadBackup();
      setMessage(`Downloaded ${name}.`);
      setLast((await api.lastBackup()).last);
    } catch (err) {
      setProblem(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin-section" aria-labelledby="admin-backup">
      <h2 id="admin-backup" className="admin-section__title">
        Backup
      </h2>
      <p className="muted">
        A copy of everything: lessons, participant codes and all study records. API keys (yours and students’) and the PIN are left out. Keep it somewhere safe; it holds the
        research data.
      </p>
      <p>
        <strong>Last backup:</strong> {last === undefined ? '…' : last ? `${when(last.created_at)} (${last.file})` : 'none yet'}
      </p>
      <div>
        <button type="button" className="btn btn--primary" onClick={backup} disabled={busy}>
          {busy ? 'Preparing…' : 'Download backup'}
        </button>
      </div>
      <p role="status" className="status-ok">
        {message}
      </p>
      {problem && <Notice onDismiss={() => setProblem(null)}>{problem}</Notice>}
      <p className="muted">
        To restore one, stop the server and run <code>npm run restore -- &lt;file&gt;</code> on the host. Then enter the API key again.
      </p>
    </section>
  );
}
