import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchSource, splitBlocks } from '../src/lib/source.js';

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
