import { useCallback, useEffect, useState } from 'react';
import { QuizIcon } from '../components/Icons.jsx';
import Notice from '../components/Notice.jsx';
import { api } from '../lib/api.js';
import { prettyTitle } from '../lib/format.js';
import { lessonQuizLine } from '../lib/quiz.js';
import { paths } from '../lib/router.js';

const POLL_MS = 2500;

// The right-hand side of a lesson row: Start, or why there is nothing to start yet.
function QuizAction({ row }) {
  if (row.status === 'processing' || row.making_cards) {
    return (
      <span className="chip chip--busy">
        <span className="spinner spinner--small" aria-hidden="true" /> {row.status === 'processing' ? 'Preparing' : 'Making cards'}
      </span>
    );
  }
  if (row.status === 'failed' && !row.cards) {
    return (
      <a className="btn btn--quiet" href={paths.lesson(row.lesson_id)}>
        Open lesson to retry
      </a>
    );
  }
  if (!row.cards) {
    return (
      <a className="btn btn--quiet" href={paths.tab('flashcards')} aria-label={`Make flashcards for ${prettyTitle(row.title)} first`}>
        Make cards first
      </a>
    );
  }
  if (!row.questions) return <span className="deck__total">Needs 2+ cards</span>;
  return (
    <a className="btn btn--primary" href={paths.quiz(row.lesson_id)} aria-label={`Start the quiz on ${prettyTitle(row.title)}`}>
      Start
    </a>
  );
}

// Mock Quiz tab: one row per lesson with its best score and Start.
export default function QuizScreen() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async (signal) => {
    try {
      setData(await api.listQuizzes(signal));
      setError(null);
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // A lesson still preparing (or getting its cards) shows up as ready on its own.
  const busy = data?.lessons.some((l) => l.status === 'processing' || l.making_cards);
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(() => load(), POLL_MS);
    return () => clearInterval(timer);
  }, [busy, load]);

  if (error && !data) {
    return (
      <section className="stack">
        <h1 className="screen-title">Mock Quiz</h1>
        <Notice action={<button type="button" className="btn btn--quiet btn--small" onClick={() => load()}>Try again</button>}>{error}</Notice>
      </section>
    );
  }
  if (!data) return <p className="muted" aria-live="polite">Loading your quizzes…</p>;

  if (!data.lessons.length) {
    return (
      <section className="empty">
        <QuizIcon size={36} className="empty__icon" />
        <h1 className="empty__title">No quizzes yet</h1>
        <p className="empty__text">Upload a lesson. Its quiz is made from the lesson’s flashcards.</p>
        <a className="btn btn--primary" href={paths.library()}>
          Upload a lesson
        </a>
      </section>
    );
  }

  return (
    <section className="stack">
      <h1 className="screen-title">Mock Quiz</h1>
      <p className="muted">
        Up to {data.quiz_length} questions from a lesson’s flashcards: multiple choice and true or false. No timer. Your flashcard schedule isn’t affected.
      </p>
      <ul className="decks" aria-label="Lessons">
        {data.lessons.map((row) => (
          <li key={row.lesson_id} className="deck">
            <div className="deck__main">
              <span className="deck__title">{prettyTitle(row.title)}</span>
              <span className="deck__total">{lessonQuizLine(row) || (row.cards === 1 ? 'Only 1 flashcard' : row.status === 'ready' && !row.cards ? 'No flashcards yet' : ' ')}</span>
            </div>
            <QuizAction row={row} />
          </li>
        ))}
      </ul>
    </section>
  );
}
