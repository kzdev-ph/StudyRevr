import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkEvidence, comparable, MAX_CHECK_EVIDENCE_WORDS, MAX_EVIDENCE_WORDS, trimQuote } from '../src/pipeline/evidence.js';

const source = [
  'Research Basics',
  '- A hypothesis is a tentative answer to a research question.',
  '2. Case studies are in-depth investigations of a single social unit, using inter-',
  'views and observations.',
  'Quantitative | numbers, large samples',
].join('\n');
const sourceKey = comparable(source);
const check = (term, evidence) => checkEvidence({ term, evidence, sourceKey });

describe('checkEvidence', () => {
  it('accepts an exact quote and ignores case, spacing, punctuation and bullets', () => {
    assert.equal(check('Hypothesis', 'A hypothesis is a tentative answer to a research question.').ok, true);
    assert.equal(check('Hypothesis', 'a  HYPOTHESIS is a tentative   answer to a research question').ok, true);
    assert.equal(check('Hypothesis', '- A hypothesis is a tentative answer').ok, true);
    assert.equal(check('Quantitative', 'Quantitative | numbers, large samples').ok, true);
  });

  it('accepts a quote that spans lines and one that joins a line-end hyphen break', () => {
    assert.equal(check('Case study', 'Case studies are in-depth investigations of a single social unit, using interviews and observations.').ok, true);
    assert.equal(check('Case study', 'investigations of a single social unit, using inter- views and observations').ok, true);
  });

  it('rejects a quote that is not in the lesson (paraphrase, invented, stitched together)', () => {
    assert.deepEqual(check('Hypothesis', 'A hypothesis is an educated guess about a research problem.'), { ok: false, reason: 'evidence not found in the lesson text' });
    assert.equal(check('Hypothesis', 'A hypothesis is a tentative answer ... using interviews and observations').ok, false);
  });

  it('rejects an empty quote, and a quote that is only the term or a heading', () => {
    assert.equal(check('Hypothesis', '').reason, 'no evidence quote');
    assert.equal(check('Hypothesis', undefined).reason, 'no evidence quote');
    assert.equal(check('Research Basics', 'Research Basics').reason, 'evidence is only the term or a title');
    assert.equal(check('Quantitative', 'Quantitative | numbers').reason, 'evidence is only the term or a title');
  });

  it('keeps at most 25 words of a longer verbatim quote', () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const out = checkEvidence({ term: 'x', evidence: long, sourceKey: comparable(`Intro. ${long} Outro.`) });
    assert.equal(out.ok, true);
    assert.equal(out.evidence.split(' ').length, MAX_EVIDENCE_WORDS);
    assert.ok(out.evidence.startsWith('word0 word1'));
  });

  it('works with Filipino and accented text', () => {
    const key = comparable('Ang pananaliksik ay sistematikong pagsisiyasat. Café résumé naïve.');
    assert.equal(checkEvidence({ term: 'Pananaliksik', evidence: 'ay sistematikong pagsisiyasat', sourceKey: key }).ok, true);
    assert.equal(checkEvidence({ term: 'x', evidence: 'CAFÉ RÉSUMÉ naïve', sourceKey: key }).ok, true);
  });
});

describe('trimQuote: a long quote ends where a sentence or clause ends', () => {
  const run = (n, tail = '') => Array.from({ length: n }, (_, i) => `w${i + 1}`).join(' ') + tail;
  const count = (s) => s.split(' ').length;

  it('leaves a quote within the limit alone', () => {
    assert.equal(trimQuote(run(25), 25), run(25));
    assert.equal(trimQuote('Short one.', 25), 'Short one.');
  });

  it('cuts at the last sentence end that fits', () => {
    const quote = `${run(12, '.')} ${run(10, '.')} ${run(20)}`;
    assert.equal(trimQuote(quote, 25), `${run(12, '.')} ${run(10, '.')}`);
  });

  it('falls back to the last comma, then to the next sentence end a little past the limit, then to the limit', () => {
    assert.equal(trimQuote(`${run(15, ',')} ${run(20)}`, 25), run(15, ','));
    const longSentence = `${run(30, '.')} more`;
    assert.equal(count(trimQuote(longSentence, 25)), 30, 'the sentence is finished rather than cut mid-phrase');
    assert.equal(count(trimQuote(run(80), 25)), 25, 'no boundary anywhere near: the limit');
  });

  it('never cuts to a tiny fragment', () => {
    const quote = `Yes. ${run(40)}`;
    assert.equal(count(trimQuote(quote, 25)), 25, 'a 1-word sentence is not a place to stop');
  });

  it('checkEvidence uses it, and a quick check may keep up to 40 words', () => {
    const quote = `${run(28, '.')} ${run(30)}`;
    const key = comparable(`Intro. ${quote} Outro.`);
    const card = checkEvidence({ term: 'x', evidence: quote, sourceKey: key });
    assert.equal(card.evidence, run(28, '.'), 'a card quote ends at the sentence, a little past 25 words');
    const check = checkEvidence({ term: 'x', evidence: quote, sourceKey: key, maxWords: MAX_CHECK_EVIDENCE_WORDS });
    assert.equal(check.evidence, run(28, '.'));
    assert.ok(MAX_CHECK_EVIDENCE_WORDS > MAX_EVIDENCE_WORDS);
  });
});

describe('checkEvidence: formulas', () => {
  const formulaKey = comparable('Newton\'s second law\nF = ma\n\nArea of a circle\nA = πr²\n\nThe law of motion.');
  const run = (term, evidence) => checkEvidence({ term, evidence, sourceKey: formulaKey });

  it('a quote that holds an equation needs only one explaining word', () => {
    assert.equal(run('Newton\'s second law', 'F = ma').ok, true);
    assert.equal(run('Area of a circle', 'A = πr²').ok, true);
  });

  it('a short quote without an equation still fails', () => {
    assert.equal(run('Newton\'s second law', 'The law').ok, false);
    assert.equal(run('Area of a circle', 'The law').reason, 'evidence is only the term or a title');
  });
});
