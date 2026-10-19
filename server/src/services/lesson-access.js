import { HttpError } from '../middleware/errors.js';
import { participantOf } from '../middleware/participant.js';

// Who may see which lesson (Phase 7B). The teacher's lessons (origin 'admin') and lessons admin shared (shared_at set)
// are visible to everyone; a student's own upload is visible to its owner until shared; admin sees everything. Every
// route that reads a lesson, directly or through a section, card or attempt, goes through this, and a lesson the
// caller may not see is a 404 ("Lesson not found."), never a 403, so its existence isn't revealed.
//
// The rule fails closed: a private student lesson whose owner is gone (owner_participant_id NULL) is visible to nobody.

export const NOT_FOUND = 'Lesson not found.';

// What a student sees when their upload failed for a reason that isn't about the file (the AI was down or busy, the
// server restarted): never a provider message or a pointer to Settings. A message about the file itself (no text) stays.
export const UPLOAD_FAILED_MESSAGE = 'The AI couldn’t prepare this lesson right now. Try again in a few minutes.';
// The same for the flashcards a student sees failing on the Flashcard tab, and for the simpler / Taglish step
export const CARDS_FAILED_MESSAGE = 'The AI couldn’t make the cards right now. Your teacher can try again.';
export const PREPARE_FAILED_MESSAGE = 'Preparing the simpler and Taglish versions didn’t finish.';

// The same for a teacher's lesson that failed (students can't retry it)
export const LESSON_FAILED_MESSAGE = 'This lesson couldn’t be prepared. Your teacher can try again.';

// `message` as the caller may read it: for a student, a lesson (their own upload or the teacher's) that failed for a
// reason other than its file is the plain line; admin and the file's own problems (kind 'content') keep the real text.
// `row` needs origin and error_kind.
export const safeError = (message, row, viewer) => {
  if (!message || viewer.admin || row?.error_kind === 'content') return message;
  return row?.origin === 'student' ? UPLOAD_FAILED_MESSAGE : LESSON_FAILED_MESSAGE;
};

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

// What a student has recorded on their own lesson: flashcard answers, quiz attempts with at least one answered question,
// and reading sessions with active time. Unlike participantRecords (services/lesson-records.js, every participant but
// P00, for admin's delete) this is about one participant and counts P00 if P00 is the owner. Opening a quiz or the
// flashcards, or a reading session with no active time, is not studying: it doesn't take the Delete option away (and
// deleteAsOwner removes those rows with the lesson). Time in a quiz or on the flashcards without an answer is not a
// record either: the answers are what the research needs.
export function ownerRecords(db, lessonId, participantId) {
  const count = (sql) => db.prepare(sql).get(lessonId, participantId).n;
  return {
    flashcard_answers: count('SELECT COUNT(*) AS n FROM flashcard_reviews r JOIN flashcards f ON f.id = r.flashcard_id WHERE f.lesson_id = ? AND r.participant_id = ?'),
    quiz_attempts: count(
      `SELECT COUNT(*) AS n FROM quiz_attempts a WHERE a.lesson_id = ? AND a.participant_id = ?
         AND EXISTS (SELECT 1 FROM quiz_answers q WHERE q.attempt_id = a.id AND q.answered_at IS NOT NULL)`,
    ),
    sessions: count("SELECT COUNT(*) AS n FROM study_sessions WHERE lesson_id = ? AND participant_id = ? AND activity = 'reading' AND active_ms > 0"),
  };
}
