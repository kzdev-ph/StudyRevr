import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CheckIcon } from './Icons.jsx';

// One question: write an answer (optional), reveal the model answer, then say how it went.
// The app can't grade free text, so the student judges their own answer and gets a nudge either way.
function Question({ question, answer }) {
  const [draft, setDraft] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [result, setResult] = useState(null); // null | 'got' | 'missed'

  const reset = () => {
    setRevealed(false);
    setResult(null);
  };

  return (
    <li className="check">
      <p className="check__q">{question}</p>
      <label className="check__field">
        <span className="visually-hidden">Your answer</span>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          placeholder="Write your answer here (optional)"
          disabled={revealed}
        />
      </label>

      {!revealed && (
        <button type="button" className="btn btn--quiet" onClick={() => setRevealed(true)}>
          Show answer
        </button>
      )}

      <AnimatePresence initial={false}>
        {revealed && (
          <motion.div
            className="check__reveal"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22 }}
          >
            <div className="check__answer">
              <p className="check__answer-label">Answer</p>
              <p>{answer}</p>
            </div>

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
                    <button type="button" className="link-btn" onClick={() => { setDraft(''); reset(); }}>
                      Try again
                    </button>
                  </>
                )}
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
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
