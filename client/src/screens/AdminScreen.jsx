import { useCallback, useEffect, useRef, useState } from 'react';
import AdminAiSettings from '../components/AdminAiSettings.jsx';
import AdminBackup from '../components/AdminBackup.jsx';
import AdminPin from '../components/AdminPin.jsx';
import { ChevronLeft } from '../components/Icons.jsx';
import LessonRow from '../components/LessonRow.jsx';
import Notice from '../components/Notice.jsx';
import UploadZone from '../components/UploadZone.jsx';
import { useFocusWhen } from '../hooks/useFocusWhen.js';
import { lockAdmin, useAdminPin } from '../lib/admin.js';
import { api } from '../lib/api.js';
import { pct } from '../lib/stats.js';
import { useParticipant } from '../lib/participant.js';
import { paths } from '../lib/router.js';

const POLL_MS = 3000;
// The CSV files, named as they are in the zip.
const FILES = ['summary', 'sessions', 'flashcard_reviews', 'due_reviews', 'quiz_attempts', 'quiz_answers', 'events', 'ai_calls', 'lessons', 'lesson_events'];
const RUNNING = ['queued', 'running'];

// Lessons: upload, retry, delete, share. Students only read and study them. A teacher's upload stays in this list, where
// its progress shows (admin keeps the PIN only on the admin screens, so there is no processing page to open).
function LessonsSection() {
  const [lessons, setLessons] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [problem, setProblem] = useState(null);
  const heading = useRef(null);

  const load = useCallback(async (signal) => {
    try {
      setLessons((await api.listLessonsWithCounts(signal)).lessons);
    } catch (err) {
      if (err.name !== 'AbortError') setProblem(err.message);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);
  // keep refreshing while a lesson is being prepared, or its quiz answers or simpler / Taglish versions are being made
  const anyProcessing = lessons?.some(
    (l) => l.status === 'processing' || RUNNING.includes(l.flashcards?.status) || RUNNING.includes(l.quiz_options?.status) || RUNNING.includes(l.quiz_review?.status) || RUNNING.includes(l.section_versions?.status),
  );
  useEffect(() => {
    if (!anyProcessing) return undefined;
    const timer = setInterval(() => load(), POLL_MS);
    return () => clearInterval(timer);
  }, [anyProcessing, load]);

  const upload = async (file) => {
    setProblem(null);
    setUploading(true);
    try {
      const { warning } = await api.uploadLesson(file, { admin: true });
      if (warning) setProblem(warning);
      await load();
    } catch (err) {
      setProblem(err.message);
    } finally {
      setUploading(false);
    }
  };
  const remove = async (id) => {
    setProblem(null);
    try {
      await api.deleteLesson(id, { admin: true });
      setLessons((list) => list.filter((l) => l.id !== id));
      heading.current?.focus(); // the deleted row had focus
    } catch (err) {
      setProblem(err.message);
    }
  };

  // a failed lesson is made again from the step that failed (finished steps are kept)
  const retryLesson = async (id) => {
    setProblem(null);
    try {
      await api.retryLesson(id, { admin: true });
    } catch (err) {
      setProblem(err.message);
    }
    await load();
  };

  // a student's private upload becomes everyone's (one way; the row asks first)
  const shareLesson = async (id) => {
    setProblem(null);
    try {
      await api.shareLesson(id);
    } catch (err) {
      setProblem(err.message);
    }
    await load();
  };

  const prepareVersions = async (id) => {
    setProblem(null);
    try {
      await api.prepareVersions(id);
    } catch (err) {
      setProblem(err.message);
    }
    await load();
  };

  const makeFlashcards = async (id) => {
    setProblem(null);
    try {
      await api.makeFlashcards(id);
    } catch (err) {
      setProblem(err.message);
    }
    await load();
  };

  const reviewQuiz = async (id) => {
    setProblem(null);
    try {
      await api.reviewQuiz(id);
    } catch (err) {
      setProblem(err.message);
    }
    await load();
  };

  const makeQuizOptions = async (id) => {
    setProblem(null);
    try {
      await api.makeQuizOptions(id);
    } catch (err) {
      setProblem(err.message);
    }
    await load();
  };

  return (
    <section className="admin-section" aria-labelledby="admin-lessons">
      <h2 id="admin-lessons" className="admin-section__title" tabIndex={-1} ref={heading}>
        Lessons
      </h2>
      {problem && <Notice onDismiss={() => setProblem(null)}>{problem}</Notice>}
      <UploadZone onFile={upload} onReject={setProblem} busy={uploading} empty={lessons?.length === 0} />
      {lessons?.length > 0 && (
        <ul className="lessons">
          {lessons.map((lesson) => (
            <LessonRow key={lesson.id} lesson={lesson} admin onDelete={remove} onRetry={retryLesson} onShare={shareLesson} onMakeFlashcards={makeFlashcards} onMakeQuizOptions={makeQuizOptions} onReviewQuiz={reviewQuiz} onPrepareVersions={prepareVersions} onCardsChanged={load} />
          ))}
        </ul>
      )}
      <p className="muted">Delete is blocked once a participant (other than P00) has studied a lesson. Export the data first if you need a copy.</p>
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
        <div className="table-wrap" role="region" aria-label="Participants and their summary" tabIndex={0}>
          <table className="data-table">
            <caption className="visually-hidden">Participants and their summary</caption>
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Days active</th>
                <th scope="col">Study time (min)</th>
                <th scope="col">On-time rate</th>
                <th scope="col">Cards reviewed</th>
                <th scope="col">Good or Easy</th>
                <th scope="col">Quiz first try</th>
                <th scope="col">Stats views</th>
                <th scope="col">Quiz retakes</th>
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
  const [done, setDone] = useState('');
  const get = async (file) => {
    setBusy(file);
    setProblem(null);
    setDone('');
    try {
      await api.downloadExport(file, includeP00);
      setDone(`Downloaded ${file === 'all' ? 'studyrevr-export.zip' : `${file}.csv`}.`);
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
      <p className="muted">CSV files with participant codes only. No settings or API keys (yours or students’) are ever included. README.txt in the zip explains every column.</p>
      <label className="check-row">
        <input type="checkbox" checked={includeP00} onChange={(e) => setIncludeP00(e.target.checked)} />
        Include P00 (your test data)
      </label>
      {problem && <Notice onDismiss={() => setProblem(null)}>{problem}</Notice>}
      <p className="visually-hidden" role="status">
        {busy ? 'Preparing the download…' : done}
      </p>
      {done && (
        <p className="muted" aria-hidden="true">
          {done}
        </p>
      )}
      <div>
        <button type="button" className="btn btn--primary" onClick={() => get('all')} disabled={busy !== null}>
          {busy === 'all' ? 'Preparing…' : 'Download all (zip)'}
        </button>
      </div>
      <div className="export-buttons">
        {FILES.map((f) => (
          <button key={f} type="button" className="btn btn--quiet btn--small" onClick={() => get(f)} disabled={busy !== null}>
            {busy === f ? 'Preparing…' : `${f}.csv`}
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
  const heading = useFocusWhen(Boolean(pin)); // after the PIN is accepted the form is gone; focus moves to the page
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
        <h1 className="screen-title" tabIndex={-1} ref={heading}>
          Admin
        </h1>
        <AdminPin />
      </section>
    );
  }
  return (
    <section className="stack">
      {back}
      <div className="admin-head">
        <h1 className="screen-title" tabIndex={-1} ref={heading}>
          Admin
        </h1>
        <button type="button" className="btn btn--quiet btn--small" onClick={lockAdmin}>
          Lock admin
        </button>
      </div>
      <LessonsSection />
      <ParticipantsSection />
      <ExportSection />
      <AdminAiSettings />
      <AdminBackup />
    </section>
  );
}
