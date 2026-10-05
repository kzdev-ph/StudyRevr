import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { exactSource, formatNumbers, matchSource, numberedBlocks, sourceLabel, splitBlocks } from '../src/lib/source.js';

const slides = [
  'Welcome to Practical Research\nMrs. Reyes\nGrade 12',
  'Variables\n- An independent variable is changed by the researcher\n- A dependent variable is measured as the outcome',
  'Sampling\nProbability sampling gives every member of the population an equal chance of selection\nNon-probability sampling relies on convenience or judgment',
  'Data collection\nSurveys and interviews gather responses from participants',
  'Thank you',
].join('\n\n');

describe('matchSource', () => {
  it('finds the slide a section was written from', () => {
    const hit = matchSource('Variables: the independent variable is what the researcher changes, and the dependent variable is the outcome that is measured.', slides);
    assert.deepEqual(hit.map((b) => b.index), [1]);
    assert.match(hit[0].text, /independent variable/);
  });

  it('returns several slides, in file order, when a section spans them', () => {
    const hit = matchSource('Probability sampling gives each member of the population an equal chance, while non-probability sampling relies on convenience. Surveys and interviews gather responses from participants.', slides);
    assert.deepEqual(hit.map((b) => b.index), [2, 3]);
  });

  it('finds nothing for text that is not in the file', () => {
    assert.deepEqual(matchSource('Photosynthesis converts sunlight into glucose inside chloroplasts.', slides), []);
  });

  it('copes with empty input', () => {
    assert.deepEqual(matchSource('', slides), []);
    assert.deepEqual(matchSource('Variables', ''), []);
  });
});

describe('splitBlocks', () => {
  it('splits on blank lines and drops empty blocks', () => {
    assert.deepEqual(splitBlocks('a\nb\n\n\n c \n\n'), ['a\nb', 'c']);
  });
});

// A deck of 6 slides where slides 2 and 5 had no text, so raw_text holds 4 blocks that are slides 1, 3, 4 and 6.
const deck = ['Welcome', 'Variables', 'Sampling', 'Thank you'].map((title) => `${title}\n- ${title} item`);
const deckText = deck.join('\n\n');
const deckSource = { kind: 'slide', total: 6, numbers: [1, 3, 4, 6] };

describe('numberedBlocks', () => {
  it('pairs every block of the file with its real slide number', () => {
    assert.deepEqual(numberedBlocks(deckText, deckSource).map((b) => b.number), [1, 3, 4, 6]);
    assert.equal(numberedBlocks(deckText, deckSource)[1].text, deck[1]);
  });

  it('is null when the lesson has no record, or the numbers do not line up with the blocks', () => {
    assert.equal(numberedBlocks(deckText, null), null);
    assert.equal(numberedBlocks(deckText, { kind: 'slide', total: 6, numbers: [1, 3] }), null);
  });
});

describe('exactSource', () => {
  it('returns exactly the slides the section names, in file order, found by real number (not by position)', () => {
    const hit = exactSource([4, 3], deckText, deckSource);
    assert.deepEqual(hit.map((b) => b.number), [3, 4]);
    assert.match(hit[0].text, /^Variables/, "slide 3 is the second block of text, because slide 2 had none");
  });

  it('ignores a number that has no text in the file', () => {
    assert.deepEqual(exactSource([2, 6], deckText, deckSource).map((b) => b.number), [6]);
  });

  it('is null (so the caller falls back to the approximate match) without sources, without a record, or with no usable number', () => {
    assert.equal(exactSource(null, deckText, deckSource), null);
    assert.equal(exactSource([], deckText, deckSource), null);
    assert.equal(exactSource([3], deckText, null), null);
    assert.equal(exactSource([2, 5], deckText, deckSource), null);
  });
});

describe('formatNumbers and sourceLabel', () => {
  it('joins runs into ranges', () => {
    assert.equal(formatNumbers([3, 4, 5, 8]), '3–5, 8');
    assert.equal(formatNumbers([7, 3, 3]), '3, 7');
    assert.equal(formatNumbers([3, 4]), '3, 4');
    assert.equal(formatNumbers([9]), '9');
  });

  it('names the kind, singular or plural', () => {
    assert.equal(sourceLabel('slide', [3]), 'Slide 3');
    assert.equal(sourceLabel('slide', [3, 4, 5]), 'Slides 3–5');
    assert.equal(sourceLabel('page', [2, 6]), 'Pages 2, 6');
    assert.equal(sourceLabel('paragraph', [12]), 'Paragraph 12');
  });
});
