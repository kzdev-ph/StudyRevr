// Anki-style SM-2 scheduling. Pure: no database, no global clock. Every function takes `now` (a Date) and a config,
// and the interval fuzz comes from a seeded random generator, so the same card answered the same way at the same
// time always gets the same result (tests are deterministic, and the interval shown on a button is exactly the one
// the card gets).
//
// Card fields (the `flashcards` row): state, step, ease, interval (days), due_at (ISO or null), reps, lapses.
//   state 0 new, 1 learning, 2 review, 3 relearning; `step` is the index of the current (re)learning step.
//   A review card is due at the start of a study day; a (re)learning card is due at an exact time.
// The study day starts at `dayStartHour` (4:00) in `timeZone` (Asia/Manila), like Anki's "next day starts at".

export const NEW = 0;
export const LEARNING = 1;
export const REVIEW = 2;
export const RELEARNING = 3;

export const AGAIN = 1;
export const HARD = 2;
export const GOOD = 3;
export const EASY = 4;
export const RATINGS = [AGAIN, HARD, GOOD, EASY];

const MINUTE = 60_000;
const DAY = 86_400_000;

export const DEFAULT_CONFIG = Object.freeze({
  newPerDay: 20,
  reviewsPerDay: 200,
  learningSteps: [1, 10], // minutes
  relearningSteps: [10], // minutes
  graduatingInterval: 1, // days
  easyInterval: 4, // days
  startingEase: 2.5,
  easyBonus: 1.3,
  hardInterval: 1.2,
  lapseInterval: 0, // "new interval" after a lapse, as a share of the old one (then at least minInterval)
  minInterval: 1, // days
  maxInterval: 36500, // days
  minEase: 1.3,
  learnAheadMinutes: 20, // when nothing else is left, a learning card due this soon is shown now (Anki's default)
  dayStartHour: 4,
  timeZone: 'Asia/Manila',
  fuzzSeed: 0,
});

// ---- seeded randomness ------------------------------------------------------------------------------------------

// FNV-1a: a string -> 32-bit seed.
export function hashSeed(text) {
  let h = 0x811c9dc5;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32: small, fast, good enough for interval fuzz. -> () => number in [0, 1)
export function createRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One seed per card per answer: answering, previewing and undo-then-answering-again all agree.
export const seedFor = (card, config = DEFAULT_CONFIG) => hashSeed(`${config.fuzzSeed ?? 0}:${card.id ?? 0}:${card.reps ?? 0}`);

// Anki's fuzz range: none under 2 days, then about ±25% / ±15% / ±5% as the interval grows.
export function fuzzRange(ivl) {
  if (ivl < 2) return [ivl, ivl];
  if (ivl === 2) return [2, 3];
  let fuzz;
  if (ivl < 7) fuzz = Math.floor(ivl * 0.25);
  else if (ivl < 30) fuzz = Math.max(2, Math.floor(ivl * 0.15));
  else fuzz = Math.max(4, Math.floor(ivl * 0.05));
  fuzz = Math.max(fuzz, 1);
  return [ivl - fuzz, ivl + fuzz];
}

export function fuzzInterval(ivl, rng) {
  const [lo, hi] = fuzzRange(ivl);
  return lo + Math.floor(rng() * (hi - lo + 1));
}

// ---- study days -------------------------------------------------------------------------------------------------

// Milliseconds the zone's wall clock is ahead of UTC at `instant` (Manila: +8 h, no daylight saving).
function zoneOffset(instant, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const p = Object.fromEntries(fmt.formatToParts(instant).map(({ type, value }) => [type, Number(value)]));
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return wall - Math.floor(instant.getTime() / 1000) * 1000;
}

// The study day `now` falls in: { start, end } as Dates. Before 4:00 local time it is still the previous day.
export function studyDay(now, config = DEFAULT_CONFIG) {
  const { timeZone, dayStartHour } = { ...DEFAULT_CONFIG, ...config };
  const t = now.getTime();
  const offset = zoneOffset(now, timeZone);
  const local = new Date(t + offset);
  let start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), dayStartHour) - offset;
  if (start > t) start -= DAY;
  return { start: new Date(start), end: new Date(start + DAY) };
}

// ---- answering --------------------------------------------------------------------------------------------------

const clampStep = (step, steps) => Math.min(Math.max(0, step | 0), Math.max(0, steps.length - 1));

// Hard on a (re)learning card: on the first step, halfway between the first two steps (1.5x if there is only one,
// at most a day more); on a later step, the same step again. Anki v3 does the same.
function hardDelay(steps, step) {
  if (step > 0) return steps[step];
  if (steps.length > 1) return (steps[0] + steps[1]) / 2;
  return Math.min(steps[0] * 1.5, steps[0] + 1440);
}

// -> { card, newInterval, dueIn } after pressing `rating` on `card` at `now`.
//   card         the new scheduling fields: { state, step, ease, interval, due_at, reps, lapses }
//   newInterval  days until the card is next due; a learning step is a fraction of a day (for the review log)
//   dueIn        { minutes } for a (re)learning step or { days } for a review interval (what the button shows)
// `seed` overrides the per-card fuzz seed.
export function answer(card, rating, { now, config = DEFAULT_CONFIG, seed } = {}) {
  if (!RATINGS.includes(rating)) throw new RangeError(`rating must be 1-4, got ${rating}`);
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const rng = createRng(seed ?? seedFor(card, cfg));
  const t = now.getTime();
  const today = studyDay(now, cfg).start.getTime();
  const base = { state: card.state, step: card.step ?? 0, ease: card.ease, interval: card.interval ?? 0, reps: (card.reps ?? 0) + 1, lapses: card.lapses ?? 0 };

  const learnIn = (fields, minutes) => ({
    card: { ...base, ...fields, due_at: new Date(t + minutes * MINUTE).toISOString() },
    newInterval: minutes / 1440,
    dueIn: { minutes },
  });
  const reviewIn = (fields, days) => ({
    card: { ...base, ...fields, state: REVIEW, step: 0, interval: days, due_at: new Date(today + days * DAY).toISOString() },
    newInterval: days,
    dueIn: { days },
  });
  const limit = (days) => Math.min(Math.max(days, cfg.minInterval, 1), cfg.maxInterval);

  // new and learning cards walk the learning steps; relearning cards walk the relearning steps
  if (card.state === NEW || card.state === LEARNING || card.state === RELEARNING) {
    const relearning = card.state === RELEARNING;
    const steps = relearning ? cfg.relearningSteps : cfg.learningSteps;
    const step = clampStep(card.state === NEW ? 0 : card.step, steps);
    const state = relearning ? RELEARNING : LEARNING;
    const graduate = (easy) => {
      if (relearning) return reviewIn({}, limit(card.interval + (easy ? 1 : 0)));
      const ideal = easy ? cfg.easyInterval : cfg.graduatingInterval;
      return reviewIn({ ease: cfg.startingEase }, limit(fuzzInterval(ideal, rng)));
    };
    if (!steps.length || rating === EASY) return graduate(rating === EASY);
    if (rating === AGAIN) return learnIn({ state, step: 0 }, steps[0]);
    if (rating === HARD) return learnIn({ state, step }, hardDelay(steps, step));
    if (step + 1 < steps.length) return learnIn({ state, step: step + 1 }, steps[step + 1]);
    return graduate(false);
  }

  // review card
  const ivl = Math.max(card.interval, 1);
  const ease = card.ease;
  const dueDay = card.due_at ? studyDay(new Date(card.due_at), cfg).start.getTime() : today;
  const daysLate = Math.max(0, Math.round((today - dueDay) / DAY));

  if (rating === AGAIN) {
    const lapsed = { ease: Math.max(cfg.minEase, ease - 0.2), lapses: base.lapses + 1 };
    const days = limit(Math.floor(ivl * cfg.lapseInterval));
    if (!cfg.relearningSteps.length) return reviewIn(lapsed, days);
    return learnIn({ ...lapsed, state: RELEARNING, step: 0, interval: days }, cfg.relearningSteps[0]);
  }
  // Each button's interval is at least a day longer than the one before it (Anki's "constrained" interval).
  const constrained = (raw, prev) => limit(Math.max(fuzzInterval(Math.floor(raw), rng), prev + 1));
  const hard = constrained(ivl * cfg.hardInterval, ivl);
  if (rating === HARD) return reviewIn({ ease: Math.max(cfg.minEase, ease - 0.15) }, hard);
  const good = constrained((ivl + Math.floor(daysLate / 2)) * ease, hard);
  if (rating === GOOD) return reviewIn({}, good);
  const easy = constrained((ivl + daysLate) * ease * cfg.easyBonus, good);
  return reviewIn({ ease: ease + 0.15 }, easy);
}

// "<1m", "6m", "1.5h", "4d", "2.3mo", "1.1y"
export function formatInterval({ minutes, days }) {
  const round1 = (n) => String(Math.round(n * 10) / 10);
  if (days !== undefined) {
    if (days < 30) return `${Math.round(days)}d`;
    if (days < 365) return `${round1(days / 30)}mo`;
    return `${round1(days / 365)}y`;
  }
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 1440) return `${round1(minutes / 60)}h`;
  return formatInterval({ days: minutes / 1440 });
}

// What each button would do, for the labels: [{ rating, label, minutes? , days? }].
export function previewAnswers(card, { now, config = DEFAULT_CONFIG } = {}) {
  return RATINGS.map((rating) => {
    const { dueIn } = answer(card, rating, { now, config });
    return { rating, label: formatInterval(dueIn), ...dueIn };
  });
}

// ---- the daily queue --------------------------------------------------------------------------------------------

const dueTime = (c) => (c.due_at ? Date.parse(c.due_at) : 0);
const isLearning = (c) => c.state === LEARNING || c.state === RELEARNING;

// Which card to show next and the counts at the top of the screen.
//   cards      every card of the deck; new cards in the order they should be introduced
//   doneToday  { newCards, reviews } answered since the study day started: new cards introduced and review-card answers
// Order: (re)learning cards that are due, then due reviews (at most reviewsPerDay a day), then new cards (at most
// newPerDay a day); when nothing else is left, a learning card due within learnAheadMinutes. -> {
//   card, queue ('learning' | 'review' | 'new'), counts: { new, learning, due },
//   nextDueAt (Date | null, only when there is no card: when the next one becomes available), day: { start, end } }
export function buildQueue(cards, { now, config = DEFAULT_CONFIG, doneToday = { newCards: 0, reviews: 0 } } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const day = studyDay(now, cfg);
  const t = now.getTime();
  const ahead = t + cfg.learnAheadMinutes * MINUTE;
  const byDue = (a, b) => dueTime(a) - dueTime(b) || a.id - b.id;

  const learning = cards.filter(isLearning).sort(byDue);
  const learningNow = learning.filter((c) => dueTime(c) <= t);
  const learningSoon = learning.filter((c) => dueTime(c) <= ahead);
  const dueReviews = cards.filter((c) => c.state === REVIEW && dueTime(c) < day.end.getTime()).sort(byDue);
  const reviews = dueReviews.slice(0, Math.max(0, cfg.reviewsPerDay - doneToday.reviews));
  const allNew = cards.filter((c) => c.state === NEW);
  const fresh = allNew.slice(0, Math.max(0, cfg.newPerDay - doneToday.newCards));

  const counts = { new: fresh.length, learning: learningSoon.length, due: reviews.length };
  let card = null;
  let queue = null;
  if (learningNow.length) [card, queue] = [learningNow[0], 'learning'];
  else if (reviews.length) [card, queue] = [reviews[0], 'review'];
  else if (fresh.length) [card, queue] = [fresh[0], 'new'];
  else if (learningSoon.length) [card, queue] = [learningSoon[0], 'learning'];

  let nextDueAt = null;
  if (!card) {
    const times = [];
    if (learning.length) times.push(dueTime(learning[0]));
    const later = cards.filter((c) => c.state === REVIEW && dueTime(c) >= day.end.getTime()).sort(byDue);
    if (later.length) times.push(dueTime(later[0]));
    // cards held back by a daily limit come back when the next study day starts
    if (dueReviews.length > reviews.length || allNew.length > fresh.length) times.push(day.end.getTime());
    if (times.length) nextDueAt = new Date(Math.min(...times));
  }
  return { card, queue, counts, nextDueAt, day };
}

// The queue a card belongs to (for a card shown out of order, e.g. after Undo).
export const queueOf = (card) => (card.state === NEW ? 'new' : isLearning(card) ? 'learning' : 'review');
