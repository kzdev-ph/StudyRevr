import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CheckIcon, CloseIcon } from './Icons.jsx';
import { PenLoop, PenStrike, PenTick } from './Pen.jsx';
import { truncateAtWord } from '../lib/format.js';
import { capitalFirst, questionLead, tfCorrection, tfStatement } from '../lib/quiz.js';

const EVIDENCE_MAX = 220;
// the marks, after the answer is saved: the student's loop round their number, then the teacher's tick or strike
const LOOP_MS = 260;
const MARK_MS = 180;
const MARK_DELAY_MS = 220;

// What an option says it is once answered; colour is never the only cue.
function optionState(i, feedback) {
  if (!feedback) return null;
  if (i === feedback.answer_index) return 'right';
  if (i === feedback.chosen_index) return 'wrong';
  return 'other';
}

// One question: what is asked, the options (1-4 on a keyboard) and, once answered, whether it was right, the right
// answer and the card's "From the lesson" quote. Focus moves to the question when it appears, so a screen reader
// reads it and the keyboard starts from it. Once the answer is saved it is marked like a test paper: a pen loop round
// the number chosen, a tick on the right answer, a line through a wrong one. The marks never hold anything up (Next
// works at once) and a tap finishes them.
export default function QuizQuestion({ question: q, feedback, onAnswer, busy, refocus = 0 }) {
  const tf = q.type === 'tf';
  const headingRef = useRef(null);
  const optsRef = useRef(null);
  const marks = useRef(new Set()).current;
  const [strike, setStrike] = useState(false); // only through a wrong answer on one line: a long one keeps its cross
  // when the question appears, and again when `refocus` changes (an answer that could not be saved: the option that had
  // focus was disabled while it was sent, so focus would otherwise be lost)
  useEffect(() => {
    headingRef.current?.focus();
  }, [refocus]);
  useLayoutEffect(() => {
    if (!feedback || feedback.correct) return;
    const text = optsRef.current?.children[feedback.chosen_index]?.querySelector('.quiz-opt__text > span');
    setStrike(Boolean(text) && text.getClientRects().length === 1);
  }, [feedback]);
  const finishMarks = () => {
    for (const m of marks) m.complete();
  };
  return (
    <article className="quiz-q" aria-labelledby="quiz-q-text" aria-describedby="quiz-counter" onPointerDown={feedback ? finishMarks : undefined}>
      <p className="flashcard__kicker">{questionLead(q)}</p>
      {tf ? (
        <h2 id="quiz-q-text" className="quiz-q__question" tabIndex={-1} ref={headingRef}>
          <span className="quiz-q__for-label">Question:</span> {tfStatement(q)}
        </h2>
      ) : (
        <h2 id="quiz-q-text" className="quiz-q__question" tabIndex={-1} ref={headingRef}>
          {q.question}
        </h2>
      )}

      <div className={`quiz-opts${tf ? ' quiz-opts--tf' : ''}`} role="group" aria-labelledby="quiz-q-text" ref={optsRef}>
        {q.choices.map((choice, i) => {
          const state = optionState(i, feedback);
          const chosen = feedback?.chosen_index === i;
          return (
            <button
              key={i}
              type="button"
              className={`quiz-opt${state ? ` quiz-opt--${state}` : ''}`}
              onClick={() => onAnswer(i)}
              disabled={busy || Boolean(feedback)}
              aria-keyshortcuts={String(i + 1)}
            >
              <kbd className="quiz-opt__key" aria-hidden="true">
                {i + 1}
                {chosen && <PenLoop className="pen-loop" w={40} h={34} duration={LOOP_MS} track={marks} />}
              </kbd>
              <span className="quiz-opt__text">
                <span>
                  {capitalFirst(choice)}
                  {state === 'wrong' && strike && <PenStrike duration={MARK_MS} delay={MARK_DELAY_MS} track={marks} />}
                </span>
              </span>
              {/* a fixed slot, so marking the answer never changes the option's height */}
              <span className="quiz-opt__mark" aria-hidden="true">
                {state === 'right' && <PenTick className="pen-tick" duration={MARK_MS} delay={MARK_DELAY_MS} track={marks} />}
                {state === 'wrong' && <CloseIcon size={18} />}
              </span>
              {state === 'right' && <span className="visually-hidden">{chosen ? 'Your answer, right' : 'Right answer'}</span>}
              {state === 'wrong' && <span className="visually-hidden">Your answer, not right</span>}
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
          {/* a true / false statement that was true and answered False says so; one that was false says what is true */}
          {tf && !feedback.correct && q.choices[feedback.answer_index] === 'True' && (
            <p className="quiz-feedback__answer">{tfCorrection({ type: 'tf', right_answer: 'True' })}</p>
          )}
          {(tf ? q.choices[feedback.answer_index] !== 'True' : !feedback.correct) && (
            <p className="quiz-feedback__answer">
              {tf ? (q.kind === 'term' ? `${q.question} means: ` : 'The answer is ') : 'The right answer: '}
              <strong>{feedback.answer_text}</strong>
              {tf && q.kind !== 'term' && !/[.!?]$/.test(String(feedback.answer_text).trim()) ? '.' : null}
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
