import { useEffect, useRef, useState } from 'react';
import { animate, motion, useReducedMotion } from 'motion/react';
import { CheckIcon } from './Icons.jsx';

const LIFT = { duration: 0.28, ease: [0.4, 0, 0.2, 1] };
const FADE = { duration: 0.15 };

// One question: write an answer (optional), reveal the model answer, then say how it went.
// The app can't grade free text, so the student judges their own answer and gets a nudge either way.
// The answer lies under an index card, already in its place (so nothing on the page moves): Show answer lifts the
// card off it, sliding it aside (a fade with reduced motion).
function Question({ question, answer }) {
  const reduce = useReducedMotion();
  const [draft, setDraft] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [covered, setCovered] = useState(true); // the card is on the answer (it stays until it has slid off)
  const [result, setResult] = useState(null); // null | 'got' | 'missed'
  const cover = useRef(null);
  const answerRef = useRef(null);

  // the button goes away: focus the answer once it is readable, so a screen reader reads it and the keyboard carries
  // on from it
  const focusAnswer = useRef(false);
  useEffect(() => {
    if (revealed && focusAnswer.current) answerRef.current?.focus({ preventScroll: true });
    focusAnswer.current = false;
  }, [revealed]);

  // the cover's slide, so leaving the page (or starting over) ends it instead of letting it set state afterwards
  const liftRun = useRef(null);
  const endLift = () => {
    const run = liftRun.current;
    liftRun.current = null;
    run?.stop();
  };
  useEffect(() => endLift, []);

  const lift = () => {
    if (revealed) return;
    focusAnswer.current = true;
    setRevealed(true);
    const el = cover.current;
    if (!el) return setCovered(false);
    const run = reduce
      ? animate(el, { opacity: [1, 0] }, FADE)
      : animate(el, { x: ['0%', '30%', '70%'], rotate: [0, 2, 5], opacity: [1, 1, 0] }, { ...LIFT, times: [0, 0.55, 1] });
    liftRun.current = run;
    run.then(() => {
      if (liftRun.current !== run) return;
      liftRun.current = null;
      setCovered(false);
    });
  };

  const reset = () => {
    endLift();
    setRevealed(false);
    setCovered(true);
    setResult(null);
  };

  return (
    <li className="check">
      <p className="check__q">{question}</p>
      <label className="check__field">
        <span className="visually-hidden">Your answer</span>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} placeholder="Type your answer…" disabled={revealed} />
      </label>

      <div className="check__slot">
        <div className="check__answer" ref={answerRef} tabIndex={-1} aria-hidden={!revealed} inert={!revealed}>
          <p className="check__answer-label">Answer</p>
          <p>{answer}</p>
        </div>
        {covered && (
          <button type="button" className="check__cover" ref={cover} onClick={lift} disabled={revealed}>
            Show answer
          </button>
        )}
      </div>

      {revealed && (
        <motion.div className="check__after" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ ...FADE, delay: reduce ? 0 : 0.12 }}>
          {result === null ? (
            <div className="check__rate" role="group" aria-label="How did you do?">
              <span>How did your answer compare?</span>
              <button type="button" className="btn btn--small btn--ok" onClick={() => setResult('got')}>
                I got it
              </button>
              <button type="button" className="btn btn--small btn--quiet" onClick={() => setResult('missed')}>
                Not quite
              </button>
            </div>
          ) : (
            <p className={`check__feedback check__feedback--${result}`} role="status">
              {result === 'got' ? (
                <>
                  <CheckIcon size={18} /> Good. You can move on to the next section.
                </>
              ) : (
                <>
                  Reread the section above, then try the question again.{' '}
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      setDraft('');
                      reset();
                    }}
                  >
                    Try again
                  </button>
                </>
              )}
            </p>
          )}
        </motion.div>
      )}
    </li>
  );
}

export default function QuickCheck({ questions }) {
  if (!questions.length) return null;
  return (
    <section className="quickcheck" aria-labelledby="quickcheck-title">
      <h3 id="quickcheck-title" className="quickcheck__title">
        Quick check
      </h3>
      <ul className="quickcheck__list">
        {questions.map((q, i) => (
          <Question key={i} question={q.question} answer={q.answer} />
        ))}
      </ul>
    </section>
  );
}
