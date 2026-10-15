// What participants other than P00 (the researcher's test data) have recorded on a lesson. A lesson with any of these
// can't be deleted (routes/lessons.js), and its cards can't be regenerated (routes/admin.js): either would change or
// cut off answers the research export needs.
export function participantRecords(db, lessonId) {
  const count = (from) => db.prepare(`SELECT COUNT(*) AS n FROM ${from} AND p.code <> 'P00'`).get(lessonId).n;
  return {
    flashcard_answers: count('flashcard_reviews r JOIN flashcards f ON f.id = r.flashcard_id JOIN participants p ON p.id = r.participant_id WHERE f.lesson_id = ?'),
    quiz_attempts: count('quiz_attempts a JOIN participants p ON p.id = a.participant_id WHERE a.lesson_id = ?'),
    quiz_answers: count('quiz_answers qa JOIN quiz_attempts a ON a.id = qa.attempt_id JOIN participants p ON p.id = a.participant_id WHERE a.lesson_id = ?'),
    sessions: count('study_sessions s JOIN participants p ON p.id = s.participant_id WHERE s.lesson_id = ?'),
    events: count('events e JOIN participants p ON p.id = e.participant_id WHERE e.lesson_id = ?'),
  };
}

export const hasRecords = (records) => Object.values(records).some((n) => n > 0);
