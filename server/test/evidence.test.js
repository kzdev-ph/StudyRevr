import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkEvidence, comparable, MAX_EVIDENCE_WORDS } from '../src/pipeline/evidence.js';

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
