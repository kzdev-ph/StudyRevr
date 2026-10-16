import { useCallback, useEffect, useState } from 'react';
import { ReviewIcon } from '../components/Icons.jsx';
import LessonRow from '../components/LessonRow.jsx';
import Notice from '../components/Notice.jsx';
import UploadZone from '../components/UploadZone.jsx';
import { api } from '../lib/api.js';
import { setWarning } from '../lib/warnings.js';
import { navigate, paths } from '../lib/router.js';
import { uploadsLeftText } from '../lib/uploads.js';

const POLL_MS = 3000;

// The lessons everyone studies, plus the student's own uploads when the researcher allows them. The researcher adds the
// teacher's lessons in admin; students open and study them here.
export default function LibraryScreen() {
  const [lessons, setLessons] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [uploads, setUploads] = useState(null); // GET /api/my-uploads, or null when unknown / off
  const [uploading, setUploading] = useState(false);
  const [problem, setProblem] = useState(null);
  const [note, setNote] = useState(null);

  const load = useCallback(async (signal) => {
    try {
      const { lessons: list } = await api.listLessons(signal);
      setLessons(list);
      setLoadError(null);
    } catch (err) {
      if (err.name !== 'AbortError') setLoadError(err.message);
    }
  }, []);
  const loadUploads = useCallback(async (signal) => {
    try {
      setUploads(await api.myUploads(signal));
    } catch (err) {
      if (err.name !== 'AbortError') setUploads(null); // the lessons still work without the upload button
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    loadUploads(controller.signal);
    return () => controller.abort();
  }, [load, loadUploads]);

  // Lessons that are still being prepared flip to ready on their own.
  const anyProcessing = lessons?.some((l) => l.status === 'processing');
  useEffect(() => {
    if (!anyProcessing) return undefined;
    const timer = setInterval(() => load(), POLL_MS);
    return () => clearInterval(timer);
  }, [anyProcessing, load]);

  const upload = async (file) => {
    setProblem(null);
    setNote(null);
    setUploading(true);
    try {
      const { lesson, warning } = await api.uploadLesson(file);
      if (warning) setWarning(lesson.id, warning);
      navigate(paths.lesson(lesson.id)); // the lesson's page shows the steps; the library keeps it listed as it is prepared
    } catch (err) {
      setProblem(err.message);
      await Promise.all([load(), loadUploads()]); // a refusal can mean today's uploads are used up
    } finally {
      setUploading(false);
    }
  };
  const retry = async (id) => {
    setProblem(null);
    try {
      await api.retryLesson(id);
    } catch (err) {
      setProblem(err.message);
    }
    await load();
  };
  const removeOwn = async (id) => {
    setProblem(null);
    try {
      await api.deleteLesson(id);
      setLessons((list) => list.filter((l) => l.id !== id));
      setNote('Deleted.');
    } catch (err) {
      setProblem(err.message);
      await load(); // e.g. it was shared or studied meanwhile: the Delete button goes
    }
  };

  const canUpload = Boolean(uploads?.allowed);
  const left = uploads?.left_today ?? 0;
  const zone = canUpload && (
    <UploadZone
      onFile={upload}
      onReject={setProblem}
      busy={uploading}
      disabled={left <= 0}
      compact={lessons?.length > 0}
      empty={lessons?.length === 0}
      title="Add your own lesson"
      text={`Drop a .docx, .pptx or .pdf file here, or choose one from your device. Only you see it${uploads.max_mb ? `. Up to ${uploads.max_mb} MB` : ''}.`}
      note={uploadsLeftText(uploads)}
    />
  );

  if (lessons?.length === 0) {
    return (
      <section className={canUpload ? 'stack' : 'empty'}>
        {canUpload ? (
          <>
            <h1 className="screen-title">Lessons</h1>
            {problem && <Notice onDismiss={() => setProblem(null)}>{problem}</Notice>}
            <p className="muted">Your teacher hasn’t added a lesson yet. You can add your own.</p>
            {zone}
          </>
        ) : (
          <>
            <ReviewIcon size={36} className="empty__icon" />
            <h1 className="empty__title">No lessons yet</h1>
            <p className="empty__text">Your teacher adds them. Check back soon.</p>
          </>
        )}
      </section>
    );
  }

  return (
    <section className="stack">
      <h1 className="screen-title">Lessons</h1>
      {loadError && (
        <Notice action={<button type="button" className="btn btn--quiet btn--small" onClick={() => load()}>Try again</button>}>
          {loadError}
        </Notice>
      )}
      {problem && <Notice onDismiss={() => setProblem(null)}>{problem}</Notice>}
      {lessons === null && !loadError && <p className="muted" aria-live="polite">Loading your lessons…</p>}
      {zone}
      {lessons?.length > 0 && (
        <ul className="lessons" aria-label="Lessons">
          {lessons.map((lesson) => (
            <LessonRow key={lesson.id} lesson={lesson} onDeleteOwn={removeOwn} onRetry={retry} />
          ))}
        </ul>
      )}
      <p className="status-ok" role="status">
        {note}
      </p>
    </section>
  );
}
