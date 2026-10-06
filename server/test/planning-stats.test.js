import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dueReviews, planningTotals } from '../src/stats/planning.js';
import { addCodes, seedLesson, startStudyApp } from './helpers.js';

const MIN = 60_000;
// study day N starts at 04:00 Manila = 20:00Z the evening before
const dayStart = (date) => new Date(Date.parse(`${date}T04:00:00+08:00`)).toISOString();
const review = (dueDate, reviewedAt, extra = {}) => ({ participant_id: 1, flashcard_id: 1, state: 2, snapshot: JSON.stringify({ due_at: dayStart(dueDate) }), reviewed_at: reviewedAt, ...extra });

describe('planning metric: on-time and late reviews', () => {
  const now = new Date('2026-10-10T04:00:00.000Z'); // Oct 10, noon Manila
  it('classifies each due review by study day (04:00 Manila boundary)', () => {
    const rows = dueReviews(
      [
        review('2026-10-06', '2026-10-06T10:00:00.000Z'), // same day: on time
        review('2026-10-06', '2026-10-06T19:59:00.000Z'), // 03:59 Oct 7 Manila: still Oct 6, on time
        review('2026-10-06', '2026-10-06T20:00:00.000Z'), // 04:00 Oct 7: one day late
        review('2026-10-06', '2026-10-08T23:00:00.000Z'), // Oct 9 07:00: three days late
        { ...review('2026-10-06', '2026-10-06T10:00:00.000Z'), state: 1 }, // a learning step: not a day plan
        { ...review('2026-10-06', '2026-10-06T10:00:00.000Z'), state: 0 }, // a new card
      ],
      [
        { participant_id: 1, flashcard_id: 2, state: 2, due_at: dayStart('2026-10-08') }, // overdue by 2 days
        { participant_id: 1, flashcard_id: 3, state: 2, due_at: dayStart('2026-10-10') }, // due today: not yet counted
        { participant_id: 1, flashcard_id: 4, state: 2, due_at: dayStart('2026-10-12') }, // not due yet
        { participant_id: 1, flashcard_id: 5, state: 1, due_at: '2026-10-01T00:00:00.000Z' }, // learning
      ],
      { now },
    );
    assert.deepEqual(
      rows.map((r) => [r.status, r.days_late, r.due_date]),
      [
        ['on_time', 0, '2026-10-06'],
        ['on_time', 0, '2026-10-06'],
        ['late', 1, '2026-10-06'],
        ['late', 3, '2026-10-06'],
        ['still_overdue', 2, '2026-10-08'],
      ],
    );
    assert.deepEqual(planningTotals(rows), { on_time: 2, late: 2, still_overdue: 1, avg_days_late: 2, on_time_rate: 0.4 });
    assert.deepEqual(planningTotals([]), { on_time: 0, late: 0, still_overdue: 0, avg_days_late: null, on_time_rate: null });
  });
});

describe('Stats', () => {
  let t;
  afterEach(() => t?.close());

  it('end to end: a graduated card reviewed on its due day is on time; week time, cards, quiz and due tomorrow', async () => {
    t = await startStudyApp({ now: '2026-10-05T04:00:00.000Z' }); // Monday noon Manila
    addCodes(t.db, 'P01');
    const { lessonId, cards } = seedLesson(t.db, { n: 3 });
    const as = 'P01';
    // Easy graduates a new card to a 4-day interval (due Fri Oct 9); Good on another starts its learning steps
    await t.call('POST', `/api/flashcards/${cards[0]}/review`, { as, body: { rating: 4, deck: lessonId } });
    await t.call('POST', `/api/flashcards/${cards[1]}/review`, { as, body: { rating: 1, deck: lessonId } });
    const p01 = t.db.prepare("SELECT id FROM participants WHERE code = 'P01'").get().id;
    const dueAt = t.db.prepare('SELECT due_at FROM flashcard_progress WHERE participant_id = ? AND flashcard_id = ?').get(p01, cards[0]).due_at;

    // sessions this week: 10 min reading Monday, 5 min flashcards Tuesday; one last week doesn't count
    const sess = async (activity, now, ms) => {
      t.now = now;
      const s = (await t.call('POST', '/api/sessions', { as, body: { lesson_id: lessonId, activity } })).body.session;
      t.now = new Date(Date.parse(now) + ms).toISOString();
      await t.call('POST', `/api/sessions/${s.id}`, { as, body: { active_ms: ms, end_reason: 'left' } });
    };
    await sess('reading', '2026-10-05T05:00:00.000Z', 10 * MIN);
    await sess('flashcards', '2026-10-06T05:00:00.000Z', 5 * MIN);
    await sess('quiz', '2026-10-04T05:00:00.000Z', 7 * MIN); // Sunday: last week

    // quiz: an abandoned attempt, then two finished ones (first 50%, then better)
    const ins = t.db.prepare('INSERT INTO quiz_attempts (participant_id, lesson_id, score, total, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)');
    ins.run(p01, lessonId, 0, 4, '2026-10-05T06:00:00.000Z', null);
    ins.run(p01, lessonId, 2, 4, '2026-10-05T07:00:00.000Z', '2026-10-05T07:05:00.000Z');
    ins.run(p01, lessonId, 3, 4, '2026-10-05T08:00:00.000Z', '2026-10-05T08:05:00.000Z');

    // the Easy card's interval is 4 days with fuzz (3-5): look at stats at noon the day before it is due
    t.now = new Date(Date.parse(dueAt) - 8 * 3_600_000).toISOString();
    assert.ok(t.now < '2026-10-11T20:00:00.000Z', 'still this study week');
    const stats = (await t.call('GET', '/api/stats', { as })).body;
    assert.equal(stats.week.days[0].reading_ms, 10 * MIN);
    assert.equal(stats.week.days[1].flashcards_ms, 5 * MIN);
    assert.deepEqual(stats.week.totals, { reading_ms: 10 * MIN, flashcards_ms: 5 * MIN, quiz_ms: 0, total_ms: 15 * MIN });
    assert.deepEqual(stats.cards.all, { reviewed: 2, good_easy: 1, good_easy_pct: 50 });
    assert.deepEqual(stats.quiz, [{ lesson_id: lessonId, title: 'Inquiry', attempts: 2, first_pct: 50, best_pct: 75 }]);
    assert.equal(stats.due_tomorrow, 1);
    // looking at stats is not an event by itself (the app sends stats_view)
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM events').get().n, 0);

    // reviewed on its due day -> on time
    t.now = new Date(Date.parse(dueAt) + 3 * 3_600_000).toISOString();
    await t.call('POST', `/api/flashcards/${cards[0]}/review`, { as, body: { rating: 3, deck: lessonId } });
    const plan = (await t.call('GET', '/api/admin/participants', { pin: 'test-pin-2468' })).body.participants.find((p) => p.participant === 'P01');
    assert.deepEqual([plan.planning_reviews_on_time, plan.planning_reviews_late, plan.planning_on_time_rate], [1, 0, 1]);
  });
});
