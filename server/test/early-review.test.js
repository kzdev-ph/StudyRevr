import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addCodes, seedLesson, startStudyApp } from './helpers.js';

// 2026-10-05 04:00 UTC is 12:00 in Manila; that study day runs to 2026-10-06 04:00 Manila (2026-10-05 20:00 UTC).
const NOW = '2026-10-05T04:00:00.000Z';

describe('early-review guard', () => {
  let t;
  let cards;
  let p01;

  beforeEach(async () => {
    t = await startStudyApp({ now: NOW });
    addCodes(t.db, 'P01');
    p01 = t.db.prepare("SELECT id FROM participants WHERE code = 'P01'").get().id;
    ({ cards } = seedLesson(t.db, { n: 4 }));
  });
  afterEach(() => t.close());

  const progress = (cardId, state, dueAt, interval = 5) =>
    t.db
      .prepare('INSERT INTO flashcard_progress (participant_id, flashcard_id, state, step, ease, interval, due_at, reps, lapses) VALUES (?, ?, ?, 0, 2.5, ?, ?, 3, 0)')
      .run(p01, cardId, state, interval, dueAt);
  const answer = (cardId, rating = 3) => t.call('POST', `/api/flashcards/${cardId}/review`, { as: 'P01', body: { rating, time_ms: 1000 } });
  const reviewsOf = (cardId) => t.db.prepare('SELECT COUNT(*) n FROM flashcard_reviews WHERE flashcard_id = ?').get(cardId).n;
  const row = (cardId) => t.db.prepare('SELECT * FROM flashcard_progress WHERE participant_id = ? AND flashcard_id = ?').get(p01, cardId);

  it('refuses an answer to a review card that is not due yet, and changes nothing', async () => {
    progress(cards[0], 2, '2026-10-08T20:00:00.000Z');
    const before = row(cards[0]);
    const res = await answer(cards[0]);
    assert.equal(res.status, 409);
    assert.deepEqual([res.body.error.code, res.body.error.due_at], ['not_due', '2026-10-08T20:00:00.000Z']);
    assert.equal(reviewsOf(cards[0]), 0);
    assert.deepEqual(row(cards[0]), before);
  });

  it('a review card due at the start of the next study day is still early', async () => {
    progress(cards[0], 2, '2026-10-05T20:00:00.000Z');
    assert.equal((await answer(cards[0])).status, 409);
  });

  it('accepts review cards due today (overdue, or later today as the study screen shows them)', async () => {
    progress(cards[0], 2, '2026-10-03T20:00:00.000Z');
    progress(cards[1], 2, '2026-10-05T15:00:00.000Z'); // later today, still in this study day
    assert.equal((await answer(cards[0])).status, 200);
    assert.equal((await answer(cards[1])).status, 200);
  });

  it('learning cards (learn ahead) and new cards are not affected', async () => {
    progress(cards[0], 1, '2026-10-05T04:10:00.000Z', 0);
    assert.equal((await answer(cards[0], 1)).status, 200);
    assert.equal((await answer(cards[1])).status, 200, 'a new card');
  });

  it('the study screen never offers a card that is not due', async () => {
    progress(cards[0], 2, '2026-10-08T20:00:00.000Z');
    for (const c of cards.slice(1)) progress(c, 2, '2026-10-09T20:00:00.000Z');
    const due = await t.call('GET', '/api/flashcards/due', { as: 'P01' });
    assert.equal(due.body.card, null);
  });

  it('undo still works: the undone card is due again and can be answered', async () => {
    progress(cards[0], 2, '2026-10-04T20:00:00.000Z');
    const first = await answer(cards[0], 4);
    assert.equal(first.status, 200);
    assert.equal((await answer(cards[0])).status, 409, 'after Easy it is no longer due');
    const undo = await t.call('POST', `/api/flashcards/reviews/${first.body.review_id}/undo`, { as: 'P01', body: {} });
    assert.equal(undo.status, 200);
    assert.equal(undo.body.card.id, cards[0]);
    assert.equal((await answer(cards[0])).status, 200);
  });
});

describe('new-card limit guard', () => {
  let t;
  let cards;
  let p01;

  beforeEach(async () => {
    t = await startStudyApp({ now: NOW });
    addCodes(t.db, 'P01', 'P02');
    p01 = t.db.prepare("SELECT id FROM participants WHERE code = 'P01'").get().id;
    ({ cards } = seedLesson(t.db, { n: 4 }));
    t.db.prepare("UPDATE settings SET value = '2' WHERE key = 'flashcard_new_per_day'").run();
  });
  afterEach(() => t.close());

  const answer = (cardId, as = 'P01', rating = 3) => t.call('POST', `/api/flashcards/${cardId}/review`, { as, body: { rating, time_ms: 1000 } });
  const reviewsOf = (cardId) => t.db.prepare('SELECT COUNT(*) n FROM flashcard_reviews WHERE flashcard_id = ?').get(cardId).n;
  const progressOf = (cardId) => t.db.prepare('SELECT * FROM flashcard_progress WHERE flashcard_id = ?').get(cardId);

  it('refuses a new card beyond the day’s limit with 409 new_limit, and saves nothing', async () => {
    assert.equal((await answer(cards[0])).status, 200);
    assert.equal((await answer(cards[1])).status, 200);
    const res = await answer(cards[2]);
    assert.equal(res.status, 409);
    assert.deepEqual([res.body.error.code, res.body.error.new_per_day], ['new_limit', 2]);
    assert.equal(reviewsOf(cards[2]), 0);
    assert.equal(progressOf(cards[2]), undefined, 'the card is still new');
  });

  it('the study screen offers exactly the cards the guard allows', async () => {
    await answer(cards[0]);
    let due = await t.call('GET', '/api/flashcards/due', { as: 'P01' });
    assert.equal(due.body.card.id, cards[1]);
    await answer(cards[1]);
    due = await t.call('GET', '/api/flashcards/due', { as: 'P01' });
    // the new budget is spent: only the two learning cards are offered (learn ahead), never a third new card
    assert.deepEqual([due.body.counts.new, due.body.card.state], [0, 1]);
    assert.notEqual(due.body.card.id, cards[2]);
  });

  it('answering a card that is already learning is not a new card', async () => {
    await answer(cards[0], 'P01', 1);
    await answer(cards[1]);
    assert.equal((await answer(cards[0], 'P01', 1)).status, 200, 'the learning card can be answered again');
  });

  it('the limit is per participant', async () => {
    await answer(cards[0]);
    await answer(cards[1]);
    assert.equal((await answer(cards[2], 'P01')).status, 409);
    assert.equal((await answer(cards[2], 'P02')).status, 200);
  });

  it('review answers are not counted against the new-card limit', async () => {
    t.db
      .prepare('INSERT INTO flashcard_progress (participant_id, flashcard_id, state, step, ease, interval, due_at, reps, lapses) VALUES (?, ?, 2, 0, 2.5, 5, ?, 3, 0)')
      .run(p01, cards[3], '2026-10-03T20:00:00.000Z');
    await answer(cards[0]);
    await answer(cards[1]);
    assert.equal((await answer(cards[3])).status, 200);
  });

  it('undo gives the budget back: an undone new card can be answered, and so can the next one', async () => {
    const first = await answer(cards[0]);
    await answer(cards[1]);
    assert.equal((await answer(cards[2])).status, 409);
    const undo = await t.call('POST', `/api/flashcards/reviews/${first.body.review_id}/undo`, { as: 'P01', body: {} });
    assert.equal(undo.status, 200);
    assert.equal(undo.body.card.id, cards[0], 'the undone card is shown again');
    assert.equal((await answer(cards[0])).status, 200);
    assert.equal((await answer(cards[2])).status, 409, 'two new cards are done again');
  });

  it('a limit of 0 refuses every new card', async () => {
    t.db.prepare("UPDATE settings SET value = '0' WHERE key = 'flashcard_new_per_day'").run();
    assert.equal((await answer(cards[0])).status, 409);
  });

  it('a new card answered the day before does not count today', async () => {
    t.db
      .prepare("INSERT INTO flashcard_reviews (participant_id, flashcard_id, rating, reviewed_at, prev_interval, new_interval, state, ease, time_ms) VALUES (?, ?, 3, '2026-10-04T10:00:00.000Z', 0, 0, 0, 2.5, 1000), (?, ?, 3, '2026-10-04T10:01:00.000Z', 0, 0, 0, 2.5, 1000)")
      .run(p01, cards[0], p01, cards[1]);
    assert.equal((await answer(cards[2])).status, 200);
  });
});
