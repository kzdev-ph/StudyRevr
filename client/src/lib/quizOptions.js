// What admin's lesson row says about the quiz wrong answers (the last processing step), or null when there is nothing
// to say. `lesson.quiz_options` is { missing, status, error } from GET /api/lessons.
//   state  making (queued/running) | failed | missing (never made, e.g. a lesson from before the step)
export function quizOptionsNotice(lesson) {
  const { missing = 0, status = null, error = null } = lesson.quiz_options ?? {};
  if (lesson.status !== 'ready') return null;
  if (status === 'queued' || status === 'running') return { state: 'making', title: 'Making the quiz answers…', detail: null, action: null };
  if (!missing) return null;
  if (status === 'failed') return { state: 'failed', title: 'Quiz answers failed.', detail: error, action: 'Retry quiz answers' };
  return {
    state: 'missing',
    title: 'Quiz answers not made yet.',
    detail: 'The first quiz will make them, and that student waits.',
    action: 'Make quiz answers',
  };
}
