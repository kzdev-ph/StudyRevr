import { useState } from 'react';
import { ChevronRight, TrashIcon } from './Icons.jsx';
import { prettyTitle } from '../lib/format.js';
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
  if (lesson.status === 'failed') return <span className="chip chip--failed">Didn’t finish</span>;
  return null;
}

// One lesson on the ruled list. Delete asks first, in place, so a slip of the thumb can't remove a lesson.
export default function LessonRow({ lesson, onDelete }) {
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
          Delete <strong>{prettyTitle(lesson.title)}</strong>? Its review and your progress go with it.
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
      <button type="button" className="icon-btn" onClick={() => setConfirming(true)} aria-label={`Delete ${prettyTitle(lesson.title)}`}>
        <TrashIcon size={20} />
      </button>
    </li>
  );
}
