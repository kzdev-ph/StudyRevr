import { useLayoutEffect, useRef, useState } from 'react';
import { CheckIcon, CloseIcon, RetryIcon } from './Icons.jsx';
import { PenLoop } from './Pen.jsx';
import { api } from '../lib/api.js';
import { truncateAtWord } from '../lib/format.js';
import { bestLine, formatDuration, questionLead, questionText, scoreLine, tfCorrection } from '../lib/quiz.js';
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

// What the student put, or that nothing was put.
const yourAnswer = (m) => (m.your_answer === null || m.your_answer === undefined ? null : m.your_answer);

// The end of a quiz: the score, the questions that were missed (with the right answer and the lesson quote),
// Retake (same questions, new order) and Back to lesson.
export default function QuizResults({ results, onRetake, busy, headingRef }) {
  const { attempt, missed } = results;
  const all = missed.length === 0;
  return (
    <div className="stack quiz-results">
      <div className="done quiz-score">
        {/* only a full score gets a tick; the circled number below says the rest */}
        {all && <CheckIcon size={36} className="done__icon" />}
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
            {missed.map((m) => {
              const yours = yourAnswer(m);
              const fix = tfCorrection(m);
              return (
                <li key={m.position} className="quiz-missed__item">
                  {m.type === 'tf' && <p className="flashcard__kicker">{questionLead(m)}</p>}
                  <p className="quiz-missed__q">
                    {m.type === 'tf' && (
                      <>
                        <span className="quiz-q__for-label">Question:</span>{' '}
                      </>
                    )}
                    {questionText(m)}
                  </p>
                  <dl className="quiz-missed__answers">
                    <div>
                      <dt>Your answer</dt>
                      <dd className="quiz-missed__yours">
                        <span className="quiz-opt__mark" aria-hidden="true">
                          <CloseIcon size={18} />
                        </span>
                        {yours === null ? (
                          'Not answered'
                        ) : (
                          <>
                            <s>{yours}</s>
                            <span className="visually-hidden">, not right</span>
                          </>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Right answer</dt>
                      <dd className="quiz-missed__right">{m.right_answer}</dd>
                    </div>
                  </dl>
                  {fix && <p className="quiz-missed__fix">{fix}</p>}
                  {m.evidence && (
                    <p className="flashcard__evidence">
                      <span className="flashcard__from">From the lesson:</span> “{truncateAtWord(m.evidence, EVIDENCE_MAX)}”
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </div>
  );
}
