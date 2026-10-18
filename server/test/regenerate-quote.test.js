// Regenerate's quote check (services/regenerate-card.js checkNewCard, shared with the AI review's card rewrite): like
// generation, a concept card's quote needs 2 words besides the question's, and a quote that is a whole list line needs
// only 1. The Gemini audit (2026-10-18) found the old 3 refusing the very card the flashcards prompt now asks for: a
// list item split into its verb in the question and the rest in the answer leaves one word to quote.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkNewCard, isListLine } from '../src/services/regenerate-card.js';

const TEXT = `Purpose of Data Collection
- Answer research questions
- Test hypotheses
- Draw conclusions
- Make informed decisions

Interviews explore personal experiences in depth. Interviews explore experiences slowly.

Importance of Data Quality
Accurate — reflects the information being studied
Reliable — produces consistent results
Relevant — directly relates to the research questions`;

const card = { id: 1, kind: 'concept', front: 'Old question?', back: 'Old answer', evidence: 'Test hypotheses' };
const check = (question, answer, evidence) => checkNewCard({ card, reply: { question, answer, evidence }, rawText: TEXT, others: [] });

describe('Regenerate: the new card’s quote', () => {
  it('a whole list line is enough with one word besides the question’s', () => {
    const next = check('What does the collected data help researchers test?', 'Hypotheses', 'Test hypotheses');
    assert.equal(next.evidence, 'Test hypotheses');
    assert.equal(next.back, 'Hypotheses');
    assert.ok(isListLine(TEXT, '- Test hypotheses'), 'with its bullet');
    assert.ok(isListLine(TEXT, 'Reliable — produces consistent results'), 'a "Name — what it means" line');
  });

  it('any other quote needs 2 words besides the question’s, as at generation', () => {
    assert.equal(check('What do interviews explore in depth?', 'Personal experiences', 'Interviews explore personal experiences in depth').evidence, 'Interviews explore personal experiences in depth');
    assert.throws(() => check('What do interviews explore slowly?', 'Experiences', 'Interviews explore experiences slowly'), (err) => err.status === 422 && /only the term or a title/.test(err.message));
  });

  it('part of a list line, or a list line not in the lesson, is not a whole list line', () => {
    assert.equal(isListLine(TEXT, 'hypotheses'), false);
    assert.equal(isListLine(TEXT, 'Test theories'), false);
    assert.equal(isListLine(TEXT, 'Interviews explore personal experiences in depth.'), false, 'a sentence, not a list line');
    assert.throws(() => check('What consistent results does reliable data give?', 'It produces them', 'produces consistent results'), /only the term or a title/, 'part of a list line');
  });
});
