// What admin's lesson row says about the lesson's flashcards, or null when there is nothing to say.
// `lesson.flashcards` is { total, status, error } from GET /api/lessons?counts=1. A ready lesson with no cards (made
// before flashcards existed, or a run that made none) gets "Make cards"; this used to be on the Flashcard tab, but admin
// keeps the PIN only on the admin screens, so it lives in admin's list.
//   state  making (queued/running) | failed | missing
export function flashcardsNotice(lesson) {
  const { total = 0, status = null, error = null } = lesson.flashcards ?? {};
  if (lesson.status !== 'ready') return null;
  if (status === 'queued' || status === 'running') return { state: 'making', title: 'Making the flashcards…', detail: null, action: null };
  if (total > 0) return null;
  if (status === 'failed') return { state: 'failed', title: 'Flashcards failed.', detail: error, action: 'Try again' };
  return { state: 'missing', title: 'No flashcards yet.', detail: 'Students see “Cards aren’t ready yet” until they are made.', action: 'Make cards' };
}
