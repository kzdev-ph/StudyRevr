// What admin's lesson row says about the shared Explain simpler / Filipino-Taglish versions ("Prepare"), or null when
// there is nothing to say. `lesson.section_versions` is { missing, total, status, error, progress } from GET /api/lessons
// (two versions per section).
//   state  making (queued/running) | failed | missing (some not made yet) | ready (all made)
export function sectionVersionsNotice(lesson) {
  const { missing = 0, total = 0, status = null, error = null, progress = null } = lesson.section_versions ?? {};
  if (lesson.status !== 'ready' || !total) return null;
  const made = total - missing;
  if (status === 'queued' || status === 'running') {
    const counted = progress?.total ? ` ${progress.done} of ${progress.total} made.` : '';
    return { state: 'making', title: 'Preparing simpler and Taglish versions…', detail: counted.trim() || null, action: null };
  }
  if (!missing) return { state: 'ready', title: 'Simpler and Taglish versions ready.', detail: `All ${total} are saved; taps need no live AI.`, action: null };
  if (status === 'failed') return { state: 'failed', title: `Simpler and Taglish: ${made} of ${total} ready.`, detail: error, action: 'Prepare the rest' };
  return {
    state: 'missing',
    title: `Simpler and Taglish: ${made} of ${total} ready.`,
    detail: 'Prepare them now so study day needs no live AI calls.',
    action: 'Prepare simpler and Taglish',
  };
}
