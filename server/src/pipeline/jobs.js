import { logLessonEvent } from '../services/student-upload.js';

// Job bookkeeping. One `jobs` row per lesson run: `stage` is where it is (or stopped), `status` is
// queued | running | done | failed. The lesson row mirrors the outcome (processing | ready | failed).

// `quiz_options` (the AI's wrong answers for the mock quiz) comes last. A lesson stays usable if it fails: only the
// job records the failure, and the quiz makes the options itself when first started.
export const STAGES = ['sections', 'key_points', 'key_terms', 'flashcards', 'quiz_options'];

// Steps admin runs on a ready lesson when wanted, never as part of processing: `section_versions` makes the shared
// Explain simpler and Filipino/Taglish versions of every section ahead of study day ("Prepare"). A job queued at one
// of these runs only that step, and the lesson stays ready whatever happens.
export const ON_DEMAND_STAGES = ['section_versions'];

// Marks the lesson as processing and (re)starts its job at `stage` (default: the first). Call inside the caller's
// transaction when creating a lesson; also used to retry a failed lesson. `keepLesson` leaves a ready lesson ready
// (making flashcards for an existing lesson must not hide its review while it runs).
export function queueJob(db, lessonId, { stage = STAGES[0], keepLesson = false } = {}) {
  if (!keepLesson) db.prepare(`UPDATE lessons SET status = 'processing', error = NULL, error_kind = NULL WHERE id = ?`).run(lessonId);
  const job = db.prepare('SELECT id FROM jobs WHERE lesson_id = ? ORDER BY id DESC LIMIT 1').get(lessonId);
  if (job) {
    db.prepare(
      `UPDATE jobs SET stage = ?, status = 'queued', error = NULL, progress_done = 0, progress_total = 0,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    ).run(stage, job.id);
    return job.id;
  }
  return Number(db.prepare(`INSERT INTO jobs (lesson_id, stage, status) VALUES (?, ?, 'queued')`).run(lessonId, stage).lastInsertRowid);
}

export function getJobStatus(db, lessonId) {
  const lesson = db.prepare('SELECT id, status, error FROM lessons WHERE id = ?').get(lessonId);
  if (!lesson) return null;
  const job = db
    .prepare('SELECT stage, status, error, progress_done, progress_total, updated_at FROM jobs WHERE lesson_id = ? ORDER BY id DESC LIMIT 1')
    .get(lessonId);
  return {
    lesson,
    job: job && {
      stage: job.stage,
      status: job.status,
      error: job.error,
      progress: { done: job.progress_done, total: job.progress_total },
      updated_at: job.updated_at,
    },
  };
}

// Jobs still queued/running when the server starts were cut off by a restart: nothing is working on them. A student's
// upload that was being prepared is logged as a failure (lesson_upload_failed, detail processing:interrupted), like any
// other way its processing can fail, so the researcher sees every upload that did not finish.
export function failInterruptedJobs(db, now = new Date()) {
  const message = 'Processing was interrupted by a server restart. Retry to continue.';
  return db.transaction(() => {
    const students = db
      .prepare("SELECT id, title, owner_participant_id FROM lessons WHERE status = 'processing' AND origin = 'student' AND owner_participant_id IS NOT NULL")
      .all();
    for (const l of students) {
      logLessonEvent(db, { participantId: l.owner_participant_id, type: 'lesson_upload_failed', lessonId: l.id, title: l.title, detail: 'processing:interrupted', now });
    }
    const lessons = db.prepare(`UPDATE lessons SET status = 'failed', error = ?, error_kind = 'other' WHERE status = 'processing'`).run(message).changes;
    db.prepare(
      `UPDATE jobs SET status = 'failed', error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE status IN ('queued', 'running')`,
    ).run(message);
    return lessons;
  })();
}
