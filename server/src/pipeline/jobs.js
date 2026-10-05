// Job bookkeeping. One `jobs` row per lesson run: `stage` is where it is (or stopped), `status` is
// queued | running | done | failed. The lesson row mirrors the outcome (processing | ready | failed).

export const STAGES = ['sections', 'key_points', 'key_terms'];

// Marks the lesson as processing and (re)starts its job at the first stage. Call inside the caller's transaction
// when creating a lesson; also used to retry a failed lesson.
export function queueJob(db, lessonId) {
  db.prepare(`UPDATE lessons SET status = 'processing', error = NULL, error_hint = NULL WHERE id = ?`).run(lessonId);
  const job = db.prepare('SELECT id FROM jobs WHERE lesson_id = ? ORDER BY id DESC LIMIT 1').get(lessonId);
  if (job) {
    db.prepare(
      `UPDATE jobs SET stage = ?, status = 'queued', error = NULL, error_hint = NULL, progress_done = 0, progress_total = 0,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    ).run(STAGES[0], job.id);
    return job.id;
  }
  return Number(db.prepare(`INSERT INTO jobs (lesson_id, stage, status) VALUES (?, ?, 'queued')`).run(lessonId, STAGES[0]).lastInsertRowid);
}

export function getJobStatus(db, lessonId) {
  const lesson = db.prepare('SELECT id, status, error, error_hint FROM lessons WHERE id = ?').get(lessonId);
  if (!lesson) return null;
  const job = db
    .prepare('SELECT stage, status, error, error_hint, progress_done, progress_total, updated_at FROM jobs WHERE lesson_id = ? ORDER BY id DESC LIMIT 1')
    .get(lessonId);
  return {
    lesson,
    job: job && {
      stage: job.stage,
      status: job.status,
      error: job.error,
      error_hint: job.error_hint,
      progress: { done: job.progress_done, total: job.progress_total },
      updated_at: job.updated_at,
    },
  };
}

// Jobs still queued/running when the server starts were cut off by a restart: nothing is working on them.
export function failInterruptedJobs(db) {
  const message = 'Processing was interrupted by a server restart. Retry to continue.';
  return db.transaction(() => {
    const lessons = db.prepare(`UPDATE lessons SET status = 'failed', error = ? WHERE status = 'processing'`).run(message).changes;
    db.prepare(
      `UPDATE jobs SET status = 'failed', error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE status IN ('queued', 'running')`,
    ).run(message);
    return lessons;
  })();
}
