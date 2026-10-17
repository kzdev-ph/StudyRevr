// What admin's lesson row says about the AI exam reviewer (the last processing step, services/quiz-review.js on the
// server), or null when there is nothing to say. `lesson.quiz_review` is { reviewed, flagged, pending, status, error }
// from GET /api/lessons?counts=1: `flagged` cards have a question, an option or a Yes/No statement the reviewer found
// wrong after the one round of making them again; the quiz leaves those parts out.
//   state  making (queued/running) | failed | missing (cards not reviewed yet) | done
export function quizReviewNotice(lesson) {
  const { reviewed = 0, flagged = 0, pending = 0, status = null, error = null } = lesson.quiz_review ?? {};
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
  if (!reviewed) return null;
  return {
    state: 'done',
    title: flagged ? `AI review: ${flagged} of ${reviewed} cards flagged.` : `AI review: all ${reviewed} cards passed.`,
    detail: flagged ? 'The flagged questions or answer options are left out of the quiz.' : null,
    action: 'Review again',
  };
}
