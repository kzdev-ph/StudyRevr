import { useCallback, useEffect, useState } from 'react';
import { CheckIcon, RetryIcon } from './Icons.jsx';
import Notice from './Notice.jsx';
import { useAdminPin } from '../lib/admin.js';
import { api } from '../lib/api.js';
import { STAGES } from '../lib/uploads.js';
import { paths } from '../lib/router.js';

const POLL_MS = 1500;

// The lesson is readable once its cards exist, so a quiz-answers step that failed (or is being retried) leaves it ready
// with only the job unfinished. Admin stays on this page for that; students are sent on to the lesson.
const quizStepOpen = (status) => status.lesson.status === 'ready' && status.job?.stage === 'quiz_options' && status.job.status !== 'done';

function stageState(id, status) {
  const { stage, status: jobStatus } = status.job ?? { stage: STAGES[0].id, status: 'queued' };
  if (quizStepOpen(status)) return id !== 'quiz_options' ? 'done' : jobStatus === 'failed' ? 'failed' : 'active';
  if (status.lesson.status === 'ready' || stage === 'done') return 'done';
  const at = STAGES.findIndex((s) => s.id === stage);
  const me = STAGES.findIndex((s) => s.id === id);
  if (me < at) return 'done';
  if (me > at) return 'waiting';
  return jobStatus === 'failed' || status.lesson.status === 'failed' ? 'failed' : 'active';
}

// Polls the job until the lesson is ready, then calls onReady. A failed job stops polling and offers Retry.
export default function Processing({ lessonId, title, warning, onReady }) {
  const [status, setStatus] = useState(null);
  const [problem, setProblem] = useState(null);
  const [retrying, setRetrying] = useState(false);
  const [polling, setPolling] = useState(true);
  const admin = Boolean(useAdminPin()); // the researcher can retry any lesson; a student only their own failed upload (status.can_retry)

  useEffect(() => {
    if (!polling) return undefined;
    let cancelled = false;
    let timer;
    const controller = new AbortController();
    const tick = async () => {
      try {
        const next = await api.getStatus(lessonId, controller.signal);
        if (cancelled) return;
        setStatus(next);
        setProblem(null);
        if (next.lesson.status === 'ready' && !(admin && quizStepOpen(next))) return onReady();
        if (quizStepOpen(next) && next.job.status === 'failed') return setPolling(false);
        if (next.lesson.status === 'failed') return setPolling(false);
      } catch (err) {
        if (cancelled || err.name === 'AbortError') return;
        setProblem(err.message); // keep trying: the server may just be restarting
      }
      timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [lessonId, polling, onReady, admin]);

  // Retry makes the whole lesson again from the failed step; for a lesson that is already ready it makes just the quiz answers.
  const retry = useCallback(async () => {
    setRetrying(true);
    setProblem(null);
    try {
      setStatus(await (status && quizStepOpen(status) ? api.makeQuizOptions(lessonId) : api.retryLesson(lessonId)));
      setPolling(true);
    } catch (err) {
      setProblem(err.message);
    } finally {
      setRetrying(false);
    }
  }, [lessonId, status]);

  const failed = status?.lesson.status === 'failed';
  const quizFailed = Boolean(status && quizStepOpen(status) && status.job.status === 'failed');
  const failure = (quizFailed && status.job.error) || status?.lesson.error || status?.job?.error || 'Something went wrong while preparing this lesson.';
  const progress = status?.job?.progress;

  return (
    <section className="stack processing">
      <a className="back" href={paths.library()}>
        All lessons
      </a>
      <div>
        <h1 className="screen-title">
          {failed ? 'We couldn’t finish this lesson' : quizFailed ? 'The lesson is ready, but its quiz answers aren’t' : 'Preparing your review'}
        </h1>
        <p className="muted processing__title">{title}</p>
      </div>

      {warning && <Notice tone="warn">{warning}</Notice>}
      {problem && <Notice>{problem}</Notice>}

      <ol className="steps" aria-label="Progress">
        {STAGES.map((stage) => {
          const state = status ? stageState(stage.id, status) : stage.id === STAGES[0].id ? 'active' : 'waiting';
          const count = state === 'active' && progress?.total > 1 ? `Part ${Math.min(progress.done + 1, progress.total)} of ${progress.total}` : null;
          return (
            <li key={stage.id} className={`step step--${state}`} aria-current={state === 'active' ? 'step' : undefined}>
              <span className="step__mark" aria-hidden="true">
                {state === 'done' && <CheckIcon size={16} />}
                {state === 'active' && <span className="spinner spinner--small" />}
                {state === 'failed' && '!'}
              </span>
              <span className="step__text">
                <span className="step__label">{state === 'done' ? stage.done : stage.doing}</span>
                {count && <span className="step__count">{count}</span>}
              </span>
            </li>
          );
        })}
      </ol>

      {failed || quizFailed ? (
        <div className="stack stack--tight">
          <Notice action={null}>{failure}</Notice>
          {admin || status.can_retry ? (
            <>
              <div className="processing__actions">
                <button type="button" className="btn btn--primary" onClick={retry} disabled={retrying}>
                  <RetryIcon size={18} /> {retrying ? 'Trying again…' : admin ? 'Retry' : 'Try again'}
                </button>
                {admin && quizFailed && (
                  <button type="button" className="btn btn--quiet" onClick={onReady}>
                    Open the lesson
                  </button>
                )}
              </div>
              <p className="muted">
                {!admin
                  ? 'Steps that already finished are kept. Trying again doesn’t use up one of your uploads.'
                  : quizFailed
                  ? 'Students can already use the lesson. Until the quiz answers are made, their first quiz makes them itself, so it starts slowly. Batches that already worked are kept.'
                  : 'Steps that already finished are kept, so a retry picks up where it stopped.'}
              </p>
            </>
          ) : (
            <p className="muted">Your teacher can retry it from admin.</p>
          )}
        </div>
      ) : (
        <p className="muted" aria-live="polite">
          This usually takes under a minute. You can leave this page; the lesson keeps preparing.
        </p>
      )}
    </section>
  );
}
