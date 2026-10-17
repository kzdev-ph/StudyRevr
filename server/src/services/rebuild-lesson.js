import { hasRecords, participantRecords } from './lesson-records.js';

// Making a lesson again from its stored text, keeping the lesson itself (same id, title, file name, origin, owner,
// sharing and source numbers, so lesson_events and the exports still point at it). For a lesson whose generated
// content was made by an older version of the prompts and checks. `npm run lesson:rebuild -- <id>` is the only caller.

export class RebuildRefused extends Error {}

// The lesson, or a RebuildRefused saying why it can't be made again: it doesn't exist, it is being processed, or a
// participant other than P00 (the researcher's test data) has recorded something on it, which a rebuild would cut off
// from the cards and questions it was made on.
export function checkRebuild(db, id) {
  const lesson = db.prepare('SELECT id, title, status, origin FROM lessons WHERE id = ?').get(id);
  if (!lesson) throw new RebuildRefused(`There is no lesson ${id}.`);
  if (lesson.status === 'processing' || db.prepare("SELECT 1 FROM jobs WHERE lesson_id = ? AND status IN ('queued', 'running')").get(id)) {
    throw new RebuildRefused(`Lesson ${id} is being processed. Wait for it to finish (or stop the server and retry it) first.`);
  }
  const records = participantRecords(db, id);
  const progress = db.prepare("SELECT COUNT(*) AS n FROM review_progress r JOIN participants p ON p.id = r.participant_id WHERE r.lesson_id = ? AND p.code <> 'P00'").get(id).n;
  if (hasRecords(records) || progress) {
    const found = Object.entries({ ...records, review_progress: progress })
      .filter(([, n]) => n > 0)
      .map(([what, n]) => `${n} ${what.replace(/_/g, ' ')}`)
      .join(', ');
    throw new RebuildRefused(`Lesson ${id} can't be made again: participants other than P00 have recorded ${found} on it. Their answers would lose the cards and questions they were made on.`);
  }
  return lesson;
}

// What the person must type to go on: the lesson's id.
export const confirmed = (typed, id) => String(typed ?? '').trim() === String(id);

// Removes everything generated for the lesson (and P00's test records on it) and marks it for processing again, in one
// transaction. Cards cascade to their progress, answers, wrong options and AI reviews; attempts to their answers.
export function resetLesson(db, id) {
  checkRebuild(db, id);
  return db.transaction(() => {
    const own = "participant_id IN (SELECT id FROM participants WHERE code = 'P00')";
    db.prepare(`DELETE FROM study_sessions WHERE lesson_id = ? AND ${own}`).run(id);
    db.prepare(`DELETE FROM events WHERE lesson_id = ? AND ${own}`).run(id);
    for (const table of ['quiz_attempts', 'quiz_questions', 'review_progress', 'flashcards', 'key_terms', 'key_points', 'sections', 'jobs']) {
      db.prepare(`DELETE FROM ${table} WHERE lesson_id = ?`).run(id);
    }
    db.prepare(
      "UPDATE lessons SET status = 'processing', error = NULL, error_kind = NULL, thinking_level = NULL, processed_thinking = NULL, term_families = NULL, made_by = 'gemini' WHERE id = ?",
    ).run(id);
  })();
}
