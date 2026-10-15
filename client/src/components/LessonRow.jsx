import { useEffect, useRef, useState } from 'react';
import { ChevronRight, TrashIcon } from './Icons.jsx';
import LeakyCards from './LeakyCards.jsx';
import { prettyTitle } from '../lib/format.js';
import { quizOptionsNotice } from '../lib/quizOptions.js';
import { sectionVersionsNotice } from '../lib/sectionVersions.js';
import { paths } from '../lib/router.js';

const formatDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const formatWords = (n) => `${n.toLocaleString()} ${n === 1 ? 'word' : 'words'}`;

function Status({ lesson }) {
  if (lesson.status === 'processing') {
    return (
      <span className="chip chip--busy">
        <span className="spinner spinner--small" aria-hidden="true" /> Preparing
      </span>
    );
  }
  if (lesson.status === 'failed') return <span className="chip chip--failed">Needs retry</span>;
  return null;
}

// Admin only: a step admin can run on a ready lesson, with its state and button. `notice` is from quizOptionsNotice
// (the AI-made wrong answers for the mock quiz: failed, or never made for a lesson from before that step; the first
// quiz makes them itself in the meantime) or sectionVersionsNotice (the shared simpler / Taglish versions, "Prepare").
function LessonStep({ lesson, notice, busyText, onMake }) {
  const [asking, setAsking] = useState(false);
  const busy = asking || notice?.state === 'making';
  if (!notice && !asking) return null;

  const make = async () => {
    setAsking(true);
    await onMake(lesson.id);
    setAsking(false);
  };
  const failed = notice?.state === 'failed' && !busy;
  return (
    <div className={failed ? 'lesson__extra lesson__extra--failed' : 'lesson__extra'} aria-live="polite">
      <p className="lesson__extra-text">
        {busy ? (
          <>
            <span className="spinner spinner--small" aria-hidden="true" /> {notice?.state === 'making' ? notice.title : busyText}
            {notice?.detail && notice.state === 'making' ? ` ${notice.detail}` : ''}
          </>
        ) : (
          <span>
            <strong>{notice.title}</strong> {notice.detail}
          </span>
        )}
      </p>
      {!busy && notice.action && (
        <button type="button" className={failed ? 'btn btn--primary' : 'btn btn--quiet'} onClick={make}>
          {notice.action}
        </button>
      )}
    </div>
  );
}

// One lesson on the ruled list. With `onDelete` (admin), Delete asks first, in place, so a slip of the thumb can't
// remove a lesson. `onMakeQuizOptions` (admin) enables the quiz-answers retry, `onPrepareVersions` (admin) the
// "Prepare simpler and Taglish" step, `onCardsChanged` (admin) the list of cards that give their answer away.
export default function LessonRow({ lesson, onDelete, onMakeQuizOptions, onPrepareVersions, onCardsChanged }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const trash = useRef(null);
  const keep = useRef(null);
  const wasConfirming = useRef(false);

  // The button that was pressed is replaced, so focus follows: to "Keep it" (the safe choice), and back to Delete.
  useEffect(() => {
    if (confirming) keep.current?.focus();
    else if (wasConfirming.current) trash.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  const remove = async () => {
    setDeleting(true);
    await onDelete(lesson.id);
    setDeleting(false);
    setConfirming(false);
  };

  if (confirming) {
    return (
      <li className="lesson lesson--confirm">
        <p className="lesson__ask">
          Delete <strong>{prettyTitle(lesson.title)}</strong>? Its review, cards and quizzes go with it. This can’t be undone.
        </p>
        <div className="lesson__confirm-actions">
          <button type="button" className="btn btn--quiet" ref={keep} onClick={() => setConfirming(false)} disabled={deleting}>
            Keep it
          </button>
          <button type="button" className="btn btn--danger" onClick={remove} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete lesson'}
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="lesson">
      <a className="lesson__link" href={paths.lesson(lesson.id)}>
        <span className="lesson__main">
          <span className="lesson__title">{prettyTitle(lesson.title)}</span>
          <span className="lesson__meta">
            {formatWords(lesson.word_count)}, added {formatDate(lesson.created_at)}
          </span>
        </span>
        <Status lesson={lesson} />
        <ChevronRight size={20} className="lesson__chevron" />
      </a>
      {onDelete && (
        <button type="button" className="icon-btn" ref={trash} onClick={() => setConfirming(true)} aria-label={`Delete ${prettyTitle(lesson.title)}`}>
          <TrashIcon size={20} />
        </button>
      )}
      {onCardsChanged && <LeakyCards lesson={lesson} onChanged={onCardsChanged} />}
      {onMakeQuizOptions && <LessonStep lesson={lesson} notice={quizOptionsNotice(lesson)} busyText="Making the quiz answers…" onMake={onMakeQuizOptions} />}
      {onPrepareVersions && (
        <LessonStep lesson={lesson} notice={sectionVersionsNotice(lesson)} busyText="Preparing simpler and Taglish versions…" onMake={onPrepareVersions} />
      )}
    </li>
  );
}
