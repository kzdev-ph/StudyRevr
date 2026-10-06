import { useEffect, useRef, useState } from 'react';
import Notice from '../components/Notice.jsx';
import StatsView from '../components/StatsView.jsx';
import { api } from '../lib/api.js';

// The Stats tab: the participant's own numbers. Opening it is a self-monitoring event (stats_view), logged once.
export default function StatsScreen() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
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
  }, []);

  return (
    <section className="stack">
      <h1 className="screen-title">Your stats</h1>
      {error && <Notice>{error}</Notice>}
      {!stats && !error && <p className="muted" aria-live="polite">Adding up your study time…</p>}
      {stats && <StatsView stats={stats} />}
    </section>
  );
}
