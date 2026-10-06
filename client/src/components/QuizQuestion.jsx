import { useEffect, useRef } from 'react';
import { CheckIcon, CloseIcon } from './Icons.jsx';
import { truncateAtWord } from '../lib/format.js';
import { questionLead } from '../lib/quiz.js';

const EVIDENCE_MAX = 220;

// What an option says it is once answered; colour is never the only cue.
function optionState(i, feedback) {
  if (!feedback) return null;
  if (i === feedback.answer_index) return 'right';
  if (i === feedback.chosen_index) return 'wrong';
  return 'other';
}

// One question: what is asked, the options (1-4 on a keyboard) and, once answered, whether it was right, the right
// answer and the card's "From the lesson" quote. Focus moves to the question when it appears, so a screen reader
// reads it and the keyboard starts from it.
export default function QuizQuestion({ question: q, feedback, onAnswer, busy }) {
  const tf = q.type === 'tf';
  const headingRef = useRef(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  return (
    <article className="quiz-q" aria-labelledby="quiz-q-text">
      <p className="flashcard__kicker">{questionLead(q)}</p>
      {tf ? (
        <h2 id="quiz-q-text" className="quiz-q__ask" tabIndex={-1} ref={headingRef}>
          <span className={q.kind === 'term' ? 'quiz-q__term' : 'quiz-q__question'}>{q.question}</span>{' '}
          <span className="quiz-q__statement">
            <span className="quiz-q__label">{q.kind === 'term' ? 'means:' : 'Answer:'}</span> {q.statement}
          </span>
        </h2>
      ) : (
        <h2 id="quiz-q-text" className="quiz-q__question" tabIndex={-1} ref={headingRef}>
          {q.question}
        </h2>
      )}

      <div className={`quiz-opts${tf ? ' quiz-opts--tf' : ''}`} role="group" aria-labelledby="quiz-q-text">
        {q.choices.map((choice, i) => {
          const state = optionState(i, feedback);
          return (
            <button
              key={i}
              type="button"
              className={`quiz-opt${state ? ` quiz-opt--${state}` : ''}`}
              onClick={() => onAnswer(i)}
              disabled={busy || Boolean(feedback)}
              aria-keyshortcuts={String(i + 1)}
            >
              <kbd className="quiz-opt__key" aria-hidden="true">{i + 1}</kbd>
              <span className="quiz-opt__text">{choice}</span>
              {state === 'right' && (
                <span className="quiz-opt__tag">
                  <CheckIcon size={16} /> {feedback.chosen_index === i ? 'Your answer' : 'Right answer'}
                </span>
              )}
              {state === 'wrong' && (
                <span className="quiz-opt__tag">
                  <CloseIcon size={16} /> Your answer
                </span>
              )}
            </button>
          );
        })}
      </div>

      {feedback && (
        <div id="quiz-feedback" className={`quiz-feedback quiz-feedback--${feedback.correct ? 'right' : 'wrong'}`}>
          <p className="quiz-feedback__verdict">
            {feedback.correct ? <CheckIcon size={20} /> : <CloseIcon size={20} />}
            {feedback.correct ? 'Correct' : 'Not quite'}
          </p>
          {(!feedback.correct || tf) && (
            <p className="quiz-feedback__answer">
              {tf ? (q.kind === 'term' ? `${q.question} means: ` : 'The answer: ') : 'The right answer: '}
              <strong>{feedback.answer_text}</strong>
            </p>
          )}
          {feedback.evidence && (
            <p className="flashcard__evidence">
              <span className="flashcard__from">From the lesson:</span> “{truncateAtWord(feedback.evidence, EVIDENCE_MAX)}”
            </p>
          )}
        </div>
      )}
    </article>
  );
}
