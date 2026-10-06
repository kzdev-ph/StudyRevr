import { useEffect, useState } from 'react';
import AdminPin from '../components/AdminPin.jsx';
import { ChevronLeft } from '../components/Icons.jsx';
import Notice from '../components/Notice.jsx';
import StatsView from '../components/StatsView.jsx';
import { useFocusWhen } from '../hooks/useFocusWhen.js';
import { useAdminPin } from '../lib/admin.js';
import { api } from '../lib/api.js';
import { paths } from '../lib/router.js';

// Admin's view of one participant's Stats. It is not logged as their Stats view.
export default function AdminParticipantScreen({ code }) {
  const pin = useAdminPin();
  const heading = useFocusWhen(Boolean(pin));
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!pin) return undefined;
    const controller = new AbortController();
    api.adminStats(code, controller.signal).then(setStats, (err) => err.name !== 'AbortError' && setError(err.message));
    return () => controller.abort();
  }, [code, pin, attempt]);

  const retry = () => {
    setError(null);
    setAttempt((n) => n + 1);
  };
  const loading = pin && !stats && !error;

  return (
    <section className="stack">
      <a className="back" href={paths.admin()}>
        <ChevronLeft size={18} /> Admin
      </a>
      <div className="admin-head">
        <h1 className="screen-title" tabIndex={-1} ref={heading}>
          {code}’s stats
        </h1>
        <span className="chip chip--admin">Admin view</span>
      </div>
      {!pin && <AdminPin />}
      {error && (
        <Notice
          action={
            <button type="button" className="btn btn--quiet btn--small" onClick={retry}>
              Try again
            </button>
          }
        >
          {error}
        </Notice>
      )}
      {loading && (
        <p className="muted" aria-hidden="true">
          Loading…
        </p>
      )}
      <p className="visually-hidden" role="status">
        {loading ? 'Loading stats' : ''}
      </p>
      {stats && <StatsView stats={stats} />}
    </section>
  );
}
