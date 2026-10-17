import { useEffect, useRef, useState } from 'react';
import { ChevronRight, TrashIcon } from './Icons.jsx';
import LeakyCards from './LeakyCards.jsx';
import { prettyTitle } from '../lib/format.js';
import { flashcardsNotice } from '../lib/flashcardsNotice.js';
import { quizOptionsNotice } from '../lib/quizOptions.js';
import { quizReviewNotice } from '../lib/quizReview.js';
import { sectionVersionsNotice } from '../lib/sectionVersions.js';
import { paths } from '../lib/router.js';
import { adminLessonNote, ownLessonNote, processingLine, rowActions } from '../lib/uploads.js';

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
// remove a lesson. `onMakeQuizOptions` (admin) enables the quiz-answers retry, `onReviewQuiz` (admin) the AI quiz review
// line with "Review again", `onPrepareVersions` (admin) the
// "Prepare simpler and Taglish" step, `onCardsChanged` (admin) the list of cards that give their answer away,
// `onShare` (admin) "Share with everyone" for a student's private upload.
// A student's own upload (`lesson.mine`) shows who can see it and where its preparation is; `onDeleteOwn` (only while
// the server says `can_delete`: before it is shared or studied) and `onRetry` (a failed upload) are theirs.
export default function LessonRow({ lesson, admin = false, onDelete, onDeleteOwn, onRetry, onShare, onMakeFlashcards, onMakeQuizOptions, onReviewQuiz, onPrepareVersions, onCardsChanged }) {
  const [confirming, setConfirming] = useState(null); // 'delete' | 'share'
  const [working, setWorking] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const trash = useRef(null);
  const share = useRef(null);
  const keep = useRef(null);
  const was = useRef(null);

  // The button that was pressed is replaced, so focus follows: to "Keep it" (the safe choice), and back to the button.
  useEffect(() => {
    if (confirming) keep.current?.focus();
    else if (was.current) (was.current === 'share' ? share : trash).current?.focus();
    was.current = confirming;
  }, [confirming]);

  const actions = rowActions(lesson);
  const canDeleteOwn = Boolean(onDeleteOwn) && actions.delete;
  const canShare = Boolean(onShare) && lesson.origin === 'student' && !lesson.shared && lesson.status === 'ready';
  const note = admin ? adminLessonNote(lesson) : ownLessonNote(lesson);
  const stage = lesson.mine ? processingLine(lesson) : null;
  const failedMine = lesson.mine && lesson.status === 'failed';
  // admin's list is where a failed lesson is retried (the reader has no PIN); a student retries their own upload
  const failedAdmin = admin && lesson.status === 'failed' && Boolean(onRetry);
  const canDelete = Boolean(onDelete) || canDeleteOwn;

  // The confirm closes if its delete option goes away (the lesson was shared or studied meanwhile)
  useEffect(() => {
    if (confirming === 'delete' && !canDelete) setConfirming(null);
  }, [confirming, canDelete]);

  const finish = async (action) => {
    setWorking(true);
    await action(lesson.id);
    setWorking(false);
    setConfirming(null);
  };
  const tryAgain = async () => {
    setRetrying(true);
    await onRetry(lesson.id);
    setRetrying(false);
  };

  if (confirming && !(confirming === 'delete' && !canDelete)) {
    const title = prettyTitle(lesson.title);
    // a student's confirm is ink, never red; the red button is admin's alone
    const sharing = confirming === 'share';
    return (
      <li className={`lesson lesson--confirm${sharing || canDeleteOwn ? ' lesson--confirm-own' : ''}`}>
        <p className="lesson__ask">
          {sharing ? (
            <>
              Share <strong>{title}</strong> with every student? They will all see it in their library. This can’t be undone.
            </>
          ) : canDeleteOwn ? (
            <>
              Delete <strong>{title}</strong>? Its review, cards and quizzes go with it. You can delete it until you start studying it.
            </>
          ) : (
            <>
              Delete <strong>{title}</strong>? Its review, cards and quizzes go with it. This can’t be undone.
            </>
          )}
        </p>
        <div className="lesson__confirm-actions">
          <button type="button" className="btn btn--quiet" ref={keep} onClick={() => setConfirming(null)} disabled={working}>
            Keep it
          </button>
          {sharing ? (
            <button type="button" className="btn btn--primary" onClick={() => finish(onShare)} disabled={working}>
              {working ? 'Sharing…' : 'Share lesson'}
            </button>
          ) : (
            <button type="button" className={onDelete ? 'btn btn--danger' : 'btn btn--primary'} onClick={() => finish(onDelete ?? onDeleteOwn)} disabled={working}>
              {working ? 'Deleting…' : 'Delete lesson'}
            </button>
          )}
        </div>
      </li>
    );
  }

  return (
    <li className="lesson">
      <a className="lesson__link" href={admin ? paths.adminLesson(lesson.id) : paths.lesson(lesson.id)}>
        <span className="lesson__main">
          <span className="lesson__title">{prettyTitle(lesson.title)}</span>
          <span className="lesson__meta">
            {formatWords(lesson.word_count)}, added {formatDate(lesson.created_at)}
            {note ? ` · ${note}` : ''}
          </span>
          {stage && <span className="lesson__meta" aria-live="polite">{stage}</span>}
        </span>
        <Status lesson={lesson} />
        <ChevronRight size={20} className="lesson__chevron" />
      </a>
      {(onDelete || canDeleteOwn) && (
        <button type="button" className="icon-btn" ref={trash} onClick={() => setConfirming('delete')} aria-label={`Delete ${prettyTitle(lesson.title)}`}>
          <TrashIcon size={20} />
        </button>
      )}
      {(failedMine || failedAdmin) && (
        <div className="lesson__extra lesson__extra--note" aria-live="polite">
          <p className="lesson__extra-text">{lesson.error ?? 'Something went wrong while preparing this lesson.'}</p>
          {(failedAdmin || actions.retry) && onRetry && (
            <button type="button" className="btn btn--primary" onClick={tryAgain} disabled={retrying}>
              {retrying ? 'Trying again…' : failedAdmin ? 'Retry' : 'Try again'}
            </button>
          )}
        </div>
      )}
      {canShare && (
        <div className="lesson__extra">
          <button type="button" className="btn btn--quiet" ref={share} onClick={() => setConfirming('share')}>
            Share with everyone
          </button>
        </div>
      )}
      {onMakeFlashcards && <LessonStep lesson={lesson} notice={flashcardsNotice(lesson)} busyText="Making the flashcards…" onMake={onMakeFlashcards} />}
      {onCardsChanged && <LeakyCards lesson={lesson} onChanged={onCardsChanged} />}
      {onMakeQuizOptions && <LessonStep lesson={lesson} notice={quizOptionsNotice(lesson)} busyText="Making the quiz answers…" onMake={onMakeQuizOptions} />}
      {onReviewQuiz && <LessonStep lesson={lesson} notice={quizReviewNotice(lesson)} busyText="Checking the quiz questions…" onMake={onReviewQuiz} />}
      {onPrepareVersions && (
        <LessonStep lesson={lesson} notice={sectionVersionsNotice(lesson)} busyText="Preparing simpler and Taglish versions…" onMake={onPrepareVersions} />
      )}
    </li>
  );
}
