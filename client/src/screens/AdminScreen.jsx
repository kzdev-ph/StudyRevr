import { useCallback, useEffect, useState } from 'react';
import AdminPin from '../components/AdminPin.jsx';
import { ChevronLeft } from '../components/Icons.jsx';
import LessonRow from '../components/LessonRow.jsx';
import Notice from '../components/Notice.jsx';
import UploadZone from '../components/UploadZone.jsx';
import { lockAdmin, useAdminPin } from '../lib/admin.js';
import { api } from '../lib/api.js';
import { pct } from '../lib/stats.js';
import { useParticipant } from '../lib/participant.js';
import { navigate, paths } from '../lib/router.js';
import { setWarning } from '../lib/warnings.js';

const POLL_MS = 3000;
const FILES = [
  { id: 'summary', label: 'Summary' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'flashcard_reviews', label: 'Flashcard reviews' },
  { id: 'due_reviews', label: 'Due reviews (planning)' },
  { id: 'quiz_attempts', label: 'Quiz attempts' },
  { id: 'quiz_answers', label: 'Quiz answers' },
  { id: 'events', label: 'Events' },
];

// Lessons: upload, retry (on the lesson's page), delete. Students only read and study them. With a participant code
// in use (P00 for the researcher), an upload opens the lesson's progress page; without one it stays in the list.
function LessonsSection({ participant }) {
  const [lessons, setLessons] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [problem, setProblem] = useState(null);

  const load = useCallback(async (signal) => {
    try {
      setLessons((await api.listLessons(signal)).lessons);
    } catch (err) {
      if (err.name !== 'AbortError') setProblem(err.message);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const anyProcessing = lessons?.some((l) => l.status === 'processing');
  useEffect(() => {
    if (!anyProcessing) return undefined;
    const timer = setInterval(() => load(), POLL_MS);
    return () => clearInterval(timer);
  }, [anyProcessing, load]);

  const upload = async (file) => {
    setProblem(null);
    setUploading(true);
    try {
      const { lesson, warning } = await api.uploadLesson(file);
      if (warning) setWarning(lesson.id, warning);
      if (participant) navigate(paths.lesson(lesson.id));
      else {
        if (warning) setProblem(warning);
        await load();
      }
    } catch (err) {
      setProblem(err.message);
    } finally {
      setUploading(false);
    }
  };
  const remove = async (id) => {
    setProblem(null);
    try {
      await api.deleteLesson(id);
      setLessons((list) => list.filter((l) => l.id !== id));
    } catch (err) {
      setProblem(err.message);
    }
  };

  return (
    <section className="admin-section" aria-labelledby="admin-lessons">
      <h2 id="admin-lessons" className="admin-section__title">
        Lessons
      </h2>
      {problem && <Notice onDismiss={() => setProblem(null)}>{problem}</Notice>}
      <UploadZone onFile={upload} onReject={setProblem} busy={uploading} empty={lessons?.length === 0} />
      {lessons?.length > 0 && (
        <ul className="lessons" aria-label="Lessons">
          {lessons.map((lesson) => (
            <LessonRow key={lesson.id} lesson={lesson} onDelete={remove} />
          ))}
        </ul>
      )}
      <p className="muted">Deleting a lesson removes its review, cards, quizzes and everyone’s answers on them. Study time already logged is kept.</p>
    </section>
  );
}

// Participant codes and the per-participant summary (the full columns are in summary.csv).
function ParticipantsSection() {
  const [data, setData] = useState(null);
  const [codes, setCodes] = useState('');
  const [message, setMessage] = useState(null);
  const [problem, setProblem] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async (signal) => {
    try {
      setData(await api.adminParticipants(signal));
    } catch (err) {
      if (err.name !== 'AbortError') setProblem(err.message);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const add = async (event) => {
    event.preventDefault();
    setAdding(true);
    setProblem(null);
    setMessage(null);
    try {
      const { added, existing } = await api.addParticipants(codes);
      const parts = [];
      if (added.length) parts.push(`Added ${added.join(', ')}.`);
      if (existing.length) parts.push(`Already on the list: ${existing.join(', ')}.`);
      setMessage(parts.join(' '));
      setCodes('');
      await load();
    } catch (err) {
      setProblem(err.message);
    } finally {
      setAdding(false);
    }
  };

  return (
    <section className="admin-section" aria-labelledby="admin-participants">
      <h2 id="admin-participants" className="admin-section__title">
        Participants
      </h2>
      <form className="admin-add" onSubmit={add}>
        <label className="field">
          <span className="field__label">Add participants</span>
          <input
            className="field__input"
            value={codes}
            onChange={(e) => setCodes(e.target.value)}
            placeholder="P01-P10, P12"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            aria-describedby="admin-add-note"
          />
        </label>
        <button type="submit" className="btn btn--primary" disabled={adding || !codes.trim()}>
          {adding ? 'Adding…' : 'Add'}
        </button>
      </form>
      <p id="admin-add-note" className="muted">
        One or more codes, or a range. Students can only use codes on this list. To withdraw someone, run npm run participant:delete -- P07 on the host.
      </p>
      <p aria-live="polite" className="muted">
        {message}
      </p>
      {problem && <Notice onDismiss={() => setProblem(null)}>{problem}</Notice>}
      {data && (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="visually-hidden">Participants and their summary</caption>
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Days active</th>
                <th scope="col">Study min</th>
                <th scope="col">On time</th>
                <th scope="col">Cards</th>
                <th scope="col">Good/Easy</th>
                <th scope="col">Quiz 1st</th>
                <th scope="col">Stats views</th>
                <th scope="col">Retakes</th>
              </tr>
            </thead>
            <tbody>
              {data.participants.map((p) => (
                <tr key={p.participant}>
                  <th scope="row">
                    <a href={paths.adminParticipant(p.participant)} aria-label={`${p.participant} stats`}>
                      {p.participant}
                    </a>
                  </th>
                  <td>{p.planning_days_active}</td>
                  <td>{p.planning_total_min}</td>
                  <td>{p.planning_on_time_rate === null ? '–' : pct(p.planning_on_time_rate * 100)}</td>
                  <td>{p.retention_cards_reviewed}</td>
                  <td>{pct(p.retention_good_easy_pct)}</td>
                  <td>{pct(p.retention_quiz_first_pct_mean)}</td>
                  <td>{p.self_monitoring_stats_views}</td>
                  <td>{p.self_monitoring_quiz_retakes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted">P00 is your own test data. Tap a code to see that participant’s Stats.</p>
    </section>
  );
}

function ExportSection() {
  const [includeP00, setIncludeP00] = useState(false);
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);
  const get = async (file) => {
    setBusy(file);
    setProblem(null);
    try {
      await api.downloadExport(file, includeP00);
    } catch (err) {
      setProblem(err.message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="admin-section" aria-labelledby="admin-export">
      <h2 id="admin-export" className="admin-section__title">
        Research export
      </h2>
      <p className="muted">CSV files with participant codes only. No settings or API keys are ever included. README.txt in the zip explains every column.</p>
      <label className="check-row">
        <input type="checkbox" checked={includeP00} onChange={(e) => setIncludeP00(e.target.checked)} />
        Include P00 (your test data)
      </label>
      {problem && <Notice onDismiss={() => setProblem(null)}>{problem}</Notice>}
      <div>
        <button type="button" className="btn btn--primary" onClick={() => get('all')} disabled={busy !== null}>
          {busy === 'all' ? 'Preparing…' : 'Download all (zip)'}
        </button>
      </div>
      <div className="export-buttons">
        {FILES.map((f) => (
          <button key={f.id} type="button" className="btn btn--quiet btn--small" onClick={() => get(f.id)} disabled={busy !== null}>
            {busy === f.id ? 'Preparing…' : `${f.label}.csv`}
          </button>
        ))}
      </div>
    </section>
  );
}

// The researcher's area, behind the admin PIN (checked by the server on every request).
export default function AdminScreen() {
  const pin = useAdminPin();
  const participant = useParticipant();
  const back = participant ? (
    <a className="back" href={paths.tab('settings')}>
      <ChevronLeft size={18} /> Settings
    </a>
  ) : (
    <a className="back" href="#/">
      <ChevronLeft size={18} /> Back
    </a>
  );

  if (!pin) {
    return (
      <section className="stack">
        {back}
        <h1 className="screen-title">Admin</h1>
        <AdminPin />
      </section>
    );
  }
  return (
    <section className="stack">
      {back}
      <div className="admin-head">
        <h1 className="screen-title">Admin</h1>
        <button type="button" className="btn btn--quiet btn--small" onClick={lockAdmin}>
          Lock admin
        </button>
      </div>
      <ParticipantsSection />
      <ExportSection />
      <LessonsSection participant={participant} />
    </section>
  );
}
