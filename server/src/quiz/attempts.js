import { HttpError } from '../middleware/errors.js';

// The database side of a quiz: an attempt (quiz_attempts) and one quiz_answers row per question. The questions are
// written when the quiz starts and each answer is saved the moment it is given, so a quiz left part-way is still
// logged up to where the student stopped. Nothing here touches the flashcards or their review log.
// Every attempt belongs to one participant; given a participantId, these functions only see that participant's
// attempts (anyone else's is "not found").

const MAX_TIME_MS = 60 * 60 * 1000; // one question left open for hours counts as an hour
const MAX_DURATION_MS = 6 * MAX_TIME_MS;
const clampMs = (ms, max) => Math.round(Math.min(Math.max(Number(ms) || 0, 0), max));

const ANSWER_COLUMNS = `position, flashcard_id, type, kind, question, statement, choices, answer_index, answer_text, evidence,
  chosen_index, correct, time_ms, answered_at`;

const parseRow = (row) => ({ ...row, choices: JSON.parse(row.choices), correct: row.correct === null ? null : Boolean(row.correct) });

export function getAttempt(db, attemptId, participantId = null) {
  const { participant_id: owner, ...attempt } =
    db
      .prepare(
        `SELECT a.id, a.lesson_id, l.title, a.score, a.total, a.started_at, a.finished_at, a.duration_ms, a.retake_of, a.participant_id
         FROM quiz_attempts a JOIN lessons l ON l.id = a.lesson_id WHERE a.id = ?`,
      )
      .get(attemptId) ?? {};
  if (!attempt.id || (participantId !== null && owner !== participantId)) throw new HttpError(404, 'Quiz attempt not found.');
  return attempt;
}

export const attemptQuestions = (db, attemptId) =>
  db.prepare(`SELECT ${ANSWER_COLUMNS} FROM quiz_answers WHERE attempt_id = ? ORDER BY position`).all(attemptId).map(parseRow);

// A question as the quiz screen gets it before it is answered: no right answer, no evidence.
export const publicQuestion = (q) => ({ position: q.position, type: q.type, kind: q.kind, question: q.question, statement: q.statement, choices: q.choices });

// Saves a new attempt and its questions (from buildQuiz / reshuffle) in one transaction. -> attempt id
export function startAttempt(db, { participantId, lessonId, questions, now, retakeOf = null }) {
  return db.transaction(() => {
    const attemptId = Number(
      db
        .prepare('INSERT INTO quiz_attempts (participant_id, lesson_id, score, total, answers, taken_at, started_at, retake_of) VALUES (?, ?, 0, ?, ?, ?, ?, ?)')
        .run(participantId, lessonId, questions.length, '[]', now.toISOString(), now.toISOString(), retakeOf).lastInsertRowid,
    );
    const insert = db.prepare(
      `INSERT INTO quiz_answers (attempt_id, position, flashcard_id, type, kind, question, statement, choices, answer_index, answer_text, evidence)
       VALUES (@attemptId, @position, @flashcard_id, @type, @kind, @question, @statement, @choices, @answer_index, @answer_text, @evidence)`,
    );
    questions.forEach((q, position) => insert.run({ ...q, attemptId, position, statement: q.statement ?? null, evidence: q.evidence ?? null, choices: JSON.stringify(q.choices) }));
    return attemptId;
  })();
}

// This participant's unfinished attempt on this lesson that started less than RESUME_WINDOW_MS ago, or null. Older unfinished attempts
// stay as they are: they count as abandoned. -> { attempt, next_position, elapsed_ms }
export const RESUME_WINDOW_MS = 2 * 60 * 60 * 1000;

export function findOpenAttempt(db, lessonId, now, participantId) {
  const cutoff = new Date(now.getTime() - RESUME_WINDOW_MS).toISOString();
  const row = db
    .prepare(
      `SELECT id FROM quiz_attempts WHERE participant_id = ? AND lesson_id = ? AND finished_at IS NULL AND started_at > ?
       ORDER BY started_at DESC, id DESC LIMIT 1`,
    )
    .get(participantId, lessonId, cutoff);
  if (!row) return null;
  const { next, spent } = db
    .prepare('SELECT MIN(CASE WHEN chosen_index IS NULL THEN position END) AS next, COALESCE(SUM(time_ms), 0) AS spent FROM quiz_answers WHERE attempt_id = ?')
    .get(row.id);
  return { attempt: getAttempt(db, row.id), next_position: next, elapsed_ms: spent };
}

// The questions of an earlier attempt, as buildQuiz returns them (for a retake).
export function questionsOf(db, attemptId) {
  return attemptQuestions(db, attemptId).map(({ flashcard_id, type, kind, question, statement, choices, answer_index, answer_text, evidence }) => ({
    flashcard_id,
    type,
    kind,
    question,
    statement,
    choices,
    answer_index,
    answer_text,
    evidence,
  }));
}

// Saves one answer. Each question is answered once; a finished attempt takes no more answers.
// -> { position, chosen_index, correct, answer_index, answer_text, evidence }
export function answerQuestion(db, { participantId = null, attemptId, position, choice, timeMs, now }) {
  return db.transaction(() => {
    const attempt = getAttempt(db, attemptId, participantId);
    if (attempt.finished_at) throw new HttpError(409, 'This quiz is already finished.');
    const row = db.prepare(`SELECT ${ANSWER_COLUMNS} FROM quiz_answers WHERE attempt_id = ? AND position = ?`).get(attemptId, position);
    if (!row) throw new HttpError(404, 'That question is not part of this quiz.');
    const q = parseRow(row);
    if (q.chosen_index !== null) throw new HttpError(409, 'This question was already answered.');
    if (choice >= q.choices.length) throw new HttpError(400, `choice must be between 0 and ${q.choices.length - 1}.`);
    const correct = choice === q.answer_index;
    db.prepare('UPDATE quiz_answers SET chosen_index = ?, correct = ?, time_ms = ?, answered_at = ? WHERE attempt_id = ? AND position = ?').run(
      choice,
      correct ? 1 : 0,
      clampMs(timeMs, MAX_TIME_MS),
      now.toISOString(),
      attemptId,
      position,
    );
    return { position, chosen_index: choice, correct, answer_index: q.answer_index, answer_text: q.answer_text, evidence: q.evidence };
  })();
}

// The results screen: score and the questions that were missed, with the student's answer and the right one.
export function attemptResults(db, attemptId, participantId = null) {
  const { participant_id: owner } = db.prepare('SELECT participant_id FROM quiz_attempts WHERE id = ?').get(attemptId) ?? {};
  const attempt = getAttempt(db, attemptId, participantId);
  const questions = attemptQuestions(db, attemptId);
  const missed = questions
    .filter((q) => !q.correct)
    .map((q) => ({
      position: q.position,
      type: q.type,
      kind: q.kind,
      question: q.question,
      statement: q.statement,
      your_answer: q.chosen_index === null ? null : q.choices[q.chosen_index],
      right_answer: q.choices[q.answer_index],
      answer_text: q.answer_text,
      evidence: q.evidence,
    }));
  // the participant's best finished score on this lesson before this attempt, so the results can say "New best"
  const best = db
    .prepare(
      `SELECT MAX(CAST(score AS REAL) / total) AS best FROM quiz_attempts
       WHERE participant_id IS ? AND lesson_id = ? AND id <> ? AND finished_at IS NOT NULL AND total > 0`,
    )
    .get(owner, attempt.lesson_id, attempt.id).best;
  return {
    attempt: { ...attempt, percent: attempt.total ? Math.round((attempt.score / attempt.total) * 100) : 0 },
    missed,
    previous_best_percent: best === null ? null : Math.round(best * 100),
  };
}

// Closes the attempt once every question is answered. Finishing again returns the same results.
export function finishAttempt(db, { participantId = null, attemptId, durationMs, now }) {
  db.transaction(() => {
    const attempt = getAttempt(db, attemptId, participantId);
    if (attempt.finished_at) return;
    const { open, score } = db
      .prepare('SELECT SUM(chosen_index IS NULL) AS open, COALESCE(SUM(correct), 0) AS score FROM quiz_answers WHERE attempt_id = ?')
      .get(attemptId);
    if (open) throw new HttpError(409, `Answer every question first (${open} left).`);
    db.prepare('UPDATE quiz_attempts SET score = ?, finished_at = ?, duration_ms = ? WHERE id = ?').run(score, now.toISOString(), clampMs(durationMs, MAX_DURATION_MS), attemptId);
  })();
  return attemptResults(db, attemptId, participantId);
}

// Per lesson, over the participant's finished attempts: { attempts, best: { score, total, percent } | null, last_taken_at }.
export function lessonQuizStats(db, participantId) {
  const rows = db
    .prepare(
      `SELECT lesson_id, score, total, finished_at FROM quiz_attempts
       WHERE participant_id = ? AND finished_at IS NOT NULL AND total > 0
       ORDER BY lesson_id, CAST(score AS REAL) / total DESC, finished_at DESC`,
    )
    .all(participantId);
  const stats = new Map();
  for (const r of rows) {
    const s = stats.get(r.lesson_id);
    if (!s) stats.set(r.lesson_id, { attempts: 1, best: { score: r.score, total: r.total, percent: Math.round((r.score / r.total) * 100) }, last_taken_at: r.finished_at });
    else {
      s.attempts += 1;
      if (r.finished_at > s.last_taken_at) s.last_taken_at = r.finished_at;
    }
  }
  return stats;
}
