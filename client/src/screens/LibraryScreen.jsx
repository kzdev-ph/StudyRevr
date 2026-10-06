import { useCallback, useEffect, useState } from 'react';
import { ReviewIcon } from '../components/Icons.jsx';
import LessonRow from '../components/LessonRow.jsx';
import Notice from '../components/Notice.jsx';
import { api } from '../lib/api.js';

const POLL_MS = 3000;

// The lessons everyone studies. The researcher adds them in admin; students open and study them here.
export default function LibraryScreen() {
  const [lessons, setLessons] = useState(null);
  const [loadError, setLoadError] = useState(null);

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

  if (lessons?.length === 0) {
    return (
      <section className="empty">
        <ReviewIcon size={36} className="empty__icon" />
        <h1 className="empty__title">No lessons yet</h1>
        <p className="empty__text">Your teacher adds them. Check back soon.</p>
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
      {lessons === null && !loadError && <p className="muted" aria-live="polite">Loading your lessons…</p>}
      {lessons?.length > 0 && (
        <ul className="lessons" aria-label="Lessons">
          {lessons.map((lesson) => (
            <LessonRow key={lesson.id} lesson={lesson} />
          ))}
        </ul>
      )}
    </section>
  );
}
