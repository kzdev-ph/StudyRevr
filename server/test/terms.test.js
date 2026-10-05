import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { groupTerms, termKey } from '../src/pipeline/terms.js';

describe('termKey', () => {
  it('ignores case, punctuation, spacing and plurals', () => {
    const same = [
      ['Media Channels', 'media channel'],
      ['media-channel!', 'MEDIA   CHANNELS'],
      ['Case Studies', 'case study'],
      ['Processes', 'process'],
      ['Classes', 'class'],
      ['Boxes', 'box'],
    ];
    for (const [a, b] of same) assert.equal(termKey(a), termKey(b), `${a} == ${b}`);
  });

  it('keeps different terms apart', () => {
    for (const [a, b] of [['Print Media', 'Digital Media'], ['Analysis', 'Analyst'], ['Class', 'Clash'], ['Bus', 'Bu']]) {
      assert.notEqual(termKey(a), termKey(b), `${a} != ${b}`);
    }
    assert.equal(termKey('Analysis'), 'analysis', '-is, -us and -ss words keep their s');
    assert.equal(termKey('Focus'), 'focus');
  });

  it('is empty for a term with no letters or digits', () => {
    assert.equal(termKey('---'), '');
  });
});

describe('groupTerms', () => {
  it('groups spellings of one term, keeps the first spelling and every version, and skips empty terms', () => {
    const groups = groupTerms([
      { term: 'Media Channels', definition: 'one', evidence: 'e1' },
      { term: 'Reach', definition: 'r', evidence: 'e2' },
      { term: 'media channel', definition: 'two', evidence: 'e3' },
      { term: '...', definition: 'x', evidence: 'e4' },
    ]);
    assert.deepEqual(groups, [
      { term: 'Media Channels', versions: [{ definition: 'one', evidence: 'e1' }, { definition: 'two', evidence: 'e3' }] },
      { term: 'Reach', versions: [{ definition: 'r', evidence: 'e2' }] },
    ]);
  });
});
