import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cardsLine, pct, studyTime, weekday, weekRows } from '../src/lib/stats.js';
import { sessionRecap } from '../src/lib/flashcards.js';
import { normalizeCode } from '../src/lib/participant.js';

const MIN = 60_000;

describe('stats helpers', () => {
  it('writes study time in words', () => {
    assert.equal(studyTime(0), '0 min');
    assert.equal(studyTime(20_000), '<1 min');
    assert.equal(studyTime(12 * MIN), '12 min');
    assert.equal(studyTime(65 * MIN), '1 h 5 min');
    assert.equal(studyTime(120 * MIN), '2 h');
  });

  it('turns the week into chart rows in minutes', () => {
    assert.equal(weekday('2026-10-05'), 'Mon');
    assert.deepEqual(weekRows([{ date: '2026-10-05', reading_ms: 10 * MIN, flashcards_ms: 90_000, quiz_ms: 0 }]), [
      { date: '2026-10-05', day: 'Mon', reading: 10, flashcards: 1.5, quiz: 0, total: 11.5 },
    ]);
  });

  it('percentages and the cards line', () => {
    assert.equal(pct(null), '–');
    assert.equal(pct(66.7), '67%');
    assert.equal(cardsLine({ reviewed: 0, good_easy_pct: null }), 'No cards yet');
    assert.equal(cardsLine({ reviewed: 1, good_easy_pct: 100 }), '1 card, 100% Good or Easy');
  });
});

describe('flashcard done-state recap', () => {
  it('counts answers, time and the share answered Good or Easy', () => {
    assert.deepEqual(sessionRecap([3, 4, 1, 2], 5 * MIN), { cards: 4, timeMs: 5 * MIN, goodEasyPct: 50 });
    assert.deepEqual(sessionRecap([], 0), { cards: 0, timeMs: 0, goodEasyPct: null });
    // an undone answer is removed from the list before the recap
    assert.deepEqual(sessionRecap([3, 3, 1].slice(0, -1), MIN), { cards: 2, timeMs: MIN, goodEasyPct: 100 });
  });
});

describe('participant codes (client)', () => {
  it('normalizes like the server', () => {
    for (const typed of ['P07', 'p7', ' P 7 ', 'P007']) assert.equal(normalizeCode(typed), 'P07');
    for (const bad of ['', '07', 'Ana', 'P1234']) assert.equal(normalizeCode(bad), null);
  });
});
