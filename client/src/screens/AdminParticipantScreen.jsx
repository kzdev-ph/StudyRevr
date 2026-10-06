import { useEffect, useState } from 'react';
import AdminPin from '../components/AdminPin.jsx';
import { ChevronLeft } from '../components/Icons.jsx';
import Notice from '../components/Notice.jsx';
import StatsView from '../components/StatsView.jsx';
import { useAdminPin } from '../lib/admin.js';
import { api } from '../lib/api.js';
import { paths } from '../lib/router.js';

// Admin's view of one participant's Stats. It is not logged as their Stats view.
export default function AdminParticipantScreen({ code }) {
  const pin = useAdminPin();
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!pin) return undefined;
    const controller = new AbortController();
    api.adminStats(code, controller.signal).then(setStats, (err) => err.name !== 'AbortError' && setError(err.message));
    return () => controller.abort();
  }, [code, pin]);

  return (
    <section className="stack">
      <a className="back" href={paths.admin()}>
        <ChevronLeft size={18} /> Admin
      </a>
      <h1 className="screen-title">{code}’s stats</h1>
      {!pin && <AdminPin />}
      {error && <Notice>{error}</Notice>}
      {pin && !stats && !error && <p className="muted">Loading…</p>}
      {stats && <StatsView stats={stats} />}
    </section>
  );
}
