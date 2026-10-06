import { studyDate } from '../stats/days.js';

// Self-monitoring events (see migration 008): Stats views, quiz retakes, "Review these flashcards" taps and the
// section Simplify / Translate taps. One row per event, with its study day.
export const EVENT_TYPES = ['stats_view', 'quiz_retake', 'review_flashcards_tap', 'section_simplify', 'section_translate'];

export function logEvent(db, { participantId, type, lessonId = null, attemptId = null, sectionIndex = null, now, config }) {
  return Number(
    db
      .prepare(
        `INSERT INTO events (participant_id, type, lesson_id, attempt_id, section_index, created_at, study_date)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(participantId, type, lessonId, attemptId, sectionIndex, now.toISOString(), studyDate(now, config)).lastInsertRowid,
  );
}
