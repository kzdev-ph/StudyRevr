import { useState } from 'react';
import { ChevronRight, TrashIcon } from './Icons.jsx';
import { prettyTitle } from '../lib/format.js';
import { quizOptionsNotice } from '../lib/quizOptions.js';
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

// Admin only: the AI-made wrong answers for the mock quiz (the last step of processing). Failed, or never made for a
// lesson from before that step, it offers a button; the first quiz makes them itself in the meantime.
function QuizOptions({ lesson, onMake }) {
  const [asking, setAsking] = useState(false);
  const notice = quizOptionsNotice(lesson);
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
            <span className="spinner spinner--small" aria-hidden="true" /> Making the quiz answers…
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
// remove a lesson. `onMakeQuizOptions` (admin) enables the quiz-answers retry.
export default function LessonRow({ lesson, onDelete, onMakeQuizOptions }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
          Delete <strong>{prettyTitle(lesson.title)}</strong>? Its review, cards and quizzes go with it.
        </p>
        <div className="lesson__confirm-actions">
          <button type="button" className="btn btn--quiet" onClick={() => setConfirming(false)} disabled={deleting}>
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
        <button type="button" className="icon-btn" onClick={() => setConfirming(true)} aria-label={`Delete ${prettyTitle(lesson.title)}`}>
          <TrashIcon size={20} />
        </button>
      )}
      {onMakeQuizOptions && <QuizOptions lesson={lesson} onMake={onMakeQuizOptions} />}
    </li>
  );
}
