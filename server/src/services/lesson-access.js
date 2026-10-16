import { HttpError } from '../middleware/errors.js';
import { participantOf } from '../middleware/participant.js';

// Who may see which lesson (Phase 7B). The teacher's lessons (origin 'admin') and lessons admin shared (shared_at set)
// are visible to everyone; a student's own upload is visible to its owner until shared; admin sees everything. Every
// route that reads a lesson, directly or through a section, card or attempt, goes through this, and a lesson the
// caller may not see is a 404 ("Lesson not found."), never a 403, so its existence isn't revealed.
//
// The rule fails closed: a private student lesson whose owner is gone (owner_participant_id NULL) is visible to nobody.

export const NOT_FOUND = 'Lesson not found.';

// SQL condition for lessons visible to `viewer` ({ admin, participant }), written over the table alias `alias`. The
// participant id is a number from our own table, so it is written in as a literal.
export function visibleSql(viewer, alias = 'l') {
  if (viewer.admin) return '1 = 1';
  const id = Number.isInteger(viewer.participant?.id) ? viewer.participant.id : 0;
  return `(${alias}.origin = 'admin' OR ${alias}.shared_at IS NOT NULL OR ${alias}.owner_participant_id = ${id})`;
}

// What the caller is: { admin, participant }. `admin` is true only with the right PIN (a wrong one is the usual 401 and
// counts toward the lockout); `participant` is the code in X-Participant, or null when none was sent (a wrong code is 401).
export function createAccess({ db, requireAdmin }) {
  const viewerOf = (req) => {
    const admin = requireAdmin.isAdmin(req);
    return { admin, participant: participantOf(db, req) };
  };

  // The lesson row (the named columns, default id/title/status) when `viewer` may see it, else 404.
  const visibleLesson = (viewer, lessonId, columns = 'l.id, l.title, l.status') => {
    const row = db.prepare(`SELECT ${columns} FROM lessons l WHERE l.id = ? AND ${visibleSql(viewer)}`).get(lessonId);
    if (!row) throw new HttpError(404, NOT_FOUND);
    return row;
  };

  // True when the lesson exists and `viewer` may see it.
  const canSee = (viewer, lessonId) => Boolean(db.prepare(`SELECT 1 FROM lessons l WHERE l.id = ? AND ${visibleSql(viewer)}`).get(lessonId));

  return { viewerOf, visibleLesson, canSee, visibleSql, db };
}

// What a student has recorded on their own lesson: flashcard answers, quiz attempts and study sessions with active
// time. Unlike participantRecords (services/lesson-records.js, every participant but P00, for admin's delete) this is
// about one participant and counts P00 if P00 is the owner. A session that was only opened (no active time) is not
// studying, so looking at a lesson doesn't take the Delete option away.
export function ownerRecords(db, lessonId, participantId) {
  const count = (sql) => db.prepare(sql).get(lessonId, participantId).n;
  return {
    flashcard_answers: count('SELECT COUNT(*) AS n FROM flashcard_reviews r JOIN flashcards f ON f.id = r.flashcard_id WHERE f.lesson_id = ? AND r.participant_id = ?'),
    quiz_attempts: count('SELECT COUNT(*) AS n FROM quiz_attempts WHERE lesson_id = ? AND participant_id = ?'),
    sessions: count('SELECT COUNT(*) AS n FROM study_sessions WHERE lesson_id = ? AND participant_id = ? AND active_ms > 0'),
  };
}
