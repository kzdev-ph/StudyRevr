// What admin's lesson row says about the quiz wrong answers (the last processing step), or null when there is nothing
// to say. `lesson.quiz_options` is { missing, weak, status, error } from GET /api/lessons?counts=1: `weak` counts
// cards whose saved wrong answers would give the right one away and a remake can still fix (not settled sets, not
// cards whose own question gives the answer). Students never see those options: the quiz asks the card as Yes/No or
// leaves it out until remade.
//   state  making (queued/running) | failed | missing (never made, e.g. a lesson from before the step, or weak)
export function quizOptionsNotice(lesson) {
  const { missing = 0, weak = 0, status = null, error = null } = lesson.quiz_options ?? {};
  if (lesson.status !== 'ready') return null;
  if (status === 'queued' || status === 'running') return { state: 'making', title: 'Making the quiz answers…', detail: null, action: null };
  if (!missing && !weak) return null;
  if (status === 'failed') return { state: 'failed', title: 'Quiz answers failed.', detail: error, action: 'Retry quiz answers' };
  if (!missing)
    return {
      state: 'missing',
      title: `${weak} quiz ${weak === 1 ? 'question is' : 'questions are'} skipped or changed to keep answers hidden.`,
      detail: 'Remaking their answer options may let them be multiple choice. Until then they are asked as Yes/No or left out.',
      action: 'Remake quiz answers',
    };
  return {
    state: 'missing',
    title: 'Quiz answers not made yet.',
    detail: 'The first quiz will make them, and that student waits.',
    action: 'Make quiz answers',
  };
}
