import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import DeckShuffle from '../components/DeckShuffle.jsx';
import { ChevronLeft } from '../components/Icons.jsx';
import Notice from '../components/Notice.jsx';
import QuizQuestion from '../components/QuizQuestion.jsx';
import QuizResults from '../components/QuizResults.jsx';
import { api } from '../lib/api.js';
import { prettyTitle } from '../lib/format.js';
import { elapsed, quizKeyAction } from '../lib/quiz.js';
import { paths } from '../lib/router.js';

const SLOW_START_MS = 2500; // after this, say why starting takes a while (the first quiz makes answer options)
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// One mock quiz on a lesson. The server picks and orders the questions and keeps the answers; this screen shows the
// shuffle, one question at a time, the feedback after each answer, and the results. Every answer is saved as it is
// given, with how long the question was on screen.
//   phase: 'loading' | 'shuffle' | 'question' | 'feedback' | 'results'
export default function QuizRunScreen({ lessonId }) {
  const [phase, setPhase] = useState('loading');
  const [quiz, setQuiz] = useState(null); // { attempt, questions, notice }
  const [index, setIndex] = useState(0);
  const [feedback, setFeedback] = useState(null);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [startError, setStartError] = useState(null); // { message, final }: final when trying again can't help (409)
  const [slow, setSlow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const shownAt = useRef(0); // when the current question appeared
  const startedAt = useRef(0); // when the first question appeared
  const alive = useRef(true);
  const started = useRef(false);
  const nextRef = useRef(null);
  const resultsRef = useRef(null);
  const focusAfter = useRef(null); // 'next' | 'results' (a new question focuses itself when it appears)
  const retakeOf = useRef(null); // what "Try again" retries after a failed start

  const start = useCallback(
    async (retake = null) => {
      retakeOf.current = retake;
      setPhase('loading');
      setStartError(null);
      setError(null);
      setSlow(false);
      const timer = setTimeout(() => alive.current && setSlow(true), SLOW_START_MS);
      try {
        const next = await api.startQuiz(lessonId, retake);
        if (!alive.current) return;
        setQuiz(next);
        setNotice(next.notice);
        setIndex(0);
        setFeedback(null);
        setResults(null);
        setPhase('shuffle');
      } catch (err) {
        if (alive.current) setStartError({ message: err.message, final: err.status === 409 || err.status === 404 });
      } finally {
        clearTimeout(timer);
      }
    },
    [lessonId],
  );

  // Start once per visit (StrictMode runs effects twice; a second POST would log an empty attempt).
  useEffect(() => {
    alive.current = true;
    if (!started.current) {
      started.current = true;
      start();
    }
    return () => {
      alive.current = false;
    };
  }, [start]);

  useEffect(() => {
    const target = { next: nextRef, results: resultsRef }[focusAfter.current];
    if (target?.current) {
      target.current.focus({ preventScroll: true });
      // the pinned Next bar must not hide the verdict and the lesson quote (scroll-padding keeps them above it)
      if (focusAfter.current === 'next') document.getElementById('quiz-feedback')?.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
      focusAfter.current = null;
    }
  });

  const showQuestion = useCallback((i) => {
    setIndex(i);
    setFeedback(null);
    setPhase('question');
    shownAt.current = performance.now();
  }, []);

  const shuffled = useCallback(() => {
    startedAt.current = performance.now();
    showQuestion(0);
  }, [showQuestion]);

  const question = quiz?.questions[index];
  const last = quiz ? index === quiz.questions.length - 1 : false;

  const answer = useCallback(
    async (choice) => {
      if (phase !== 'question' || busy || !question) return;
      setBusy(true);
      setError(null);
      try {
        const timeMs = elapsed(shownAt.current, performance.now());
        const graded = await api.answerQuestion(quiz.attempt.id, { position: question.position, choice, timeMs });
        if (!alive.current) return;
        setFeedback(graded);
        setPhase('feedback');
        focusAfter.current = 'next';
      } catch (err) {
        setError(err.message);
      } finally {
        setBusy(false);
      }
    },
    [phase, busy, question, quiz],
  );

  const next = useCallback(async () => {
    if (phase !== 'feedback' || busy) return;
    if (!last) return showQuestion(index + 1);
    setBusy(true);
    setError(null);
    try {
      const done = await api.finishQuiz(quiz.attempt.id, elapsed(startedAt.current, performance.now()));
      if (!alive.current) return;
      setResults(done);
      setPhase('results');
      focusAfter.current = 'results';
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [phase, busy, last, index, quiz, showQuestion]);

  useEffect(() => {
    const onKey = (event) => {
      const action = quizKeyAction(event, { phase, optionCount: question?.choices.length ?? 0 });
      if (action === null) return;
      event.preventDefault();
      if (action === 'next') next();
      else answer(action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, question, next, answer]);

  const title = quiz ? prettyTitle(quiz.attempt.title) : 'Mock quiz';
  const total = quiz?.questions.length ?? 0;
  const counter = phase === 'question' || phase === 'feedback' ? `Question ${index + 1} of ${total}` : phase === 'results' ? 'Results' : '';

  return (
    <section className="study">
      <header className="study-head">
        <a className="icon-btn" href={paths.tab('quiz')} aria-label="All quizzes" title="All quizzes">
          <ChevronLeft />
        </a>
        <div className="study-head__text">
          <h1 className="study-head__title">{title}</h1>
          {counter && <p className="quiz-counter">{counter}</p>}
        </div>
      </header>

      {(phase === 'question' || phase === 'feedback') && (
        <div className="progress__track quiz-progress" role="progressbar" aria-label="Quiz progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={index + (feedback ? 1 : 0)}>
          <span className="progress__fill" style={{ width: `${((index + (feedback ? 1 : 0)) / total) * 100}%` }} />
        </div>
      )}

      {notice && phase !== 'results' && (
        <Notice tone="warn" onDismiss={() => setNotice(null)}>
          {notice}
        </Notice>
      )}

      {phase === 'loading' &&
        (startError ? (
          <Notice
            action={
              startError.final ? (
                <a className="btn btn--quiet btn--small" href={paths.tab('quiz')}>
                  All quizzes
                </a>
              ) : (
                <button type="button" className="btn btn--quiet btn--small" onClick={() => start(retakeOf.current)}>
                  Try again
                </button>
              )
            }
          >
            {startError.message}
          </Notice>
        ) : (
          <div className="quiz-loading" role="status">
            <span className="spinner" aria-hidden="true" />
            <p>{slow ? 'The AI is thinking up answer options for this lesson. This takes a few seconds the first time.' : 'Getting your quiz ready…'}</p>
          </div>
        ))}

      {phase === 'shuffle' && <DeckShuffle count={total} onDone={shuffled} />}

      <AnimatePresence mode="wait" initial={false}>
        {question && (phase === 'question' || phase === 'feedback') && (
          <motion.div key={`${quiz.attempt.id}-${index}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
            <QuizQuestion question={question} feedback={feedback} onAnswer={answer} busy={busy} />
          </motion.div>
        )}
      </AnimatePresence>

      {(phase === 'question' || phase === 'feedback') && error && <Notice onDismiss={() => setError(null)}>{error}</Notice>}

      {phase === 'feedback' && (
        <div className="study-actions">
          <button type="button" className="btn btn--primary study-show" onClick={next} disabled={busy} ref={nextRef} aria-describedby="quiz-feedback">
            {last ? 'See results' : 'Next question'} <kbd className="study-show__key" aria-hidden="true">Enter</kbd>
          </button>
        </div>
      )}

      {phase === 'results' && results && (
        <>
          {error && <Notice onDismiss={() => setError(null)}>{error}</Notice>}
          <QuizResults results={results} onRetake={() => start(results.attempt.id)} busy={busy} headingRef={resultsRef} />
        </>
      )}
    </section>
  );
}
