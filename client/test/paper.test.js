import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loopPath, riffleFrames } from '../src/lib/paper.js';
import { daySegments } from '../src/lib/stats.js';
import { comesBackToday } from '../src/lib/flashcards.js';
import { bubbleStates } from '../src/lib/quiz.js';

describe('paper motion helpers', () => {
  it('riffle keyframes: two per riffle, ending back on the pile, times from 0 to 1', () => {
    const f = riffleFrames(1, 5, 3);
    for (const key of ['x', 'y', 'rotate', 'zIndex', 'times']) assert.equal(f[key].length, 7, key);
    assert.equal(f.x.at(-1), 0);
    assert.equal(f.y.at(-1), f.y[0]);
    assert.equal(f.times[0], 0);
    assert.equal(f.times.at(-1), 1);
    assert.ok(f.times.every((t, k) => k === 0 || t > f.times[k - 1]));
    // the halves change places on each riffle: every zIndex stays a place in the pile
    assert.ok(f.zIndex.every((z) => Number.isInteger(z) && z >= 0 && z < 5));
    assert.notEqual(f.zIndex[2], f.zIndex[0]);
  });

  it('pen loop: one path of curves, inside its box give or take the pen overshoot', () => {
    const d = loopPath(40, 34);
    assert.match(d, /^M[\d.]+ [\d.]+( C[\d. -]+)+$/);
    const nums = d.match(/-?[\d.]+/g).map(Number);
    assert.ok(nums.every((n) => n > -6 && n < 46));
  });
});

describe('stats day bars', () => {
  it('a zero, missing or broken value never becomes a piece of the bar (no stray "0" on screen)', () => {
    const scale = 60;
    assert.deepEqual(daySegments({ reading: 0, flashcards: 0, quiz: 0 }, scale), []);
    assert.deepEqual(daySegments({ reading: undefined, flashcards: null, quiz: Number.NaN }, scale), []);
    const segs = daySegments({ reading: 30, flashcards: 0, quiz: 15 }, scale);
    assert.deepEqual(
      segs.map((s) => [s.key, s.width]),
      [
        ['reading', '50%'],
        ['quiz', '25%'],
      ],
    );
    // every piece is an object to draw, never a number React would print
    assert.ok(segs.every((s) => typeof s === 'object' && s.width !== '0%'));
  });

  it('an empty week (busiest day 0) still divides safely', () => {
    assert.deepEqual(daySegments({ reading: 0, flashcards: 0, quiz: 0 }, 0), []);
    assert.equal(daySegments({ reading: 5, flashcards: 0, quiz: 0 }, 5)[0].width, '100%');
  });
});

describe('where an answered flashcard goes', () => {
  it('back under the deck when it comes back within the day, onto the pile when it waits a day or more', () => {
    assert.equal(comesBackToday({ rating: 1, label: '1m', minutes: 1 }), true);
    assert.equal(comesBackToday({ rating: 3, label: '10m', minutes: 10 }), true);
    assert.equal(comesBackToday({ rating: 2, label: '5.5h', minutes: 330 }), true);
    assert.equal(comesBackToday({ rating: 3, label: '1d', minutes: 1440 }), false);
    assert.equal(comesBackToday({ rating: 4, label: '4d', days: 4 }), false);
    assert.equal(comesBackToday(undefined), false);
  });
});

describe('quiz answer sheet', () => {
  it('answered bubbles filled, the open question ringed', () => {
    assert.deepEqual(bubbleStates(4, 0, 0), ['now', 'todo', 'todo', 'todo']);
    assert.deepEqual(bubbleStates(4, 2, 2), ['done', 'done', 'now', 'todo']);
    // feedback showing: the open question is answered
    assert.deepEqual(bubbleStates(4, 3, 2), ['done', 'done', 'done', 'todo']);
    assert.deepEqual(bubbleStates(0, 0, 0), []);
  });
});
