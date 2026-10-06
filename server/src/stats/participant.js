import { nextStudyDay, studyDate, studyWeek } from './days.js';
import { dueReviews, planningTotals, round } from './planning.js';

// What the Stats tab shows for one participant, and the per-participant research summary (admin table and
// summary.csv). Times come from study_sessions' active time; every day is a 04:00 Asia/Manila study day.

const GOOD = 3;
const pct = (part, whole) => (whole ? round((part / whole) * 100, 1) : null);
const minutes = (ms) => round(ms / 60_000, 1);

const sessionsOf = (db, participantId) =>
  db.prepare('SELECT * FROM study_sessions WHERE participant_id = ? ORDER BY started_at, id').all(participantId);
const reviewsOf = (db, participantId) =>
  db.prepare('SELECT id, flashcard_id, rating, state, snapshot, reviewed_at FROM flashcard_reviews WHERE participant_id = ? ORDER BY reviewed_at, id').all(participantId);
const progressOf = (db, participantId) =>
  db.prepare('SELECT flashcard_id, state, due_at FROM flashcard_progress WHERE participant_id = ?').all(participantId);
const attemptsOf = (db, participantId) =>
  db
    .prepare(
      `SELECT a.id, a.lesson_id, l.title, a.score, a.total, a.started_at, a.finished_at, a.retake_of
       FROM quiz_attempts a JOIN lessons l ON l.id = a.lesson_id WHERE a.participant_id = ? ORDER BY a.started_at, a.id`,
    )
    .all(participantId);

// Per lesson, over finished attempts only (one left part-way is not counted):
// [{ lesson_id, title, attempts, first_pct, best_pct }] in the order the lessons were first attempted.
export function quizScores(attempts) {
  const byLesson = new Map();
  for (const a of attempts) {
    if (!a.finished_at || !a.total) continue;
    const p = pct(a.score, a.total);
    const s = byLesson.get(a.lesson_id);
    if (!s) byLesson.set(a.lesson_id, { lesson_id: a.lesson_id, title: a.title, attempts: 1, first_pct: p, best_pct: p });
    else {
      s.attempts += 1;
      s.best_pct = Math.max(s.best_pct, p);
    }
  }
  return [...byLesson.values()];
}

const cardTotals = (reviews) => {
  const goodEasy = reviews.filter((r) => r.rating >= GOOD).length;
  return { reviewed: reviews.length, good_easy: goodEasy, good_easy_pct: pct(goodEasy, reviews.length) };
};

// The Stats tab: this study week's active time per day and activity, cards reviewed and % Good/Easy (this week and
// all time), first and best quiz score per lesson, and cards due tomorrow.
export function participantStats(db, participant, { now, config }) {
  const week = studyWeek(now, config);
  const inWeek = (iso) => iso >= week.start.toISOString() && iso < week.end.toISOString();
  const days = week.dates.map((date) => ({ date, reading_ms: 0, flashcards_ms: 0, quiz_ms: 0 }));
  for (const s of sessionsOf(db, participant.id)) {
    const day = days.find((d) => d.date === s.study_date);
    if (day && inWeek(s.started_at)) day[`${s.activity}_ms`] += s.active_ms;
  }
  const totals = { reading_ms: 0, flashcards_ms: 0, quiz_ms: 0 };
  for (const d of days) for (const k of Object.keys(totals)) totals[k] += d[k];

  const reviews = reviewsOf(db, participant.id);
  const tomorrow = nextStudyDay(now, config);
  const [from, to] = [tomorrow.start.toISOString(), tomorrow.end.toISOString()];
  const dueTomorrow = progressOf(db, participant.id).filter((p) => p.state !== 0 && p.due_at && p.due_at >= from && p.due_at < to).length;

  return {
    participant: participant.code,
    today: studyDate(now, config),
    week: {
      start: week.start.toISOString(),
      end: week.end.toISOString(),
      days,
      totals: { ...totals, total_ms: totals.reading_ms + totals.flashcards_ms + totals.quiz_ms },
    },
    cards: { week: cardTotals(reviews.filter((r) => inWeek(r.reviewed_at))), all: cardTotals(reviews) },
    quiz: quizScores(attemptsOf(db, participant.id)),
    due_tomorrow: dueTomorrow,
  };
}

// ---- research summary ---------------------------------------------------------------------------------------------

export const PLANNING_COLUMNS = [
  'planning_days_active',
  'planning_total_sessions',
  'planning_reading_min',
  'planning_flashcards_min',
  'planning_quiz_min',
  'planning_total_min',
  'planning_first_study_date',
  'planning_last_study_date',
  'planning_reviews_on_time',
  'planning_reviews_late',
  'planning_reviews_still_overdue',
  'planning_avg_days_late',
  'planning_on_time_rate',
];
export const SELF_MONITORING_COLUMNS = [
  'self_monitoring_stats_views',
  'self_monitoring_quiz_retakes',
  'self_monitoring_review_flashcards_taps',
  'self_monitoring_simplify_taps',
  'self_monitoring_translate_taps',
];
const EVENT_COLUMN = {
  stats_view: 'self_monitoring_stats_views',
  quiz_retake: 'self_monitoring_quiz_retakes',
  review_flashcards_tap: 'self_monitoring_review_flashcards_taps',
  section_simplify: 'self_monitoring_simplify_taps',
  section_translate: 'self_monitoring_translate_taps',
};

export const lessonColumn = (lessonId) => `retention_quiz_first_pct_L${lessonId}`;

// The columns of summary.csv, in order, for these lessons.
export const summaryColumns = (lessons) => [
  'participant',
  ...PLANNING_COLUMNS,
  'retention_cards_reviewed',
  'retention_good_easy_pct',
  'retention_quiz_first_pct_mean',
  ...lessons.map((l) => lessonColumn(l.id)),
  ...SELF_MONITORING_COLUMNS,
];

// One participant's summary row, columns grouped by SDL dimension (planning, retention, self-monitoring).
export function summaryRow(db, participant, { now, config, lessons }) {
  const sessions = sessionsOf(db, participant.id);
  const reviews = reviewsOf(db, participant.id);
  const attempts = attemptsOf(db, participant.id);
  const answeredAt = db
    .prepare(
      `SELECT q.answered_at FROM quiz_answers q JOIN quiz_attempts a ON a.id = q.attempt_id
       WHERE a.participant_id = ? AND q.answered_at IS NOT NULL`,
    )
    .all(participant.id)
    .map((r) => r.answered_at);

  const active = sessions.filter((s) => s.active_ms > 0);
  const activeMs = { reading: 0, flashcards: 0, quiz: 0 };
  for (const s of active) activeMs[s.activity] += s.active_ms;
  const studyDays = new Set([
    ...active.map((s) => s.study_date),
    ...reviews.map((r) => studyDate(r.reviewed_at, config)),
    ...answeredAt.map((t) => studyDate(t, config)),
  ]);
  const dates = [...studyDays].sort();
  const plan = planningTotals(dueReviews(reviews, progressOf(db, participant.id), { now, config }));

  const cards = cardTotals(reviews);
  const scores = quizScores(attempts);
  const firsts = scores.map((s) => s.first_pct);
  const events = db.prepare('SELECT type, COUNT(*) AS n FROM events WHERE participant_id = ? GROUP BY type').all(participant.id);

  const row = {
    participant: participant.code,
    planning_days_active: studyDays.size,
    planning_total_sessions: active.length,
    planning_reading_min: minutes(activeMs.reading),
    planning_flashcards_min: minutes(activeMs.flashcards),
    planning_quiz_min: minutes(activeMs.quiz),
    planning_total_min: minutes(activeMs.reading + activeMs.flashcards + activeMs.quiz),
    planning_first_study_date: dates[0] ?? null,
    planning_last_study_date: dates.at(-1) ?? null,
    planning_reviews_on_time: plan.on_time,
    planning_reviews_late: plan.late,
    planning_reviews_still_overdue: plan.still_overdue,
    planning_avg_days_late: plan.avg_days_late,
    planning_on_time_rate: plan.on_time_rate,
    retention_cards_reviewed: cards.reviewed,
    retention_good_easy_pct: cards.good_easy_pct,
    retention_quiz_first_pct_mean: firsts.length ? round(firsts.reduce((a, b) => a + b, 0) / firsts.length, 1) : null,
  };
  for (const l of lessons) row[lessonColumn(l.id)] = scores.find((s) => s.lesson_id === l.id)?.first_pct ?? null;
  for (const c of SELF_MONITORING_COLUMNS) row[c] = 0;
  for (const e of events) row[EVENT_COLUMN[e.type]] = e.n;
  return row;
}

// Participants in code order; P00 (the researcher's test data) only when asked for.
export const listParticipants = (db, { includeP00 = false } = {}) =>
  db.prepare(`SELECT id, code, created_at FROM participants ${includeP00 ? '' : "WHERE code <> 'P00'"} ORDER BY code`).all();

export const listLessons = (db) => db.prepare('SELECT id, title FROM lessons ORDER BY id').all();

export function summaryTable(db, { now, config, includeP00 = false }) {
  const lessons = listLessons(db);
  return {
    columns: summaryColumns(lessons),
    lessons,
    rows: listParticipants(db, { includeP00 }).map((p) => summaryRow(db, p, { now, config, lessons })),
  };
}
