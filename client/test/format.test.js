import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prettyTitle, readingMinutes, splitSentences, splitWall, toBlocks, truncateAtWord } from '../src/lib/format.js';

const sentence = (n) => `Sentence number ${n} explains one small idea about the topic in plain words.`;
const wall = Array.from({ length: 8 }, (_, i) => sentence(i + 1)).join(' ');

describe('splitSentences', () => {
  it('splits at sentence ends', () => {
    assert.deepEqual(splitSentences('One is here. Two is here! Is three here? Yes.'), ['One is here.', 'Two is here!', 'Is three here?', 'Yes.']);
  });
  it('does not split after abbreviations, initials or decimals', () => {
    assert.deepEqual(splitSentences('Use a sample, e.g. Grade 11 students. Dr. Cruz agrees. It scored 3.5 overall.'), [
      'Use a sample, e.g. Grade 11 students.',
      'Dr. Cruz agrees.',
      'It scored 3.5 overall.',
    ]);
  });
});

describe('splitWall', () => {
  it('leaves a normal paragraph alone', () => {
    assert.deepEqual(splitWall(sentence(1) + ' ' + sentence(2)), [sentence(1) + ' ' + sentence(2)]);
  });
  it('splits a wall of text into short paragraphs without losing a word', () => {
    const parts = splitWall(wall);
    assert.ok(parts.length >= 2);
    assert.ok(parts.every((p) => p.length < 340), 'every piece is short');
    assert.equal(parts.join(' '), wall);
  });
  it('keeps a long text with no sentence break whole', () => {
    const blob = 'word '.repeat(150).trim();
    assert.deepEqual(splitWall(blob), [blob]);
  });
});

describe('toBlocks', () => {
  it('turns lines into paragraphs and "- " runs into one list', () => {
    assert.deepEqual(toBlocks('Intro line.\n\nSteps:\n- First\n- Second\n\nWrap up.'), [
      { type: 'p', text: 'Intro line.' },
      { type: 'p', text: 'Steps:' },
      { type: 'ul', items: ['First', 'Second'] },
      { type: 'p', text: 'Wrap up.' },
    ]);
  });
  it('splits a dense paragraph for display only (the input string is unchanged)', () => {
    const input = `${wall}\n\nShort one.`;
    const blocks = toBlocks(input);
    assert.ok(blocks.length >= 4);
    assert.equal(blocks.at(-1).text, 'Short one.');
    assert.equal(input.startsWith('Sentence number 1'), true);
  });
  it('splits a bulleted list the model wrote on one line', () => {
    assert.deepEqual(toBlocks('- You feel scared. You face challenges. - You pick a topic. - The journey needs planning.'), [
      { type: 'ul', items: ['You feel scared. You face challenges.', 'You pick a topic.', 'The journey needs planning.'] },
    ]);
  });
  it('does not treat a dash inside a sentence as a bullet', () => {
    assert.deepEqual(toBlocks('Methods - such as surveys - vary. Costs - low or high - differ.'), [{ type: 'p', text: 'Methods - such as surveys - vary. Costs - low or high - differ.' }]);
  });
  it('copes with empty input', () => {
    assert.deepEqual(toBlocks(''), []);
    assert.deepEqual(toBlocks(null), []);
  });
});

describe('truncateAtWord', () => {
  it('returns short text as is, with spaces tidied', () => {
    assert.equal(truncateAtWord('A short  quote.', 50), 'A short quote.');
  });
  it('cuts at a word boundary and adds an ellipsis', () => {
    const out = truncateAtWord('Research is a systematic investigation into a question', 30);
    assert.equal(out, 'Research is a systematic…');
    assert.ok(out.length <= 31);
  });
  it('does not drop a word that ends exactly at the limit', () => {
    assert.equal(truncateAtWord('alpha beta gamma delta', 10), 'alpha beta…');
  });
  it('drops trailing punctuation before the ellipsis', () => {
    assert.equal(truncateAtWord('one two, three four five six', 9), 'one two…');
  });
  it('cuts a single very long word at the limit', () => {
    assert.equal(truncateAtWord('Supercalifragilisticexpialidocious', 10), 'Supercalif…');
  });
});

describe('prettyTitle', () => {
  it('turns file-name underscores into spaces', () => {
    assert.equal(prettyTitle('Nature_of_Inquiry__and_Research'), 'Nature of Inquiry and Research');
    assert.equal(prettyTitle('Already fine'), 'Already fine');
  });
});

describe('readingMinutes', () => {
  it('is at least 1 and grows with the text', () => {
    assert.equal(readingMinutes([{ title: 'T', content: 'few words' }]), 1);
    assert.equal(readingMinutes([{ title: 'T', content: 'word '.repeat(1000) }]), 5);
  });
});
