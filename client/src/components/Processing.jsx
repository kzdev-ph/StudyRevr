import { useCallback, useEffect, useState } from 'react';
import { CheckIcon, RetryIcon } from './Icons.jsx';
import Notice from './Notice.jsx';
import { api } from '../lib/api.js';
import { STAGES } from '../lib/uploads.js';
import { paths } from '../lib/router.js';

const POLL_MS = 1500;

function stageState(id, status) {
  const { stage, status: jobStatus } = status.job ?? { stage: STAGES[0].id, status: 'queued' };
  if (status.lesson.status === 'ready' || stage === 'done') return 'done';
  const at = STAGES.findIndex((s) => s.id === stage);
  const me = STAGES.findIndex((s) => s.id === id);
  if (me < at) return 'done';
  if (me > at) return 'waiting';
  return jobStatus === 'failed' || status.lesson.status === 'failed' ? 'failed' : 'active';
}

// Polls the job until the lesson is ready, then calls onReady. A failed job stops polling and, for the student who
// uploaded it (`status.can_retry`), offers Try again. Admin has no PIN on this page (it is kept only on the admin
// screens), so admin retries a failed lesson from its row in the admin list.
export default function Processing({ lessonId, title, warning, onReady }) {
  const [status, setStatus] = useState(null);
  const [problem, setProblem] = useState(null);
  const [retrying, setRetrying] = useState(false);
  const [polling, setPolling] = useState(true);

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
        if (next.lesson.status === 'ready') return onReady();
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
  }, [lessonId, polling, onReady]);

  // Try again makes the lesson again from the failed step; finished steps are kept.
  const retry = useCallback(async () => {
    setRetrying(true);
    setProblem(null);
    try {
      setStatus(await api.retryLesson(lessonId));
      setPolling(true);
    } catch (err) {
      setProblem(err.message);
    } finally {
      setRetrying(false);
    }
  }, [lessonId]);

  const failed = status?.lesson.status === 'failed';
  const failure = status?.lesson.error || status?.job?.error || 'Something went wrong while preparing this lesson.';
  const progress = status?.job?.progress;

  return (
    <section className="stack processing">
      <a className="back" href={paths.library()}>
        All lessons
      </a>
      <div>
        <h1 className="screen-title">{failed ? 'We couldn’t finish this lesson' : 'Preparing your review'}</h1>
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

      {failed ? (
        <div className="stack stack--tight">
          <Notice action={null}>{failure}</Notice>
          {status.can_retry ? (
            <>
              <div className="processing__actions">
                <button type="button" className="btn btn--primary" onClick={retry} disabled={retrying}>
                  <RetryIcon size={18} /> {retrying ? 'Trying again…' : 'Try again'}
                </button>
              </div>
              <p className="muted">Steps that already finished are kept. Trying again doesn’t use up one of your uploads.</p>
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
