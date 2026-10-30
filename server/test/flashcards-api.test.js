import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AiError } from '../src/ai/client.js';
import { createApp } from '../src/app.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { getJobStatus } from '../src/pipeline/jobs.js';
import { createPipelineRunner } from '../src/pipeline/runner.js';
import { cleanReview, seedTestLogin, studyFetch, TEST_PIN } from './helpers.js';

const fetch = studyFetch; // as participant P00, with the admin PIN (see helpers.js)

const quiet = { error() {}, warn() {}, log() {}, info() {} };
const MIN = 60_000;
const NOON = '2026-10-05T04:00:00.000Z'; // 12:00 in Manila; this study day began at 2026-10-04T20:00Z
const TOMORROW_4AM = '2026-10-05T20:00:00.000Z'; // 04:00 Oct 6 in Manila

const RAW = 'Variables\nThe independent variable is the factor the researcher changes on purpose.\n\nSampling\nRandom sampling gives every member of the population an equal chance to be chosen.';

describe('flashcards API', () => {
  let db;
  let server;
  let base;
  let now;
  let ai;
  let runner;

  const start = async (reply = () => ({ cards: [] })) => {
    ai = {
      calls: [],
      async generateJSON({ schema, label, user, system }) {
        ai.calls.push({ label, user, system });
        return schema.parse(await reply(label, user));
      },
    };
    runner = createPipelineRunner({ db, ai, log: quiet });
    seedTestLogin(db);
    const app = createApp(db, { maxUploadBytes: 1024 * 1024, adminPin: TEST_PIN }, { ai, runner, clock: () => new Date(now) });
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const send = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const get = (path) => send('GET', path);
  const later = (ms) => { now = new Date(Date.parse(now) + ms).toISOString(); };

  const addLesson = (title, { status = 'ready', created = '2026-10-01T00:00:00.000Z' } = {}) =>
    Number(db.prepare('INSERT INTO lessons (title, filename, raw_text, word_count, status, created_at) VALUES (?, ?, ?, 200, ?, ?)').run(title, `${title}.pptx`, RAW, status, created).lastInsertRowid);
  const addCards = (lessonId, n, fields = {}) => {
    const insert = db.prepare(
      `INSERT INTO flashcards (lesson_id, kind, front, back, evidence, position, state, interval, due_at, ease, reps)
       VALUES (@lessonId, 'concept', @front, @back, 'quote from the lesson', @position, @state, @interval, @due_at, 2.5, @reps)`,
    );
    // a card that isn't new also gets P00's schedule row (the schedule is per participant since migration 008)
    const progress = db.prepare(
      `INSERT INTO flashcard_progress (participant_id, flashcard_id, state, interval, due_at, ease, reps)
       VALUES ((SELECT id FROM participants WHERE code = 'P00'), @id, @state, @interval, @due_at, 2.5, @reps)`,
    );
    return Array.from({ length: n }, (_, i) => {
      const row = { lessonId, front: `Q${lessonId}.${i + 1}?`, back: `A${i + 1}.`, position: i + 1, state: 0, interval: 0, due_at: null, reps: 0, ...fields };
      const id = Number(insert.run(row).lastInsertRowid);
      if (row.state !== 0 || row.reps) progress.run({ ...row, id });
      return id;
    });
  };
  const schedule = (cardId) =>
    db.prepare('SELECT state, step, ease, interval, due_at, reps, lapses FROM flashcard_progress WHERE flashcard_id = ?').get(cardId);
  const setting = (key, value) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  const reviewRows = () => db.prepare('SELECT * FROM flashcard_reviews ORDER BY id').all();

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    now = NOON;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  it('lists every lesson as a deck with New / Learning / Due counts, plus All lessons', async () => {
    await start();
    const a = addLesson('Inquiry', { created: '2026-10-01T00:00:00.000Z' });
    const b = addLesson('Sampling', { created: '2026-10-02T00:00:00.000Z' });
    addLesson('Empty');
    addCards(a, 3);
    addCards(a, 2, { state: 2, interval: 3, due_at: '2026-10-04T20:00:00.000Z', reps: 4 }); // due today
    addCards(b, 1, { state: 1, step: 0, due_at: new Date(Date.parse(NOON) - MIN).toISOString(), reps: 1 });
    addCards(b, 1, { state: 2, interval: 9, due_at: '2026-10-10T20:00:00.000Z', reps: 6 }); // not due yet

    const { status, body } = await get('/api/flashcards/decks');
    assert.equal(status, 200);
    const deck = (id) => body.decks.find((d) => d.lesson_id === id);
    assert.deepEqual([deck(a).total, deck(a).counts], [5, { new: 3, learning: 0, due: 2 }]);
    assert.deepEqual([deck(b).total, deck(b).counts], [2, { new: 0, learning: 1, due: 0 }]);
    assert.equal(body.decks.find((d) => d.title === 'Empty').total, 0);
    assert.deepEqual([body.all.total, body.all.counts], [7, { new: 3, learning: 1, due: 2 }]);
    assert.deepEqual(body.limits, { new_per_day: 20, reviews_per_day: 200, new_done: 0, reviews_done: 0 });
  });

  it('serves the next card with its evidence and the interval on each button', async () => {
    await start();
    const id = addLesson('Inquiry');
    const [first] = addCards(id, 2);
    const { status, body } = await get(`/api/lessons/${id}/flashcards/due`);
    assert.equal(status, 200);
    assert.deepEqual(body.deck, { lesson_id: id, title: 'Inquiry' });
    assert.deepEqual(body.counts, { new: 2, learning: 0, due: 0 });
    assert.equal(body.card.id, first);
    assert.equal(body.card.queue, 'new');
    assert.equal(body.card.evidence, 'quote from the lesson');
    assert.deepEqual(body.card.buttons.map((b) => b.label).slice(0, 3), ['1m', '6m', '10m']);
    assert.match(body.card.buttons[3].label, /^[345]d$/);
    assert.equal(body.next_due_at, null);
    assert.equal(body.day.start, '2026-10-04T20:00:00.000Z');
  });

  it('records each answer in the review log and returns the next card', async () => {
    await start();
    const id = addLesson('Inquiry');
    const [c1, c2] = addCards(id, 2);
    const { body } = await send('POST', `/api/flashcards/${c1}/review`, { rating: 3, time_ms: 4200, deck: id });
    assert.equal(body.answered.state, 1);
    assert.equal(body.answered.due_at, new Date(Date.parse(NOON) + 10 * MIN).toISOString());
    assert.equal(body.card.id, c2, 'the other new card is next');
    assert.deepEqual(body.counts, { new: 1, learning: 1, due: 0 }, 'the card in learning is due within the learn-ahead window');

    const [log] = reviewRows();
    assert.deepEqual(
      { card: log.flashcard_id, rating: log.rating, at: log.reviewed_at, prev: log.prev_interval, next: log.new_interval, state: log.state, ease: log.ease, ms: log.time_ms },
      { card: c1, rating: 3, at: NOON, prev: 0, next: 10 / 1440, state: 0, ease: 2.5, ms: 4200 },
    );
    assert.equal(log.id, body.review_id);
  });

  it('walks one card from new to review, then it is due again the next study day after 04:00 Manila', async () => {
    await start();
    const id = addLesson('Inquiry');
    const [c] = addCards(id, 1);
    let r = await send('POST', `/api/flashcards/${c}/review`, { rating: 3, deck: id }); // 10m step
    assert.equal(r.body.card.id, c, 'shown again early: nothing else is left (learn ahead)');
    later(10 * MIN);
    r = await send('POST', `/api/flashcards/${c}/review`, { rating: 3, deck: id }); // graduates, 1 day
    assert.equal(r.body.answered.state, 2);
    assert.equal(r.body.card, null);
    assert.equal(r.body.next_due_at, TOMORROW_4AM, 'done for today; the next card is due at 04:00 tomorrow');

    now = '2026-10-05T19:59:00.000Z'; // 03:59 in Manila
    assert.equal((await get(`/api/lessons/${id}/flashcards/due`)).body.card, null);
    now = TOMORROW_4AM;
    const due = await get(`/api/lessons/${id}/flashcards/due`);
    assert.deepEqual([due.body.card.id, due.body.card.queue, due.body.counts.due], [c, 'review', 1]);
  });

  it('applies the new-cards-per-day limit across all lessons and resets it at 04:00', async () => {
    await start();
    setting('flashcard_new_per_day', '2');
    const a = addLesson('A');
    const b = addLesson('B');
    const cardsA = addCards(a, 3);
    addCards(b, 3);
    await send('POST', `/api/flashcards/${cardsA[0]}/review`, { rating: 4, deck: a }); // Easy: straight to review
    await send('POST', `/api/flashcards/${cardsA[1]}/review`, { rating: 4, deck: a });

    const decks = (await get('/api/flashcards/decks')).body;
    assert.equal(decks.limits.new_done, 2);
    assert.deepEqual(decks.decks.map((d) => d.counts.new), [0, 0], 'the daily budget is shared by every lesson');
    assert.deepEqual(decks.decks.map((d) => d.next_due_at), [TOMORROW_4AM, TOMORROW_4AM], 'each lesson row says when it opens again');
    assert.equal(decks.all.next_due_at, TOMORROW_4AM);
    const all = await get('/api/flashcards/due');
    assert.equal(all.body.card, null);
    assert.equal(all.body.next_due_at, TOMORROW_4AM);

    now = TOMORROW_4AM;
    assert.equal((await get('/api/flashcards/due')).body.counts.new, 2);
  });

  it('the All lessons deck takes cards from every lesson, oldest lesson first', async () => {
    await start();
    const newer = addLesson('Newer', { created: '2026-10-03T00:00:00.000Z' });
    const older = addLesson('Older', { created: '2026-10-01T00:00:00.000Z' });
    addCards(newer, 1);
    const [first] = addCards(older, 1);
    const { body } = await get('/api/flashcards/due');
    assert.deepEqual(body.deck, { lesson_id: null, title: 'All lessons' });
    assert.equal(body.card.id, first);
    assert.equal(body.card.lesson_title, 'Older');
    assert.equal(body.total, 2);
  });

  it('undo puts the card back exactly as it was, removes the log row, and shows the card next', async () => {
    await start();
    const id = addLesson('Inquiry');
    const [c1] = addCards(id, 3);
    assert.equal(schedule(c1), undefined); // new: no schedule row yet
    const answered = await send('POST', `/api/flashcards/${c1}/review`, { rating: 1, deck: id });
    assert.equal(reviewRows().length, 1);

    const undo = await send('POST', `/api/flashcards/reviews/${answered.body.review_id}/undo`, { deck: id });
    assert.equal(undo.status, 200);
    assert.equal(undo.body.card.id, c1);
    assert.equal(undo.body.card.queue, 'new');
    assert.deepEqual(undo.body.counts, { new: 3, learning: 0, due: 0 });
    assert.equal(schedule(c1), undefined); // new again
    assert.equal(reviewRows().length, 0);

    const again = await send('POST', `/api/flashcards/reviews/${answered.body.review_id}/undo`, { deck: id });
    assert.equal(again.status, 404);
  });

  it('undo after a lapse restores the review card, its ease and its lapse count', async () => {
    await start();
    const id = addLesson('Inquiry');
    const [c] = addCards(id, 1, { state: 2, interval: 10, due_at: '2026-10-04T20:00:00.000Z', reps: 5 });
    const r = await send('POST', `/api/flashcards/${c}/review`, { rating: 1, deck: id });
    assert.deepEqual([r.body.answered.state, r.body.answered.ease], [3, 2.3]);
    await send('POST', `/api/flashcards/reviews/${r.body.review_id}/undo`, { deck: id });
    const { state, interval, ease, lapses } = schedule(c);
    assert.deepEqual({ state, interval, ease, lapses }, { state: 2, interval: 10, ease: 2.5, lapses: 0 });
  });

  it('only a card\'s latest answer can be undone', async () => {
    await start();
    const id = addLesson('Inquiry');
    const [c] = addCards(id, 1);
    const first = await send('POST', `/api/flashcards/${c}/review`, { rating: 1, deck: id });
    await send('POST', `/api/flashcards/${c}/review`, { rating: 3, deck: id });
    const res = await send('POST', `/api/flashcards/reviews/${first.body.review_id}/undo`, {});
    assert.equal(res.status, 409);
  });

  it('rejects bad answers with clear messages', async () => {
    await start();
    const id = addLesson('Inquiry');
    const [c] = addCards(id, 1);
    assert.equal((await send('POST', `/api/flashcards/${c}/review`, { rating: 5 })).status, 400);
    assert.equal((await send('POST', `/api/flashcards/${c}/review`, {})).status, 400);
    assert.equal((await send('POST', '/api/flashcards/999/review', { rating: 3 })).status, 404);
    assert.equal((await send('POST', '/api/flashcards/abc/review', { rating: 3 })).status, 400);
    assert.equal((await get('/api/lessons/999/flashcards/due')).status, 404);
    const capped = await send('POST', `/api/flashcards/${c}/review`, { rating: 3, time_ms: 9e9 });
    assert.equal(capped.status, 200);
    assert.equal(reviewRows()[0].time_ms, 3_600_000, 'a card left open for hours is capped at an hour');
  });

  describe('making cards for an existing lesson', () => {
    const grounded = () => ({ cards: [{ question: 'What does the researcher change on purpose?', answer: 'The independent variable.', evidence: 'The independent variable is the factor the researcher changes on purpose.' }] });

    it('makes the cards and then their quiz answer options, keeping the lesson ready the whole time', async () => {
      await start((label, user) =>
        label === 'the quiz answer options'
          ? { items: [...user.matchAll(/^\[(\d+)\] Question:/gm)].map((m) => ({ n: Number(m[1]), wrong: ['x', 'y', 'z'] })) }
          : label === 'the quiz review'
            ? cleanReview(user)
            : grounded(),
      );
      const id = addLesson('Inquiry');
      db.prepare('INSERT INTO key_terms (lesson_id, term, definition, evidence) VALUES (?, ?, ?, ?)').run(id, 'Random sampling', 'Everyone has an equal chance to be chosen.', 'Random sampling gives every member of the population an equal chance to be chosen.');
      const res = await send('POST', `/api/lessons/${id}/flashcards/generate`);
      assert.equal(res.status, 202);
      assert.equal(res.body.lesson.status, 'ready');
      assert.deepEqual([res.body.job.stage, res.body.job.status], ['flashcards', 'queued']);

      await runner.idle();
      assert.deepEqual(ai.calls.map((c) => c.label), ['the flashcards', 'the quiz answer options', 'the quiz review']);
      assert.equal(getJobStatus(db, id).lesson.status, 'ready');
      const cards = db.prepare('SELECT kind, front, evidence FROM flashcards WHERE lesson_id = ? ORDER BY position').all(id);
      assert.deepEqual(cards.map((c) => [c.kind, c.front]), [['term', 'Random sampling'], ['concept', 'What does the researcher change on purpose?']]);
      const deck = (await get('/api/flashcards/decks')).body.decks[0];
      assert.deepEqual([deck.total, deck.job], [2, null]);
    });

    it('a failure is reported on the deck, the lesson stays readable, and it can be tried again', async () => {
      let fail = true;
      await start(() => {
        if (fail) throw new AiError('rate_limit', 'The AI provider is rate limiting requests (HTTP 429). Try again shortly.');
        return grounded();
      });
      const id = addLesson('Inquiry');
      await send('POST', `/api/lessons/${id}/flashcards/generate`);
      await runner.idle();
      assert.equal(getJobStatus(db, id).lesson.status, 'ready');
      const deck = (await get('/api/flashcards/decks')).body.decks[0];
      assert.equal(deck.job.status, 'failed');
      assert.match(deck.job.error, /rate limiting/);

      fail = false;
      assert.equal((await send('POST', `/api/lessons/${id}/flashcards/generate`)).status, 202);
      await runner.idle();
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM flashcards WHERE lesson_id = ?').get(id).n, 1);
    });

    it('refuses a lesson that already has cards, is still processing, failed, or does not exist', async () => {
      await start(grounded);
      const has = addLesson('Has');
      addCards(has, 1);
      assert.equal((await send('POST', `/api/lessons/${has}/flashcards/generate`)).status, 409);
      const busy = addLesson('Busy', { status: 'processing' });
      assert.equal((await send('POST', `/api/lessons/${busy}/flashcards/generate`)).status, 409);
      const failed = addLesson('Failed', { status: 'failed' });
      assert.equal((await send('POST', `/api/lessons/${failed}/flashcards/generate`)).status, 409);
      assert.equal((await send('POST', '/api/lessons/999/flashcards/generate')).status, 404);
      assert.equal(ai.calls.length, 0);
    });

    it('deleting a lesson removes its cards and their review log', async () => {
      await start();
      const id = addLesson('Inquiry');
      const [c] = addCards(id, 1);
      await send('POST', `/api/flashcards/${c}/review`, { rating: 3 });
      await fetch(`${base}/api/lessons/${id}`, { method: 'DELETE' });
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM flashcards').get().n, 0);
      assert.equal(reviewRows().length, 0);
    });
  });
});
