import { useCallback, useEffect, useState } from 'react';
import LessonRow from '../components/LessonRow.jsx';
import Notice from '../components/Notice.jsx';
import UploadZone from '../components/UploadZone.jsx';
import { api } from '../lib/api.js';
import { navigate, paths } from '../lib/router.js';
import { setWarning } from '../lib/warnings.js';

const POLL_MS = 3000;

export default function LibraryScreen() {
  const [lessons, setLessons] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [deleteError, setDeleteError] = useState(null);

  const load = useCallback(async (signal) => {
    try {
      const { lessons: list } = await api.listLessons(signal);
      setLessons(list);
      setLoadError(null);
    } catch (err) {
      if (err.name !== 'AbortError') setLoadError(err.message);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Lessons that are still being prepared flip to ready on their own.
  const anyProcessing = lessons?.some((l) => l.status === 'processing');
  useEffect(() => {
    if (!anyProcessing) return undefined;
    const timer = setInterval(() => load(), POLL_MS);
    return () => clearInterval(timer);
  }, [anyProcessing, load]);

  const upload = async (file) => {
    setUploadError(null);
    setUploading(true);
    try {
      const { lesson, warning } = await api.uploadLesson(file);
      if (warning) setWarning(lesson.id, warning);
      navigate(paths.lesson(lesson.id));
    } catch (err) {
      setUploadError(err.message);
    } finally {
      setUploading(false);
    }
  };

  const remove = async (id) => {
    setDeleteError(null);
    try {
      await api.deleteLesson(id);
      setLessons((list) => list.filter((l) => l.id !== id));
    } catch (err) {
      setDeleteError(err.message);
    }
  };

  const hasLessons = lessons?.length > 0;

  return (
    <section className="stack">
      <h1 className="screen-title">Lessons</h1>

      {uploadError && (
        <Notice onDismiss={() => setUploadError(null)}>
          <strong>That file wasn’t added.</strong> {uploadError}
        </Notice>
      )}
      {deleteError && <Notice onDismiss={() => setDeleteError(null)}>{deleteError}</Notice>}
      {loadError && (
        <Notice action={<button type="button" className="btn btn--quiet btn--small" onClick={() => load()}>Try again</button>}>
          {loadError}
        </Notice>
      )}

      <UploadZone onFile={upload} onReject={setUploadError} busy={uploading} empty={lessons && !hasLessons} compact={hasLessons} />

      {lessons === null && !loadError && <p className="muted" aria-live="polite">Loading lessons…</p>}

      {hasLessons && (
        <ul className="lessons" aria-label="Your lessons">
          {lessons.map((lesson) => (
            <LessonRow key={lesson.id} lesson={lesson} onDelete={remove} />
          ))}
        </ul>
      )}
    </section>
  );
}
