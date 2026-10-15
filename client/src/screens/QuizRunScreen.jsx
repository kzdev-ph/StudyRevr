import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { animate, motion, useReducedMotion } from 'motion/react';
import { ChevronLeft } from '../components/Icons.jsx';
import Notice from '../components/Notice.jsx';
import QuizQuestion from '../components/QuizQuestion.jsx';
import QuizResults from '../components/QuizResults.jsx';
import { useAnswerClock } from '../hooks/useAnswerClock.js';
import { useStudySession } from '../hooks/useStudySession.js';
import { api } from '../lib/api.js';
import { prettyTitle } from '../lib/format.js';
import { bubbleStates, elapsed, quizKeyAction } from '../lib/quiz.js';
import { paths } from '../lib/router.js';

const SLOW_START_MS = 2500; // after this, say why starting takes a while (the first quiz makes answer options)
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const OUT = [0.16, 1, 0.3, 1];
const HANDOUT = { duration: 0.42, ease: OUT }; // the test sheet slides up into place
const HANDOUT_FADE = { duration: 0.15 };
const SKIP_KEYS = new Set(['Enter', ' ', 'Escape']);

// The answer sheet: one bubble per question, filled once it is answered, ringed while it is open. It shows progress
// without saying what was right (no scoreboard mid-quiz).
function AnswerSheet({ total, answered, index }) {
  const reduce = useReducedMotion();
  return (
    <div
      className="quiz-sheet"
      role="progressbar"
      aria-label="Quiz progress"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={answered}
      aria-valuetext={`${answered} of ${total} answered`}
    >
      {bubbleStates(total, answered, index).map((state, k) => (
        <span key={k} className={`quiz-sheet__bubble quiz-sheet__bubble--${state}`}>
          <motion.i initial={false} animate={{ scale: state === 'done' ? 1 : 0 }} transition={reduce ? { duration: 0 } : { duration: 0.15, ease: OUT }} />
        </span>
      ))}
    </div>
  );
}

// One mock quiz on a lesson. The server picks and orders the questions and keeps the answers; this screen hands out
// the test sheet, shows one question at a time, the feedback after each answer, and the results. Every answer is saved
// as it is given, with how long the question was usable on screen (useAnswerClock: animation is never counted).
//   phase: 'loading' | 'question' | 'feedback' | 'results'
export default function QuizRunScreen({ lessonId }) {
  const [phase, setPhase] = useState('loading');
  useStudySession(lessonId, 'quiz');
  const [quiz, setQuiz] = useState(null); // { attempt, questions, notice }
  const [index, setIndex] = useState(0);
  const [feedback, setFeedback] = useState(null);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [startError, setStartError] = useState(null); // { message, final }: final when trying again can't help (409)
  const [slow, setSlow] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false); // set at once on a press, before `busy` renders, so a double press or tap sends one request
  const [notice, setNotice] = useState(null);
  const { clock, show, showAtPaint } = useAnswerClock(); // the open question's time_ms
  const startedAt = useRef(null); // when the first question became usable: the quiz's total time counts from here
  const [handout, setHandout] = useState(null); // the first question's clock token while the sheet is handed out
  const handoutRun = useRef(null);
  const sheetRef = useRef(null);
  const reduce = useReducedMotion();
  const alive = useRef(true);
  const started = useRef(false);
  const nextRef = useRef(null);
  const resultsRef = useRef(null);
  const focusAfter = useRef(null); // 'next' | 'results' (a new question focuses itself when it appears)
  const retakeOf = useRef(null); // what "Try again" retries after a failed start

  // The next question replaces the last one at once (nothing fades in or out), so it is usable from its first frame.
  const showQuestion = useCallback(
    (i) => {
      setIndex(i);
      setFeedback(null);
      setError(null);
      setPhase('question');
      showAtPaint();
    },
    [showAtPaint],
  );

  const firstUsable = useCallback(() => {
    if (startedAt.current === null) startedAt.current = performance.now();
  }, []);

  // Starts a quiz, or picks up an open one: the server returns an unfinished attempt under 2 hours old (a reload, or
  // coming back later) with where to carry on, and the time already spent on it.
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
        setFeedback(null);
        setResults(null);
        if (!next.resumed) {
          // a new quiz: the test sheet is handed out, and its first question counts once the sheet is in place
          startedAt.current = null;
          setIndex(0);
          setError(null);
          setPhase('question');
          setHandout(show());
        } else {
          startedAt.current = performance.now() - (next.elapsed_ms ?? 0);
          if (next.next_position === null) {
            // every question was answered but the quiz was never closed: close it
            const done = await api.finishQuiz(next.attempt.id, next.elapsed_ms ?? 0);
            if (!alive.current) return;
            setResults(done);
            setPhase('results');
            focusAfter.current = 'results';
          } else {
            showQuestion(next.next_position);
          }
        }
      } catch (err) {
        if (alive.current) setStartError({ message: err.message, final: err.status === 409 || err.status === 404 });
      } finally {
        clearTimeout(timer);
      }
    },
    [lessonId, show, showQuestion],
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

  // The hand-out: the sheet slides up into place (a fade with reduced motion). Its end, a tap on it, Enter / Space /
  // Escape, or choosing an answer makes the first question usable.
  useLayoutEffect(() => {
    if (handout === null || !sheetRef.current) return undefined;
    let live = true;
    const run = reduce ? animate(sheetRef.current, { opacity: [0, 1] }, HANDOUT_FADE) : animate(sheetRef.current, { opacity: [0, 1], y: [32, 0] }, HANDOUT);
    handoutRun.current = run;
    run.then(() => {
      if (!live) return;
      handoutRun.current = null;
      clock.usable(handout);
      firstUsable();
      setHandout(null);
    });
    return () => {
      live = false;
      run.stop();
    };
  }, [handout, reduce, clock, firstUsable]);
  const skipHandout = useCallback(() => handoutRun.current?.complete(), []);

  const question = quiz?.questions[index];
  const last = quiz ? index === quiz.questions.length - 1 : false;

  const answer = useCallback(
    async (choice) => {
      if (phase !== 'question' || pending.current || !question) return;
      pending.current = true;
      setBusy(true);
      setError(null);
      // a tap or key during the hand-out: the student is already using the question
      clock.input();
      firstUsable();
      skipHandout();
      const timeMs = clock.stop();
      try {
        const graded = await api.answerQuestion(quiz.attempt.id, { position: question.position, choice, timeMs });
        if (!alive.current) return;
        setFeedback(graded);
        setPhase('feedback');
        focusAfter.current = 'next';
      } catch (err) {
        clock.reopen(); // still on this question: its time carries on
        setError(`Your answer wasn’t saved. ${err.message} Choose an option to try again.`);
      } finally {
        pending.current = false;
        setBusy(false);
      }
    },
    [phase, question, quiz, clock, firstUsable, skipHandout],
  );

  const next = useCallback(async () => {
    if (phase !== 'feedback' || pending.current) return;
    if (!last) return showQuestion(index + 1);
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const done = await api.finishQuiz(quiz.attempt.id, elapsed(startedAt.current ?? performance.now(), performance.now()));
      if (!alive.current) return;
      setResults(done);
      setPhase('results');
      focusAfter.current = 'results';
    } catch (err) {
      setError(err.message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }, [phase, last, index, quiz, showQuestion]);

  useEffect(() => {
    const onKey = (event) => {
      const action = quizKeyAction(event, { phase, optionCount: question?.choices.length ?? 0 });
      if (action === null) {
        if (handoutRun.current && SKIP_KEYS.has(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          skipHandout();
        }
        return;
      }
      event.preventDefault();
      if (action === 'next') next();
      else answer(action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, question, next, answer, skipHandout]);

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

      {notice && phase !== 'results' && (
        <Notice tone={quiz?.resumed ? 'info' : 'warn'} onDismiss={() => setNotice(null)}>
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

      {(phase === 'question' || phase === 'feedback') && error && <Notice onDismiss={() => setError(null)}>{error}</Notice>}

      {/* the test sheet; a new question replaces the last at once */}
      {question && (phase === 'question' || phase === 'feedback') && (
        <div className="quiz-paper" ref={sheetRef} onPointerDown={handout !== null ? skipHandout : undefined} style={handout !== null ? { opacity: 0 } : undefined}>
          <AnswerSheet total={total} answered={index + (feedback ? 1 : 0)} index={index} />
          <QuizQuestion key={`${quiz.attempt.id}-${index}`} question={question} feedback={feedback} onAnswer={answer} busy={busy} />
        </div>
      )}

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
