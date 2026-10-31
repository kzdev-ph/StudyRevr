// What admin's lesson row says about the lesson's flashcards, or null when there is nothing to say.
// `lesson.flashcards` is { total, status, error } from GET /api/lessons?counts=1. A ready lesson with no cards (made
// before flashcards existed, or a run that made none) gets "Make cards"; this used to be on the Flashcard tab, but admin
// keeps the PIN only on the admin screens, so it lives in admin's list.
// `quiz_length` (how many questions a mock quiz asks, 10) comes from the same object.
//   state  making (queued/running) | failed | few (fewer cards than a full quiz) | empty (none, damaged text) | missing
export function flashcardsNotice(lesson) {
  const { total = 0, status = null, error = null, quiz_length: quizLength = 10 } = lesson.flashcards ?? {};
  if (lesson.status !== 'ready') return null;
  if (status === 'queued' || status === 'running') return { state: 'making', title: 'Making the flashcards…', detail: null, action: null };
  if (total > 0) {
    if (total >= quizLength) return null;
    return {
      state: 'few',
      title: `Only ${total} ${total === 1 ? 'flashcard' : 'flashcards'}.`,
      detail: total === 1 ? 'The mock quiz needs at least 2.' : `The mock quiz can ask at most ${total} of ${quizLength} questions.`,
      action: null,
    };
  }
  if (status === 'failed') return { state: 'failed', title: 'Flashcards failed.', detail: error, action: 'Try again' };
  if (lesson.text_warning?.code === 'damaged_text') {
    return {
      state: 'empty',
      title: 'No flashcards could be made.',
      detail: 'This file’s text looks damaged, which can stop cards from being made. Students see “Cards aren’t ready yet”.',
      action: 'Make cards',
    };
  }
  return { state: 'missing', title: 'No flashcards yet.', detail: 'Students see “Cards aren’t ready yet” until they are made.', action: 'Make cards' };
}
