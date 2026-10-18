import { useEffect, useState } from 'react';
import AdminPin from '../components/AdminPin.jsx';
import { ChevronLeft } from '../components/Icons.jsx';
import Notice from '../components/Notice.jsx';
import Prose from '../components/Prose.jsx';
import { useFocusWhen } from '../hooks/useFocusWhen.js';
import { useAdminPin } from '../lib/admin.js';
import { api } from '../lib/api.js';
import { prettyTitle } from '../lib/format.js';
import { paths } from '../lib/router.js';
import { adminLessonNote, madeByNote, thinkingNote } from '../lib/uploads.js';

// Admin's read-only look at one lesson, a student's private upload included. It is not the reader: no study session,
// no saved progress, no events and no Explain simpler / Taglish (so no AI call). The PIN is kept only while an admin
// screen is open, which is why admin does not use the student's reader for this.
export default function AdminLessonScreen({ lessonId }) {
  const pin = useAdminPin();
  const heading = useFocusWhen(Boolean(pin));
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!pin) return undefined;
    const controller = new AbortController();
    api.getLesson(lessonId, controller.signal, { admin: true }).then(setData, (err) => err.name !== 'AbortError' && setError(err));
    return () => controller.abort();
  }, [lessonId, pin, attempt]);

  const retry = () => {
    setError(null);
    setAttempt((n) => n + 1);
  };
  const loading = pin && !data && !error;
  const lesson = data?.lesson;

  return (
    <section className="stack">
      <a className="back" href={paths.admin()}>
        <ChevronLeft size={18} /> Admin
      </a>
      <div className="admin-head">
        <h1 className="screen-title" tabIndex={-1} ref={heading}>
          {lesson ? prettyTitle(lesson.title) : 'Lesson'}
        </h1>
        <span className="chip chip--admin">Admin view</span>
      </div>
      {!pin && <AdminPin />}
      {error && (
        <Notice
          action={
            error.status === 404 ? null : (
              <button type="button" className="btn btn--quiet btn--small" onClick={retry}>
                Try again
              </button>
            )
          }
        >
          {error.status === 404 ? 'That lesson doesn’t exist any more.' : error.message}
        </Notice>
      )}
      {loading && (
        <p className="muted" aria-hidden="true">
          Loading…
        </p>
      )}
      <p className="visually-hidden" role="status">
        {loading ? 'Loading lesson' : ''}
      </p>

      {lesson && (
        <>
          <p className="muted">
            {lesson.word_count.toLocaleString()} words
            {[adminLessonNote(lesson), madeByNote(lesson), thinkingNote(lesson)].filter(Boolean).map((note) => ` · ${note}`)}
          </p>
          {lesson.status !== 'ready' && (
            <Notice tone={lesson.status === 'failed' ? undefined : 'warn'}>
              {lesson.status === 'failed'
                ? `This lesson failed: ${lesson.error ?? 'no reason was recorded'}. Retry it from the lesson list.`
                : 'This lesson is still being prepared.'}
            </Notice>
          )}

          {data.sections.length > 0 && (
            <section className="stack" aria-labelledby="admin-lesson-sections">
              <h2 id="admin-lesson-sections" className="admin-section__title">
                Sections
              </h2>
              {data.sections.map((section) => (
                <article key={section.id} className="stack stack--tight">
                  <h3>{section.title}</h3>
                  <Prose text={section.content} />
                </article>
              ))}
            </section>
          )}

          {data.key_points.length > 0 && (
            <section className="stack" aria-labelledby="admin-lesson-points">
              <h2 id="admin-lesson-points" className="admin-section__title">
                Key points
              </h2>
              <ul className="points">
                {data.key_points.map((p) => (
                  <li key={p.id} className="points__item">
                    {p.text}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data.key_terms.length > 0 && (
            <section className="stack" aria-labelledby="admin-lesson-terms">
              <h2 id="admin-lesson-terms" className="admin-section__title">
                Key terms
              </h2>
              <dl className="terms">
                {data.key_terms.map((t) => (
                  <div key={t.id} className="term">
                    <dt className="term__name">{t.term}</dt>
                    <dd>{t.definition}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </>
      )}
    </section>
  );
}
