import JSZip from 'jszip';
import { RESUME_WINDOW_MS } from '../quiz/attempts.js';
import { sessionStatus } from '../sessions/store.js';
import { daysBetween, studyDate } from '../stats/days.js';
import { dueReviews, reviewDue } from '../stats/planning.js';
import { summaryTable } from '../stats/participant.js';
import { toCsv } from './csv.js';
import { CODEBOOK } from './codebook.js';

// The research export: one CSV per kind of record plus a per-participant summary. Rows carry participant codes only
// (no names exist anywhere). Only study tables are read: never `settings`, so no API key or PIN can end up in a
// file. P00 (the researcher's test data) is left out unless includeP00.

const RATING = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' };
const STATE = { 0: 'new', 1: 'learning', 2: 'review', 3: 'relearning' };

export const EXPORT_FILES = ['summary', 'sessions', 'flashcard_reviews', 'due_reviews', 'quiz_attempts', 'quiz_answers', 'events'];

const who = (includeP00) => (includeP00 ? '' : "AND p.code <> 'P00'");

// How an attempt reads in the export: finished, open (can still be resumed) or abandoned (left part-way and too old
// to resume).
export const attemptStatus = (a, now) => {
  if (a.finished_at) return 'finished';
  return now.getTime() - Date.parse(a.started_at) < RESUME_WINDOW_MS ? 'open' : 'abandoned';
};

function sessions(db, { now, includeP00 }) {
  const rows = db
    .prepare(
      `SELECT p.code AS participant, s.*, l.title AS lesson_title FROM study_sessions s JOIN participants p ON p.id = s.participant_id
       LEFT JOIN lessons l ON l.id = s.lesson_id WHERE 1 = 1 ${who(includeP00)} ORDER BY p.code, s.started_at, s.id`,
    )
    .all();
  return toCsv(
    ['participant', 'session_id', 'lesson_id', 'lesson_title', 'activity', 'started_at', 'ended_at', 'end_reason', 'active_ms', 'active_min', 'study_date'],
    rows.map((s) => ({ ...s, ...sessionStatus(s, now), session_id: s.id, active_min: Math.round(s.active_ms / 600) / 100 })),
  );
}

function flashcardReviews(db, { config, includeP00 }) {
  const rows = db
    .prepare(
      `SELECT p.code AS participant, r.*, f.lesson_id, f.kind, l.title AS lesson_title FROM flashcard_reviews r
       JOIN participants p ON p.id = r.participant_id JOIN flashcards f ON f.id = r.flashcard_id JOIN lessons l ON l.id = f.lesson_id
       WHERE 1 = 1 ${who(includeP00)} ORDER BY p.code, r.reviewed_at, r.id`,
    )
    .all();
  return toCsv(
    ['participant', 'review_id', 'flashcard_id', 'lesson_id', 'lesson_title', 'kind', 'rating', 'rating_name', 'good_or_easy', 'state_before',
      'prev_interval_days', 'new_interval_days', 'ease_after', 'time_ms', 'reviewed_at', 'study_date', 'due_date', 'due_status', 'days_late'],
    rows.map((r) => {
      const due = reviewDue(r, config);
      const reviewed = studyDate(r.reviewed_at, config);
      const late = due ? Math.max(0, daysBetween(due, reviewed)) : null;
      return {
        ...r,
        review_id: r.id,
        rating_name: RATING[r.rating],
        good_or_easy: r.rating >= 3,
        state_before: STATE[r.state],
        prev_interval_days: r.prev_interval,
        new_interval_days: r.new_interval,
        ease_after: r.ease,
        study_date: reviewed,
        due_date: due,
        due_status: due ? (late === 0 ? 'on_time' : 'late') : 'n/a',
        days_late: late,
      };
    }),
  );
}

function dueReviewsCsv(db, { now, config, includeP00 }) {
  const reviews = db
    .prepare(
      `SELECT p.code AS participant, r.participant_id, r.flashcard_id, r.state, r.snapshot, r.reviewed_at FROM flashcard_reviews r
       JOIN participants p ON p.id = r.participant_id WHERE r.state = 2 ${who(includeP00)}`,
    )
    .all();
  const progress = db
    .prepare(
      `SELECT p.code AS participant, g.participant_id, g.flashcard_id, g.state, g.due_at FROM flashcard_progress g
       JOIN participants p ON p.id = g.participant_id WHERE g.state = 2 ${who(includeP00)}`,
    )
    .all();
  const codes = new Map([...reviews, ...progress].map((r) => [r.participant_id, r.participant]));
  const lessonOf = new Map(db.prepare('SELECT id, lesson_id FROM flashcards').all().map((f) => [f.id, f.lesson_id]));
  const rows = dueReviews(reviews, progress, { now, config })
    .map((r) => ({ ...r, participant: codes.get(r.participant_id), lesson_id: lessonOf.get(r.flashcard_id) }))
    .sort((a, b) => a.participant.localeCompare(b.participant) || a.due_date.localeCompare(b.due_date) || a.flashcard_id - b.flashcard_id);
  return toCsv(['participant', 'flashcard_id', 'lesson_id', 'due_date', 'reviewed_at', 'reviewed_date', 'status', 'days_late'], rows);
}

function attemptRows(db, { now, includeP00 }) {
  const rows = db
    .prepare(
      `SELECT p.code AS participant, a.*, l.title AS lesson_title,
         (SELECT COUNT(*) FROM quiz_answers q WHERE q.attempt_id = a.id AND q.chosen_index IS NOT NULL) AS answered
       FROM quiz_attempts a JOIN participants p ON p.id = a.participant_id JOIN lessons l ON l.id = a.lesson_id
       WHERE 1 = 1 ${who(includeP00)} ORDER BY p.code, a.started_at, a.id`,
    )
    .all();
  const firstSeen = new Set();
  return rows.map((a) => {
    const status = attemptStatus(a, now);
    const key = `${a.participant_id}:${a.lesson_id}`;
    const first = status === 'finished' && !firstSeen.has(key);
    if (first) firstSeen.add(key);
    return { ...a, status, is_first_attempt: first };
  });
}

function quizAttempts(db, opts) {
  return toCsv(
    ['participant', 'attempt_id', 'lesson_id', 'lesson_title', 'status', 'is_retake', 'retake_of', 'is_first_attempt', 'started_at', 'finished_at',
      'answered', 'score', 'total', 'percent', 'duration_ms', 'study_date'],
    attemptRows(db, opts).map((a) => ({
      ...a,
      attempt_id: a.id,
      is_retake: a.retake_of !== null,
      // a score only means something once the attempt is finished
      score: a.status === 'finished' ? a.score : null,
      percent: a.status === 'finished' && a.total ? Math.round((a.score / a.total) * 1000) / 10 : null,
      study_date: studyDate(a.started_at, opts.config),
    })),
  );
}

function quizAnswers(db, opts) {
  const attempts = new Map(attemptRows(db, opts).map((a) => [a.id, a]));
  const rows = db
    .prepare('SELECT * FROM quiz_answers WHERE attempt_id IN (SELECT value FROM json_each(?)) ORDER BY attempt_id, position')
    .all(JSON.stringify([...attempts.keys()]));
  return toCsv(
    ['participant', 'attempt_id', 'attempt_status', 'is_retake', 'lesson_id', 'position', 'type', 'kind', 'flashcard_id', 'question', 'statement',
      'chosen_answer', 'right_answer', 'correct', 'time_ms', 'answered_at'],
    rows
      .map((q) => {
        const a = attempts.get(q.attempt_id);
        const choices = JSON.parse(q.choices);
        return {
          ...q,
          participant: a.participant,
          attempt_status: a.status,
          is_retake: a.retake_of !== null,
          lesson_id: a.lesson_id,
          chosen_answer: q.chosen_index === null ? null : choices[q.chosen_index],
          right_answer: choices[q.answer_index],
          correct: q.correct === null ? null : q.correct,
        };
      })
      .sort((x, y) => x.participant.localeCompare(y.participant) || x.attempt_id - y.attempt_id || x.position - y.position),
  );
}

function events(db, { includeP00 }) {
  const rows = db
    .prepare(
      `SELECT p.code AS participant, e.*, l.title AS lesson_title FROM events e JOIN participants p ON p.id = e.participant_id
       LEFT JOIN lessons l ON l.id = e.lesson_id WHERE 1 = 1 ${who(includeP00)} ORDER BY p.code, e.created_at, e.id`,
    )
    .all();
  return toCsv(
    ['participant', 'event_id', 'type', 'lesson_id', 'lesson_title', 'attempt_id', 'section_index', 'created_at', 'study_date'],
    rows.map((e) => ({ ...e, event_id: e.id })),
  );
}

function summary(db, opts) {
  const { columns, rows } = summaryTable(db, opts);
  return toCsv(columns, rows);
}

const MAKERS = { summary, sessions, flashcard_reviews: flashcardReviews, due_reviews: dueReviewsCsv, quiz_attempts: quizAttempts, quiz_answers: quizAnswers, events };

// One file's CSV text. opts: { now, config, includeP00 }
export function exportCsv(db, name, opts) {
  if (!MAKERS[name]) throw new RangeError(`unknown export file ${name}`);
  return MAKERS[name](db, opts);
}

// Every file plus README.txt (the codebook), zipped. -> Buffer
export async function exportZip(db, opts) {
  const zip = new JSZip();
  for (const name of EXPORT_FILES) zip.file(`${name}.csv`, `\uFEFF${exportCsv(db, name, opts)}`); // BOM: Excel reads UTF-8
  zip.file('README.txt', CODEBOOK({ ...opts, lessons: db.prepare('SELECT id, title FROM lessons ORDER BY id').all() }));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
