import { useEffect, useState } from 'react';
import KeyPoints from '../components/KeyPoints.jsx';
import KeyTerms from '../components/KeyTerms.jsx';
import Notice from '../components/Notice.jsx';
import Processing from '../components/Processing.jsx';
import SectionsReview from '../components/SectionsReview.jsx';
import { ChevronLeft } from '../components/Icons.jsx';
import { useLesson } from '../hooks/useLesson.js';
import { useStudySession } from '../hooks/useStudySession.js';
import { prettyTitle, readingMinutes } from '../lib/format.js';
import { paths } from '../lib/router.js';
import { clearWarning, getWarning } from '../lib/warnings.js';

const VIEWS = [
  { id: 'sections', label: 'Sections' },
  { id: 'points', label: 'Key points' },
  { id: 'terms', label: 'Key terms' },
];

export default function LessonScreen({ id, view }) {
  const { data, error, loading, reload, setVersion } = useLesson(id);
  const [warning, setWarning] = useState(() => getWarning(id));
  // reading time: logged while a ready lesson is open, on any of its views (sections, key points, key terms)
  useStudySession(id, 'reading', { enabled: data?.lesson.status === 'ready' && data.sections.length > 0 });

  useEffect(() => () => clearWarning(id), [id]);

  if (loading) return <p className="muted" aria-live="polite">Opening your lesson…</p>;
  if (error) {
    return (
      <section className="stack">
        <a className="back" href={paths.library()}>
          <ChevronLeft size={18} /> All lessons
        </a>
        <Notice>{error.status === 404 ? "That lesson doesn't exist any more. It may have been deleted." : error.message}</Notice>
      </section>
    );
  }

  const { lesson, sections, key_points: keyPoints, key_terms: keyTerms, review_progress: progress } = data;

  if (lesson.status !== 'ready') {
    return <Processing lessonId={lesson.id} title={prettyTitle(lesson.title)} warning={warning} onReady={reload} />;
  }
  if (!sections.length) {
    return (
      <section className="stack">
        <a className="back" href={paths.library()}>
          <ChevronLeft size={18} /> All lessons
        </a>
        <Notice tone="warn">There is nothing to review in this lesson. The file may have too little text; try a text-based version.</Notice>
      </section>
    );
  }

  const minutes = readingMinutes(sections);

  return (
    <article className="lesson-view">
      <header className="lesson-head">
        <a className="icon-btn lesson-head__back" href={paths.library()} aria-label="All lessons" title="All lessons">
          <ChevronLeft />
        </a>
        <div className="lesson-head__text">
          <h1 className="lesson-head__title">{prettyTitle(lesson.title)}</h1>
          <p className="muted">
            {sections.length} {sections.length === 1 ? 'section' : 'sections'}, about {minutes} min to read
          </p>
        </div>
      </header>

      {warning && (
        <Notice tone="warn" onDismiss={() => setWarning(null)}>
          {warning}
        </Notice>
      )}

      <nav className="subnav" aria-label="Lesson">
        {VIEWS.map(({ id: viewId, label }) => (
          <a key={viewId} href={paths.lesson(lesson.id, viewId)} aria-current={view === viewId ? 'page' : undefined}>
            <span className={view === viewId ? 'mk' : undefined}>{label}</span>
          </a>
        ))}
      </nav>

      {view === 'sections' && <SectionsReview lesson={lesson} sections={sections} progress={progress} keyTermCount={keyTerms.length} onVersion={setVersion} />}
      {view === 'points' && <KeyPoints points={keyPoints} lessonId={lesson.id} />}
      {view === 'terms' && <KeyTerms terms={keyTerms} lessonId={lesson.id} />}
    </article>
  );
}
