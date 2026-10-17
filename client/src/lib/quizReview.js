// What admin's lesson row says about the AI exam reviewer (the last processing step, services/quiz-review.js on the
// server), or null when there is nothing to say. `lesson.quiz_review` is { reviewed, flagged, pending, checks, status,
// error } from GET /api/lessons?counts=1: `flagged` cards have a question, an option or a Yes/No statement the reviewer
// found wrong after the one round of making them again; the quiz leaves those parts out. `checks` ({ reviewed, pending,
// dropped }, in quick checks; services/check-review.js) are the sections' quick checks, dropped when still flagged.
//   state  making (queued/running) | failed | missing (cards not reviewed yet) | done
export function quizReviewNotice(lesson) {
  const { reviewed = 0, flagged = 0, pending = 0, checks = {}, status = null, error = null } = lesson.quiz_review ?? {};
  const { reviewed: checksReviewed = 0, pending: checksPending = 0, dropped = 0 } = checks;
  if (lesson.status !== 'ready') return null;
  if (status === 'queued' || status === 'running') return { state: 'making', title: 'Checking the quiz questions…', detail: null, action: null };
  if (status === 'failed') return { state: 'failed', title: 'The quiz check failed.', detail: error, action: 'Review again' };
  if (pending)
    return {
      state: 'missing',
      title: `${pending} quiz ${pending === 1 ? 'question isn’t' : 'questions aren’t'} checked by the AI reviewer yet.`,
      detail: 'Until then they are asked as the word checks allow.',
      action: 'Review quiz',
    };
  if (checksPending)
    return {
      state: 'missing',
      title: `${checksPending} quick ${checksPending === 1 ? 'check isn’t' : 'checks aren’t'} checked by the AI reviewer yet.`,
      detail: 'Until then they are shown under their sections as made.',
      action: 'Review quiz',
    };
  if (!reviewed && !checksReviewed && !dropped) return null;
  const cards = !reviewed ? null : flagged ? `${flagged} of ${reviewed} cards flagged` : `all ${reviewed} cards passed`;
  const quick = dropped ? `${dropped} quick ${dropped === 1 ? 'check' : 'checks'} dropped` : null;
  const parts = [cards, quick].filter(Boolean).join('; ');
  const detail = [flagged && 'The flagged questions or answer options are left out of the quiz.', dropped && 'Dropped quick checks said something the lesson doesn’t, and weren’t fixed.'].filter(Boolean).join(' ');
  return {
    state: 'done',
    title: parts ? `AI review: ${parts}.` : 'AI review: all quick checks passed.',
    detail: detail || null,
    action: 'Review again',
  };
}
