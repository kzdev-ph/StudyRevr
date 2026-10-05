import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGAIN, answer, buildQueue, createRng, DEFAULT_CONFIG, EASY, formatInterval, fuzzInterval, fuzzRange, GOOD, HARD,
  hashSeed, LEARNING, NEW, previewAnswers, queueOf, RELEARNING, REVIEW, studyDay,
} from '../src/flashcards/scheduler.js';
import { loadSchedulerConfig, parseSteps } from '../src/flashcards/config.js';
import { openDb, runMigrations } from '../src/db/index.js';

// A fake clock: every test says exactly what time it is. Manila is UTC+8 with no daylight saving, so 04:00 UTC is
// noon in Manila, and the study day that noon belongs to began at 04:00 Manila = 20:00 UTC the evening before.
const at = (iso) => new Date(iso);
const NOW = at('2026-10-05T04:00:00.000Z'); // 12:00 noon in Manila, Oct 5
const TODAY = '2026-10-04T20:00:00.000Z'; // 04:00 Manila, Oct 5: when this study day began
const MIN = 60_000;
const DAY = 86_400_000;
const plus = (date, ms) => new Date(date.getTime() + ms).toISOString();
const dayStart = (n) => new Date(Date.parse(TODAY) + n * DAY).toISOString();

const card = (fields = {}) => ({ id: 1, state: NEW, step: 0, ease: 2.5, interval: 0, due_at: null, reps: 0, lapses: 0, ...fields });
const press = (c, rating, now = NOW, config = DEFAULT_CONFIG) => answer(c, rating, { now, config });
const reviewCard = (fields = {}) => card({ state: REVIEW, interval: 10, ease: 2.5, due_at: TODAY, reps: 5, ...fields });
const inRange = (n, [lo, hi]) => n >= lo && n <= hi;

describe('study days (4:00 Asia/Manila)', () => {
  it('starts the day at 04:00 Manila time, which is 20:00 UTC the day before', () => {
    assert.deepEqual(studyDay(NOW), { start: at(TODAY), end: at(dayStart(1)) });
  });

  it('rolls over at exactly 04:00: 03:59 still belongs to the previous day', () => {
    assert.equal(studyDay(at('2026-10-05T19:59:59.999Z')).start.toISOString(), TODAY, '03:59:59 on Oct 6 in Manila');
    assert.equal(studyDay(at('2026-10-05T20:00:00.000Z')).start.toISOString(), dayStart(1), '04:00 on Oct 6 in Manila');
    assert.equal(studyDay(at('2026-10-04T20:00:00.000Z')).start.toISOString(), TODAY);
  });

  it('just after midnight local time is still yesterday', () => {
    assert.equal(studyDay(at('2026-10-05T16:30:00.000Z')).start.toISOString(), TODAY, '00:30 on Oct 6 in Manila');
  });

  it('follows the configured zone and hour', () => {
    const utc = studyDay(NOW, { ...DEFAULT_CONFIG, timeZone: 'UTC', dayStartHour: 4 });
    assert.equal(utc.start.toISOString(), '2026-10-05T04:00:00.000Z');
  });
});

describe('fuzz', () => {
  it('uses Anki ranges: none under 2 days, then about 25%, 15%, 5%', () => {
    assert.deepEqual(fuzzRange(1), [1, 1]);
    assert.deepEqual(fuzzRange(2), [2, 3]);
    assert.deepEqual(fuzzRange(4), [3, 5]);
    assert.deepEqual(fuzzRange(12), [10, 14]);
    assert.deepEqual(fuzzRange(25), [22, 28]);
    assert.deepEqual(fuzzRange(100), [95, 105]);
  });

  it('picks inside the range with the injected random source', () => {
    assert.equal(fuzzInterval(25, () => 0), 22);
    assert.equal(fuzzInterval(25, () => 0.999999), 28);
  });

  it('is seedable: the same seed gives the same numbers, another seed other numbers', () => {
    const a = createRng(hashSeed('x'));
    const b = createRng(hashSeed('x'));
    const c = createRng(hashSeed('y'));
    const first = [a(), a(), a()];
    assert.deepEqual([b(), b(), b()], first);
    assert.notDeepEqual([c(), c(), c()], first);
  });

  it('the same card answered the same way at the same time always gets the same interval', () => {
    const c = reviewCard({ id: 7 });
    assert.deepEqual(press(c, GOOD), press(c, GOOD));
    const bySeed = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => answer(c, GOOD, { now: NOW, seed }).card.interval));
    assert.ok(bySeed.size > 1, 'the fuzz depends on the seed');
  });

  it('spreads intervals across the whole range over many cards', () => {
    const seen = new Set();
    for (let id = 1; id <= 200; id++) seen.add(press(reviewCard({ id }), GOOD).card.interval);
    assert.ok([...seen].every((n) => inRange(n, [22, 28])));
    assert.ok(seen.size >= 5, `got ${[...seen]}`);
  });

  it('a different fuzzSeed in the config changes the draw', () => {
    const results = new Set();
    for (let s = 0; s < 20; s++) results.add(press(reviewCard(), GOOD, NOW, { ...DEFAULT_CONFIG, fuzzSeed: s }).card.interval);
    assert.ok(results.size > 1);
  });
});

describe('answering a new card (learning steps 1m 10m)', () => {
  it('Again: first learning step, due in 1 minute', () => {
    const { card: c, newInterval, dueIn } = press(card(), AGAIN);
    assert.deepEqual([c.state, c.step, c.due_at, c.reps], [LEARNING, 0, plus(NOW, MIN), 1]);
    assert.equal(newInterval, 1 / 1440);
    assert.deepEqual(dueIn, { minutes: 1 });
  });

  it('Hard: halfway between the first two steps (5.5 minutes)', () => {
    const { card: c } = press(card(), HARD);
    assert.deepEqual([c.state, c.step, c.due_at], [LEARNING, 0, plus(NOW, 5.5 * MIN)]);
  });

  it('Good: on to the second step, due in 10 minutes', () => {
    const { card: c } = press(card(), GOOD);
    assert.deepEqual([c.state, c.step, c.due_at], [LEARNING, 1, plus(NOW, 10 * MIN)]);
  });

  it('Easy: graduates at once with the easy interval (4 days, fuzzed to 3-5) and the starting ease', () => {
    const { card: c, dueIn } = press(card(), EASY);
    assert.equal(c.state, REVIEW);
    assert.ok(inRange(c.interval, [3, 5]));
    assert.equal(c.ease, 2.5);
    assert.equal(c.due_at, dayStart(c.interval), 'a review card is due at the start of a study day');
    assert.deepEqual(dueIn, { days: c.interval });
  });

  it('uses the starting ease from the config', () => {
    assert.equal(press(card(), EASY, NOW, { ...DEFAULT_CONFIG, startingEase: 2.3 }).card.ease, 2.3);
  });
});

describe('answering a learning card', () => {
  const onStep = (step) => card({ state: LEARNING, step, due_at: NOW.toISOString(), reps: 1 + step });

  it('Again goes back to the first step', () => {
    const { card: c } = press(onStep(1), AGAIN);
    assert.deepEqual([c.state, c.step, c.due_at], [LEARNING, 0, plus(NOW, MIN)]);
  });

  it('Hard on a later step repeats that step', () => {
    const { card: c } = press(onStep(1), HARD);
    assert.deepEqual([c.state, c.step, c.due_at], [LEARNING, 1, plus(NOW, 10 * MIN)]);
  });

  it('Good on the last step graduates with the graduating interval (1 day: no fuzz under 2 days)', () => {
    const { card: c } = press(onStep(1), GOOD);
    assert.deepEqual([c.state, c.step, c.interval, c.ease, c.due_at], [REVIEW, 0, 1, 2.5, dayStart(1)]);
  });

  it('Easy graduates with the easy interval', () => {
    assert.ok(inRange(press(onStep(0), EASY).card.interval, [3, 5]));
  });

  it('a single learning step: Hard is 1.5x the step, Good graduates', () => {
    const cfg = { ...DEFAULT_CONFIG, learningSteps: [10] };
    assert.equal(press(card(), HARD, NOW, cfg).card.due_at, plus(NOW, 15 * MIN));
    assert.equal(press(card(), GOOD, NOW, cfg).card.state, REVIEW);
  });

  it('no learning steps: every button graduates', () => {
    const cfg = { ...DEFAULT_CONFIG, learningSteps: [] };
    assert.equal(press(card(), AGAIN, NOW, cfg).card.interval, 1);
    assert.ok(inRange(press(card(), EASY, NOW, cfg).card.interval, [3, 5]));
  });

  it('a step index left over from longer steps is clamped to the current list', () => {
    const { card: c } = press(onStep(5), GOOD);
    assert.equal(c.state, REVIEW);
  });

  it('a graduated card is due tomorrow at 04:00 Manila, so it is not due at 03:59', () => {
    const { card: c } = press(onStep(1), GOOD);
    const before = buildQueue([{ ...c, id: 1 }], { now: at('2026-10-05T19:59:00.000Z') });
    const after = buildQueue([{ ...c, id: 1 }], { now: at('2026-10-05T20:00:00.000Z') });
    assert.equal(before.card, null);
    assert.equal(before.nextDueAt.toISOString(), dayStart(1));
    assert.equal(after.queue, 'review');
  });
});

describe('answering a review card (interval 10 days, ease 2.5, due today)', () => {
  it('Again: a lapse. Ease -0.2, relearning step of 10 minutes, new interval 0% of 10 days = the 1-day minimum', () => {
    const { card: c, newInterval } = press(reviewCard(), AGAIN);
    assert.deepEqual([c.state, c.step, c.lapses, c.interval, c.due_at], [RELEARNING, 0, 1, 1, plus(NOW, 10 * MIN)]);
    assert.ok(Math.abs(c.ease - 2.3) < 1e-9);
    assert.equal(newInterval, 10 / 1440);
  });

  it('Hard: 1.2x the interval (fuzzed), at least a day longer; ease -0.15', () => {
    const { card: c } = press(reviewCard(), HARD);
    assert.equal(c.state, REVIEW);
    assert.ok(inRange(c.interval, [11, 14]), `${c.interval}`);
    assert.ok(Math.abs(c.ease - 2.35) < 1e-9);
    assert.equal(c.due_at, dayStart(c.interval));
  });

  it('Good: interval x ease (25 days, fuzzed), longer than Hard; ease unchanged', () => {
    const hard = press(reviewCard(), HARD).card.interval;
    const { card: c } = press(reviewCard(), GOOD);
    assert.ok(inRange(c.interval, [22, 28]), `${c.interval}`);
    assert.ok(c.interval > hard);
    assert.equal(c.ease, 2.5);
  });

  it('Easy: interval x ease x easy bonus 1.3 (32 days, fuzzed), longer than Good; ease +0.15', () => {
    const good = press(reviewCard(), GOOD).card.interval;
    const { card: c } = press(reviewCard(), EASY);
    assert.ok(inRange(c.interval, [28, 36]), `${c.interval}`);
    assert.ok(c.interval > good);
    assert.ok(Math.abs(c.ease - 2.65) < 1e-9);
  });

  it('a late answer counts the extra days (half of them for Good, all for Easy)', () => {
    const late = reviewCard({ due_at: dayStart(-4) }); // due four days ago
    const good = press(late, GOOD).card.interval; // (10 + 2) * 2.5 = 30, +-4
    assert.ok(inRange(good, [26, 34]), `${good}`);
  });

  it('the ease never drops below 1.3', () => {
    assert.equal(press(reviewCard({ ease: 1.35 }), AGAIN).card.ease, 1.3);
    assert.equal(press(reviewCard({ ease: 1.3 }), HARD).card.ease, 1.3);
  });

  it('intervals never pass the maximum (36500 days)', () => {
    const { card: c } = press(reviewCard({ interval: 30000, ease: 2.5 }), EASY);
    assert.equal(c.interval, 36500);
    assert.equal(press(reviewCard(), EASY, NOW, { ...DEFAULT_CONFIG, maxInterval: 20 }).card.interval, 20);
  });

  it('the lapse interval setting keeps a share of the old interval (then at least the minimum)', () => {
    const cfg = { ...DEFAULT_CONFIG, lapseInterval: 0.5 };
    assert.equal(press(reviewCard({ interval: 30 }), AGAIN, NOW, cfg).card.interval, 15);
    assert.equal(press(reviewCard({ interval: 30 }), AGAIN, NOW, { ...cfg, lapseInterval: 0, minInterval: 3 }).card.interval, 3);
  });

  it('without relearning steps a lapse goes straight back to review', () => {
    const { card: c } = press(reviewCard(), AGAIN, NOW, { ...DEFAULT_CONFIG, relearningSteps: [] });
    assert.deepEqual([c.state, c.interval, c.due_at, c.lapses], [REVIEW, 1, dayStart(1), 1]);
  });

  it('lapses add up over repeated failures', () => {
    let c = reviewCard();
    for (let i = 0; i < 3; i++) {
      c = { ...press(c, AGAIN).card, id: 1 }; // lapse -> relearning
      c = { ...press(c, GOOD).card, id: 1 }; // back to review
    }
    assert.equal(c.lapses, 3);
    assert.equal(c.state, REVIEW);
    assert.ok(Math.abs(c.ease - 1.9) < 1e-9);
  });
});

describe('answering a relearning card (relearning step 10m)', () => {
  const lapsed = () => card({ state: RELEARNING, step: 0, interval: 1, ease: 2.3, lapses: 1, due_at: NOW.toISOString(), reps: 6 });

  it('Again repeats the relearning step', () => {
    const { card: c } = press(lapsed(), AGAIN);
    assert.deepEqual([c.state, c.step, c.due_at, c.lapses], [RELEARNING, 0, plus(NOW, 10 * MIN), 1], 'no second lapse');
  });

  it('Hard: 1.5x the only step', () => {
    assert.equal(press(lapsed(), HARD).card.due_at, plus(NOW, 15 * MIN));
  });

  it('Good: back to review with the lapse interval', () => {
    const { card: c } = press(lapsed(), GOOD);
    assert.deepEqual([c.state, c.interval, c.due_at, c.ease], [REVIEW, 1, dayStart(1), 2.3]);
  });

  it('Easy: back to review one day later than Good', () => {
    const { card: c } = press(lapsed(), EASY);
    assert.deepEqual([c.state, c.interval, c.due_at], [REVIEW, 2, dayStart(2)]);
  });
});

describe('button labels', () => {
  it('formats intervals like Anki', () => {
    assert.equal(formatInterval({ minutes: 0.5 }), '<1m');
    assert.equal(formatInterval({ minutes: 1 }), '1m');
    assert.equal(formatInterval({ minutes: 5.5 }), '6m');
    assert.equal(formatInterval({ minutes: 90 }), '1.5h');
    assert.equal(formatInterval({ minutes: 2880 }), '2d');
    assert.equal(formatInterval({ days: 4 }), '4d');
    assert.equal(formatInterval({ days: 45 }), '1.5mo');
    assert.equal(formatInterval({ days: 400 }), '1.1y');
  });

  it('a new card shows 1m / 6m / 10m / the easy interval', () => {
    const labels = previewAnswers(card(), { now: NOW }).map((b) => b.label);
    assert.deepEqual(labels.slice(0, 3), ['1m', '6m', '10m']);
    assert.match(labels[3], /^[345]d$/);
  });

  it('each label is exactly what pressing that button does (same fuzz)', () => {
    for (const c of [card(), reviewCard({ id: 3 }), reviewCard({ id: 99, interval: 50 })]) {
      for (const b of previewAnswers(c, { now: NOW })) {
        const { dueIn } = press(c, b.rating);
        assert.equal(b.label, formatInterval(dueIn));
      }
    }
  });
});

describe('the daily queue', () => {
  const news = (n, from = 1) => Array.from({ length: n }, (_, i) => card({ id: from + i }));
  const reviews = (n, from = 100, due = TODAY) => Array.from({ length: n }, (_, i) => reviewCard({ id: from + i, due_at: due }));

  it('shows due learning cards first, then due reviews, then new cards', () => {
    const learning = card({ id: 50, state: LEARNING, step: 0, due_at: plus(NOW, -MIN) });
    const cards = [...news(2), ...reviews(2), learning];
    let q = buildQueue(cards, { now: NOW });
    assert.deepEqual([q.card.id, q.queue], [50, 'learning']);
    q = buildQueue(cards.filter((c) => c.id !== 50), { now: NOW });
    assert.deepEqual([q.card.id, q.queue], [100, 'review']);
    q = buildQueue(news(2), { now: NOW });
    assert.deepEqual([q.card.id, q.queue], [1, 'new']);
    assert.deepEqual(buildQueue(cards, { now: NOW }).counts, { new: 2, learning: 1, due: 2 });
  });

  it('introduces new cards in the order given', () => {
    const cards = [card({ id: 9 }), card({ id: 3 }), card({ id: 5 })];
    assert.equal(buildQueue(cards, { now: NOW }).card.id, 9);
  });

  it('caps new cards at 20 a day, minus the ones already introduced today', () => {
    assert.equal(buildQueue(news(30), { now: NOW }).counts.new, 20);
    assert.equal(buildQueue(news(30), { now: NOW, doneToday: { newCards: 18, reviews: 0 } }).counts.new, 2);
    const done = buildQueue(news(30), { now: NOW, doneToday: { newCards: 20, reviews: 0 } });
    assert.deepEqual([done.card, done.counts.new], [null, 0]);
    assert.equal(done.nextDueAt.toISOString(), dayStart(1), 'the rest come back when the next study day starts');
  });

  it('caps reviews at 200 a day, minus the ones already answered today', () => {
    assert.equal(buildQueue(reviews(250), { now: NOW }).counts.due, 200);
    assert.equal(buildQueue(reviews(250), { now: NOW, doneToday: { newCards: 0, reviews: 195 } }).counts.due, 5);
    const done = buildQueue(reviews(250), { now: NOW, doneToday: { newCards: 0, reviews: 200 } });
    assert.equal(done.card, null);
    assert.equal(done.nextDueAt.toISOString(), dayStart(1));
  });

  it('uses the configured limits', () => {
    const cfg = { ...DEFAULT_CONFIG, newPerDay: 5, reviewsPerDay: 3 };
    assert.deepEqual(buildQueue([...news(10), ...reviews(10)], { now: NOW, config: cfg }).counts, { new: 5, learning: 0, due: 3 });
  });

  it('learning cards are not limited and do not use up the limits', () => {
    const learning = Array.from({ length: 30 }, (_, i) => card({ id: 300 + i, state: LEARNING, due_at: NOW.toISOString() }));
    assert.equal(buildQueue(learning, { now: NOW, doneToday: { newCards: 20, reviews: 200 } }).counts.learning, 30);
  });

  it('a review due later today (before the 04:00 rollover) counts as due now; one due tomorrow does not', () => {
    const cards = [reviewCard({ id: 1, due_at: plus(NOW, 6 * 3600_000) }), reviewCard({ id: 2, due_at: dayStart(1) })];
    const q = buildQueue(cards, { now: NOW });
    assert.equal(q.counts.due, 1);
    assert.equal(q.card.id, 1);
  });

  it('after the 04:00 rollover yesterday\'s limits no longer apply (the caller counts from the new day)', () => {
    const tomorrow = at('2026-10-05T20:00:00.000Z');
    const q = buildQueue([...news(25), ...reviews(3, 100, dayStart(1))], { now: tomorrow, doneToday: { newCards: 0, reviews: 0 } });
    assert.deepEqual(q.counts, { new: 20, learning: 0, due: 3 });
  });

  it('learns ahead: with nothing else left, a learning card due within 20 minutes is shown now', () => {
    const soon = card({ id: 1, state: LEARNING, step: 1, due_at: plus(NOW, 10 * MIN) });
    const q = buildQueue([soon], { now: NOW });
    assert.deepEqual([q.card?.id, q.queue, q.counts.learning], [1, 'learning', 1]);
    const withNew = buildQueue([soon, card({ id: 2 })], { now: NOW });
    assert.equal(withNew.card.id, 2, 'a new card comes before learning ahead');
  });

  it('done for now: says when the next card is due', () => {
    const later = card({ id: 1, state: RELEARNING, due_at: plus(NOW, 25 * MIN) });
    const q = buildQueue([later, reviewCard({ id: 2, due_at: dayStart(3) })], { now: NOW });
    assert.equal(q.card, null);
    assert.deepEqual(q.counts, { new: 0, learning: 0, due: 0 });
    assert.equal(q.nextDueAt.toISOString(), plus(NOW, 25 * MIN));
    assert.equal(buildQueue([reviewCard({ id: 2, due_at: dayStart(3) })], { now: NOW }).nextDueAt.toISOString(), dayStart(3));
    assert.equal(buildQueue([], { now: NOW }).nextDueAt, null, 'an empty deck has nothing coming');
  });

  it('knows which queue a card belongs to', () => {
    assert.deepEqual([card(), card({ state: LEARNING }), reviewCard(), card({ state: RELEARNING })].map(queueOf), ['new', 'learning', 'review', 'learning']);
  });

  it('a full day with the fake clock: introduce, learn, graduate, come back tomorrow', () => {
    let now = NOW;
    let c = card();
    const step = (rating, ms = 0) => {
      now = new Date(now.getTime() + ms);
      c = { ...answer(c, rating, { now }).card, id: 1 };
    };
    step(GOOD); // 10m
    assert.equal(buildQueue([c], { now: new Date(now.getTime() + 5 * MIN) }).card.id, 1, 'shown early by learn-ahead');
    step(GOOD, 10 * MIN); // graduates: 1 day
    assert.equal(c.state, REVIEW);
    assert.equal(buildQueue([c], { now }).card, null);
    const tomorrow = at(dayStart(1));
    assert.equal(buildQueue([c], { now: tomorrow }).queue, 'review');
  });
});

describe('scheduler settings', () => {
  it('parses learning steps with units', () => {
    assert.deepEqual(parseSteps('1m 10m'), [1, 10]);
    assert.deepEqual(parseSteps('30s, 5 1h 1d'), [0.5, 5, 60, 1440]);
    assert.equal(parseSteps('1m ten'), null);
    assert.equal(parseSteps('0m'), null);
  });

  it('reads the defaults the migration stores, and falls back on bad values', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const cfg = loadSchedulerConfig(db);
    assert.deepEqual([cfg.newPerDay, cfg.reviewsPerDay, cfg.learningSteps], [20, 200, [1, 10]]);
    assert.deepEqual(
      [cfg.graduatingInterval, cfg.easyInterval, cfg.startingEase, cfg.easyBonus, cfg.hardInterval, cfg.relearningSteps, cfg.lapseInterval, cfg.minInterval, cfg.maxInterval, cfg.dayStartHour, cfg.timeZone],
      [1, 4, 2.5, 1.3, 1.2, [10], 0, 1, 36500, 4, 'Asia/Manila'],
    );
    const set = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    set.run('flashcard_new_per_day', '5');
    set.run('flashcard_learning_steps', '2m 15m 1h');
    set.run('flashcard_reviews_per_day', 'lots');
    set.run('flashcard_starting_ease', '9');
    set.run('study_timezone', 'Not/AZone');
    const changed = loadSchedulerConfig(db);
    assert.deepEqual([changed.newPerDay, changed.learningSteps, changed.reviewsPerDay, changed.startingEase, changed.timeZone], [5, [2, 15, 60], 200, 2.5, 'Asia/Manila']);
    db.close();
  });
});
