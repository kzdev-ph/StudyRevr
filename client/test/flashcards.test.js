import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeCounts, describeNextDue, keyAction, RATINGS, spellInterval, studyMinutes, totalDue } from '../src/lib/flashcards.js';
import { parseRoute, paths, tabOf } from '../src/lib/router.js';

const opts = { timeZone: 'Asia/Manila', locale: 'en-US' };
const NOW = new Date('2026-10-05T04:00:00.000Z'); // noon, Oct 5, in Manila

describe('describeNextDue', () => {
  it('counts minutes for a card due within the hour', () => {
    assert.equal(describeNextDue('2026-10-05T04:25:00.000Z', NOW, opts), 'in 25 minutes');
    assert.equal(describeNextDue('2026-10-05T04:01:30.000Z', NOW, opts), 'in 2 minutes');
    assert.equal(describeNextDue('2026-10-05T04:00:30.000Z', NOW, opts), 'in a moment');
  });
  it('gives the time later today, tomorrow, or the date', () => {
    assert.equal(describeNextDue('2026-10-05T07:45:00.000Z', NOW, opts), 'today at 3:45 PM');
    assert.equal(describeNextDue('2026-10-05T20:00:00.000Z', NOW, opts), 'tomorrow at 4:00 AM');
    assert.equal(describeNextDue('2026-10-08T20:00:00.000Z', NOW, opts), 'on Fri, Oct 9');
  });
  it('is null when nothing is coming', () => {
    assert.equal(describeNextDue(null, NOW, opts), null);
  });
});

describe('keyAction', () => {
  const key = (k, extra = {}) => ({ key: k, code: k === ' ' ? 'Space' : `Key${k.toUpperCase()}`, target: { tagName: 'BODY' }, ...extra });

  it('Space flips the card; once the answer shows it does nothing', () => {
    assert.equal(keyAction(key(' '), { revealed: false }), 'flip');
    assert.equal(keyAction(key(' '), { revealed: true }), null);
  });
  it('Space on a focused button or link is left to the browser, which presses it', () => {
    assert.equal(keyAction(key(' ', { target: { tagName: 'BUTTON' } }), { revealed: false }), null);
    assert.equal(keyAction(key(' ', { target: { tagName: 'A' } }), { revealed: false }), null);
    assert.equal(keyAction(key('3', { target: { tagName: 'BUTTON' } }), { revealed: true }), 3, 'digits still answer');
  });
  it('1-4 answer only after the flip', () => {
    for (const n of [1, 2, 3, 4]) assert.equal(keyAction(key(String(n)), { revealed: true }), n);
    assert.equal(keyAction(key('3'), { revealed: false }), null);
    assert.equal(keyAction(key('5'), { revealed: true }), null);
  });
  it('Ctrl/Cmd+Z and U undo', () => {
    assert.equal(keyAction(key('z', { ctrlKey: true }), { revealed: false }), 'undo');
    assert.equal(keyAction(key('z', { metaKey: true }), { revealed: true }), 'undo');
    assert.equal(keyAction(key('u'), { revealed: false }), 'undo');
    assert.equal(keyAction(key('z', { ctrlKey: true, shiftKey: true }), { revealed: false }), null, 'redo is not undo');
  });
  it('leaves typing and other shortcuts alone', () => {
    assert.equal(keyAction(key(' ', { target: { tagName: 'INPUT' } }), { revealed: false }), null);
    assert.equal(keyAction(key('2', { target: { tagName: 'TEXTAREA' } }), { revealed: true }), null);
    assert.equal(keyAction(key('1', { altKey: true }), { revealed: true }), null);
    assert.equal(keyAction(key('r', { ctrlKey: true }), { revealed: true }), null);
  });
});

describe('counts', () => {
  it('estimates study time at about 10 seconds a card, at least a minute', () => {
    assert.equal(studyMinutes({ new: 20, learning: 0, due: 10 }), 5);
    assert.equal(studyMinutes({ new: 1, learning: 0, due: 0 }), 1);
    assert.equal(totalDue({ new: 2, learning: 1, due: 3 }), 6);
    assert.equal(totalDue(null), 0);
    assert.equal(describeCounts({ new: 2, learning: 1, due: 3 }), '2 new, 1 learning, 3 due');
    assert.equal(describeCounts({ new: 2, learning: 1, due: 3 }, 'learning'), '2 new, 1 learning, 3 due. This is a learning card.');
    assert.equal(describeCounts({ new: 0, learning: 0, due: 3 }, 'review'), '0 new, 0 learning, 3 due. This is a due card.');
    assert.equal(describeCounts({ new: 1, learning: 0, due: 0 }, undefined), '1 new, 0 learning, 0 due');
  });
  it('spells interval labels out for screen readers', () => {
    assert.equal(spellInterval('<1m'), 'less than a minute');
    assert.equal(spellInterval('1m'), '1 minute');
    assert.equal(spellInterval('10m'), '10 minutes');
    assert.equal(spellInterval('1.5h'), '1.5 hours');
    assert.equal(spellInterval('1d'), '1 day');
    assert.equal(spellInterval('4d'), '4 days');
    assert.equal(spellInterval('2.3mo'), '2.3 months');
    assert.equal(spellInterval('1y'), '1 year');
    assert.equal(spellInterval('soon'), 'soon', 'anything else is left as it is');
  });
  it('has the four Anki buttons in order', () => {
    assert.deepEqual(RATINGS.map((r) => `${r.rating}:${r.name}`), ['1:Again', '2:Hard', '3:Good', '4:Easy']);
  });
});

describe('flashcard routes', () => {
  it('parses decks and study sessions', () => {
    assert.deepEqual(parseRoute('#/flashcards'), { name: 'flashcards' });
    assert.deepEqual(parseRoute('#/flashcards/all'), { name: 'study', deck: 'all' });
    assert.deepEqual(parseRoute('#/flashcards/12'), { name: 'study', deck: 12 });
    assert.deepEqual(parseRoute('#/flashcards/nope'), { name: 'flashcards' });
    assert.deepEqual(parseRoute(paths.study(7)), { name: 'study', deck: 7 });
    assert.equal(tabOf(parseRoute('#/flashcards/all')), 'flashcards');
  });
});
