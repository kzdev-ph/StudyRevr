import { useLayoutEffect, useRef, useState } from 'react';
import { CheckIcon, QuizIcon, RetryIcon } from './Icons.jsx';
import { PenLoop } from './Pen.jsx';
import { api } from '../lib/api.js';
import { truncateAtWord } from '../lib/format.js';
import { bestLine, formatDuration, questionText, scoreLine, yesNo } from '../lib/quiz.js';
import { paths } from '../lib/router.js';

const EVIDENCE_MAX = 220;
const GRADE_MS = 500;
const GRADE_DELAY_MS = 120;

// The score, circled in pen like a grade on a test paper (drawn once; a tap finishes it). The loop is sized to the
// number once it is on the page.
function Grade({ score, total }) {
  const ref = useRef(null);
  const [box, setBox] = useState(null);
  const marks = useRef(new Set()).current;
  // sized to the number's own box, again whenever that box changes (text size, window width)
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const size = () => {
      const w = Math.round(el.offsetWidth + 24);
      const h = Math.round(el.offsetHeight + 16);
      setBox((b) => (b && b.w === w && b.h === h ? b : { w, h }));
    };
    size();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(size);
    ro.observe(el);
    return () => ro.disconnect();
  }, [score, total]);
  return (
    <span className="quiz-score__n" aria-hidden="true" ref={ref} onPointerDown={() => marks.forEach((m) => m.complete())}>
      {score}/{total}
      {box && <PenLoop className="quiz-score__ring" w={box.w} h={box.h} duration={GRADE_MS} delay={GRADE_DELAY_MS} track={marks} shape={{ turns: 1.08, tilt: -0.05, start: -0.7 }} />}
    </span>
  );
}

// Yes / no (stored as True / False): "Yes", or "No" with what is actually right.
const rightAnswer = (m) => {
  if (m.type !== 'tf' || m.right_answer === 'True') return yesNo(m, m.right_answer);
  return `No. ${m.kind === 'term' ? `${m.question} means: ` : 'The right answer: '}${m.answer_text}`;
};

// The end of a quiz: the score, the questions that were missed (with the right answer and the lesson quote),
// Retake (same questions, new order) and Back to lesson.
export default function QuizResults({ results, onRetake, busy, headingRef }) {
  const { attempt, missed } = results;
  const all = missed.length === 0;
  return (
    <div className="stack quiz-results">
      <div className="done quiz-score">
        {all ? <CheckIcon size={36} className="done__icon" /> : <QuizIcon size={36} className="done__icon" />}
        <h2 className="done__title" tabIndex={-1} ref={headingRef}>
          <Grade score={attempt.score} total={attempt.total} />
          <span className="visually-hidden">{scoreLine(attempt.score, attempt.total)}</span>
        </h2>
        <p className="done__text">
          {attempt.percent}%{attempt.duration_ms !== null ? ` in ${formatDuration(attempt.duration_ms)}` : ''}. {bestLine(attempt.percent, results.previous_best_percent)}
        </p>
        <div className="done__actions">
          <button type="button" className="btn btn--primary" onClick={onRetake} disabled={busy}>
            <RetryIcon size={18} /> Retake
          </button>
          <a className="btn btn--quiet" href={paths.lesson(attempt.lesson_id)}>
            Back to lesson
          </a>
          {!all && (
            <a
              className="btn btn--quiet"
              href={paths.study(attempt.lesson_id)}
              onClick={() => api.logEvent('review_flashcards_tap', { lesson_id: attempt.lesson_id, attempt_id: attempt.id })}
            >
              Review these flashcards
            </a>
          )}
        </div>
        <p className="muted">Retake asks the same questions in a new order.</p>
      </div>

      {all ? null : (
        <section className="stack stack--tight" aria-labelledby="quiz-missed">
          <h2 id="quiz-missed" className="decks-head quiz-missed__head">
            Missed {missed.length === 1 ? 'question' : `questions (${missed.length})`}
          </h2>
          <ol className="quiz-missed">
            {missed.map((m) => (
              <li key={m.position} className="quiz-missed__item">
                <p className="quiz-missed__q">{questionText(m)}</p>
                <dl className="quiz-missed__answers">
                  <div>
                    <dt>Your answer</dt>
                    <dd className="quiz-missed__yours">{m.your_answer === null || m.your_answer === undefined ? 'Not answered' : yesNo(m, m.your_answer)}</dd>
                  </div>
                  <div>
                    <dt>Right answer</dt>
                    <dd className="quiz-missed__right">{rightAnswer(m)}</dd>
                  </div>
                </dl>
                {m.evidence && (
                  <p className="flashcard__evidence">
                    <span className="flashcard__from">From the lesson:</span> “{truncateAtWord(m.evidence, EVIDENCE_MAX)}”
                  </p>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
