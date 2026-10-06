import { useEffect, useRef, useState } from 'react';
import Notice from '../components/Notice.jsx';
import StatsView from '../components/StatsView.jsx';
import { api } from '../lib/api.js';

// The Stats tab: the participant's own numbers. Opening it is a self-monitoring event (stats_view), logged once.
export default function StatsScreen() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const logged = useRef(false);

  useEffect(() => {
    if (!logged.current) {
      logged.current = true;
      api.logEvent('stats_view');
    }
    const controller = new AbortController();
    api.getStats(controller.signal).then(
      (s) => setStats(s),
      (err) => err.name !== 'AbortError' && setError(err.message),
    );
    return () => controller.abort();
  }, [attempt]);

  const retry = () => {
    setError(null);
    setAttempt((n) => n + 1);
  };
  const loading = !stats && !error;

  return (
    <section className="stack">
      <h1 className="screen-title">Your stats</h1>
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
          Adding up your study time…
        </p>
      )}
      <p className="visually-hidden" role="status">
        {loading ? 'Adding up your study time…' : ''}
      </p>
      {stats && <StatsView stats={stats} own />}
    </section>
  );
}
