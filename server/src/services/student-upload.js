import { HttpError } from '../middleware/errors.js';
import { loadSchedulerConfig } from '../flashcards/config.js';
import { studyDate } from '../stats/days.js';
import { studentUploadsAllowed, uploadsPerDay } from './settings.js';

// Student uploads (Phase 7B): the limits around the upload route and the lesson_events log. The checks run before the
// file is read, so a refused upload costs the server nothing.

export const BURST_MAX = 6; // upload requests per participant ...
export const BURST_WINDOW_MS = 10 * 60_000; // ... per 10 minutes, on top of the daily quota
export const QUEUE_LIMIT = 5; // student lessons waiting or being processed at once; more are refused for now

export const LESSON_EVENT_TYPES = ['lesson_uploaded', 'lesson_upload_failed', 'lesson_deleted_by_student', 'lesson_shared'];

export function logLessonEvent(db, { participantId, type, lessonId = null, title = null, actor = 'student', detail = null, now }) {
  return Number(
    db
      .prepare(
        `INSERT INTO lesson_events (participant_id, type, lesson_id, lesson_title, actor, detail, created_at, study_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(participantId, type, lessonId, title, actor, detail, now.toISOString(), studyDate(now, loadSchedulerConfig(db))).lastInsertRowid,
  );
}

// Uploads this participant made today. Counted from lesson_uploaded events (not from lesson rows), so deleting a
// lesson doesn't give the upload back.
export const uploadsUsedToday = (db, participantId, now) =>
  db
    .prepare("SELECT COUNT(*) AS n FROM lesson_events WHERE participant_id = ? AND type = 'lesson_uploaded' AND study_date = ?")
    .get(participantId, studyDate(now, loadSchedulerConfig(db))).n;

// What the library shows a student: { allowed, per_day, used_today, left_today, max_mb }
export function uploadStatus(db, participant, now, maxUploadBytes) {
  const perDay = uploadsPerDay(db);
  const used = uploadsUsedToday(db, participant.id, now);
  return { allowed: studentUploadsAllowed(db), per_day: perDay, used_today: used, left_today: Math.max(0, perDay - used), max_mb: Math.round(maxUploadBytes / 1024 / 1024) };
}

// Student lessons still being prepared (queued or running)
export const studentJobsWaiting = (db) => db.prepare("SELECT COUNT(*) AS n FROM lessons WHERE origin = 'student' AND status = 'processing'").get().n;

// In-memory guards for the upload route: a burst limit per participant (on the app's clock, like the admin PIN lockout)
// and one upload in flight per participant (extraction is async, so two parallel requests could both pass the quota).
// The slot is given back when the upload ends and, as a safety net, when the connection closes (an aborted request).
export function createUploadGuard({ clock = () => new Date() } = {}) {
  const hits = new Map(); // participant id -> [ms]
  const inFlight = new Map(); // participant id -> token
  return {
    // Counts this request toward the burst limit; throws 429 when it is over.
    hit(participantId) {
      const now = clock().getTime();
      const recent = (hits.get(participantId) ?? []).filter((t) => t > now - BURST_WINDOW_MS);
      if (recent.length >= BURST_MAX) {
        hits.set(participantId, recent);
        throw new HttpError(429, 'You’re uploading too fast. Wait a few minutes and try again.', { code: 'upload_rate_limited' });
      }
      recent.push(now);
      hits.set(participantId, recent);
    },
    // Takes the participant's one slot; returns the function that gives it back. It gives back only the slot it took, so a
    // late call (the request's 'close' after its response) can't release a newer upload's slot.
    start(participantId) {
      if (inFlight.has(participantId)) throw new HttpError(409, 'Your last upload is still being checked. Wait a moment.', { code: 'upload_in_flight' });
      const token = Symbol('upload');
      inFlight.set(participantId, token);
      return () => {
        if (inFlight.get(participantId) === token) inFlight.delete(participantId);
      };
    },
    has: (participantId) => inFlight.has(participantId),
  };
}

export function assertUploadsOn(db) {
  if (!studentUploadsAllowed(db)) throw new HttpError(403, 'Uploading your own lessons is turned off right now.', { code: 'student_uploads_off' });
}

// Too many student lessons waiting: 429 upload_busy. Checked up front and again where a lesson is created or retried, so
// requests that passed the first check together can't push the queue over the limit.
export function assertQueueRoom(db) {
  if (studentJobsWaiting(db) >= QUEUE_LIMIT) {
    throw new HttpError(429, 'Lessons are queued up right now. Try again in a few minutes.', { code: 'upload_busy' });
  }
}

// The refusals that need only the database, after the switch: the daily quota, then the queue. Throws; returns nothing.
export function assertCanUpload(db, participant, now) {
  const perDay = uploadsPerDay(db);
  if (uploadsUsedToday(db, participant.id, now) >= perDay) {
    throw new HttpError(429, perDay === 0 ? 'Uploads are turned off right now.' : 'You’ve used today’s uploads. You can upload again tomorrow.', { code: 'upload_quota' });
  }
  assertQueueRoom(db);
}
