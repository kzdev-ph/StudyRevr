import { REVIEW } from '../flashcards/scheduler.js';
import { daysBetween, studyDate } from './days.js';

// The planning metric: was each due flashcard reviewed on the study day it was due? Only cards in review state
// count; (re)learning steps are minutes apart and say nothing about planning days. Pure: rows in, rows out.
//
//   reviews   flashcard_reviews rows { participant_id?, flashcard_id, state (before the answer), snapshot, reviewed_at }
//   progress  flashcard_progress rows { participant_id?, flashcard_id, state, due_at } (the schedule now)
//
// -> one row per due review: { participant_id, flashcard_id, due_date, reviewed_at, reviewed_date, status, days_late }
//      on_time        answered on its due day (days_late 0)
//      late           answered N study days after its due day (days_late N)
//      still_overdue  not answered and its due day is over (days_late = days overdue so far)
//    A card due today and not answered yet is not listed: the day isn't over.
export function dueReviews(reviews, progress, { now, config }) {
  const today = studyDate(now, config);
  const rows = [];
  for (const r of reviews) {
    const due = reviewDue(r, config);
    if (!due) continue;
    const reviewedDate = studyDate(r.reviewed_at, config);
    const daysLate = Math.max(0, daysBetween(due, reviewedDate));
    rows.push({
      participant_id: r.participant_id,
      flashcard_id: r.flashcard_id,
      due_date: due,
      reviewed_at: r.reviewed_at,
      reviewed_date: reviewedDate,
      status: daysLate === 0 ? 'on_time' : 'late',
      days_late: daysLate,
    });
  }
  for (const p of progress) {
    if (p.state !== REVIEW || !p.due_at) continue;
    const due = studyDate(p.due_at, config);
    const overdue = daysBetween(due, today);
    if (overdue <= 0) continue;
    rows.push({ participant_id: p.participant_id, flashcard_id: p.flashcard_id, due_date: due, reviewed_at: null, reviewed_date: null, status: 'still_overdue', days_late: overdue });
  }
  return rows;
}

// The study day a review answered a due card on, or null when the answer was not on a review-state card.
export function reviewDue(review, config) {
  if (review.state !== REVIEW || !review.snapshot) return null;
  const dueAt = JSON.parse(review.snapshot).due_at;
  return dueAt ? studyDate(dueAt, config) : null;
}

// Totals for the summary. on_time_rate = on_time / (on_time + late + still_overdue), null when nothing was due.
// avg_days_late is the mean over late reviews only (null when none were late).
export function planningTotals(rows) {
  const count = (status) => rows.filter((r) => r.status === status).length;
  const onTime = count('on_time');
  const lateRows = rows.filter((r) => r.status === 'late');
  const overdue = count('still_overdue');
  const due = onTime + lateRows.length + overdue;
  return {
    on_time: onTime,
    late: lateRows.length,
    still_overdue: overdue,
    avg_days_late: lateRows.length ? round(lateRows.reduce((n, r) => n + r.days_late, 0) / lateRows.length, 2) : null,
    on_time_rate: due ? round(onTime / due, 3) : null,
  };
}

export const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;
