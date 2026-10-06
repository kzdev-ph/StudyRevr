import { mapLimit } from '../ai/pool.js';
import { makeVersion, saveSharedVersion } from './section-versions.js';

// Admin's "Prepare simpler and Taglish versions": makes the shared Explain simpler and Filipino/Taglish version of
// every section that has none yet, with the admin Default, ahead of study day, so students' taps are served from the
// cache with no live AI call. Uses the pipeline's AI client (its request limit, retries and concurrency). Each version
// is saved as soon as it is made, so a retry only makes the ones still missing.

// The versions still missing for a lesson: [{ section, kind }] in section order, simpler before Taglish.
export function missingVersions(db, lessonId) {
  const sections = db
    .prepare('SELECT id, lesson_id, title, content, simple_version, filipino_version, check_questions FROM sections WHERE lesson_id = ? ORDER BY position, id')
    .all(lessonId);
  const todo = [];
  for (const s of sections) {
    const section = { ...s, check_questions: JSON.parse(s.check_questions) };
    if (!s.simple_version) todo.push({ section, kind: 'simplify' });
    if (!s.filipino_version) todo.push({ section, kind: 'translate' });
  }
  return todo;
}

// { missing, total } versions for every lesson that has sections (2 per section).
export function versionCounts(db) {
  return new Map(
    db
      .prepare(
        `SELECT lesson_id, COUNT(*) * 2 AS total,
           SUM(simple_version IS NULL) + SUM(filipino_version IS NULL) AS missing
         FROM sections GROUP BY lesson_id`,
      )
      .all()
      .map((r) => [r.lesson_id, { missing: r.missing, total: r.total }]),
  );
}

// -> { made, failed, error: the first failure's message or null }
export async function prepareVersions({ db, ai, lessonId, config, concurrency = 1, onProgress, log = console }) {
  const todo = missingVersions(db, lessonId);
  let done = 0;
  let made = 0;
  let failed = 0;
  let error = null;
  onProgress?.({ done, total: todo.length });
  await mapLimit(todo, concurrency, async ({ section, kind }) => {
    try {
      const version = await makeVersion({ db, ai, section, kind });
      if (saveSharedVersion(db, section.id, kind, version, config)) made += 1;
    } catch (err) {
      failed += 1;
      error ??= err.message;
      log.warn?.(`[prepare] lesson ${lessonId}: ${kind} of section ${section.id} failed: ${err.message}`);
    }
    onProgress?.({ done: ++done, total: todo.length });
  });
  return { made, failed, error };
}
