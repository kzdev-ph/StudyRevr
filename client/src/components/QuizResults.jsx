import { CheckIcon, QuizIcon, RetryIcon } from './Icons.jsx';
import { api } from '../lib/api.js';
import { truncateAtWord } from '../lib/format.js';
import { bestLine, formatDuration, questionText, scoreLine } from '../lib/quiz.js';
import { paths } from '../lib/router.js';

const EVIDENCE_MAX = 220;

// True / false: "True", or "False" with what is actually right.
const rightAnswer = (m) => {
  if (m.type !== 'tf' || m.right_answer === 'True') return m.right_answer;
  return `False. ${m.kind === 'term' ? `${m.question} means: ` : 'The right answer: '}${m.answer_text}`;
};

// The end of a quiz: the score, the questions that were missed (with the right answer and the lesson quote),
// Retake (same questions, new order) and Back to lesson.
export default function QuizResults({ results, onRetake, busy, headingRef }) {
  const { attempt, missed } = results;
  const all = missed.length === 0;
  return (
    <div className="stack">
      <div className="done quiz-score">
        {all ? <CheckIcon size={36} className="done__icon" /> : <QuizIcon size={36} className="done__icon" />}
        <h2 className="done__title" tabIndex={-1} ref={headingRef}>
          <span className="quiz-score__n" aria-hidden="true">
            {attempt.score}/{attempt.total}
          </span>
          <span className="quiz-score__line">{scoreLine(attempt.score, attempt.total)}</span>
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

      {all ? (
        <p className="muted">You got every question right.</p>
      ) : (
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
                    <dd className="quiz-missed__yours">{m.your_answer ?? 'Not answered'}</dd>
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
