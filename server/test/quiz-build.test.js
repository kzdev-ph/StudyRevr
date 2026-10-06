import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/flashcards/scheduler.js';
import { buildQuiz, reshuffle, sameAnswer, shuffle, TF_CHOICES, usableCount, usableWrong } from '../src/quiz/build.js';

const seeded = (seed = 1) => createRng(seed);

const term = (id, front, back) => ({ id, kind: 'term', front, back, evidence: `${front} quote` });
const concept = (id, n = id) => ({ id, kind: 'concept', front: `Question ${n}?`, back: `Answer ${n}.`, evidence: `quote ${n}` });
const TERMS = [
  term(1, 'Hypothesis', 'A testable prediction about variables.'),
  term(2, 'Independent variable', 'The factor the researcher changes.'),
  term(3, 'Dependent variable', 'The factor that is measured.'),
  term(4, 'Population', 'The whole group the study is about.'),
  term(5, 'Sample', 'The part of the population that is studied.'),
];
const CONCEPTS = Array.from({ length: 8 }, (_, i) => concept(10 + i, i + 1));
const wrongFor = (cards) => new Map(cards.map((c) => [c.id, [`Wrong A for ${c.id}`, `Wrong B for ${c.id}`, `Wrong C for ${c.id}`]]));

describe('quiz building', () => {
  it('compares answers ignoring case and surrounding spaces', () => {
    assert.ok(sameAnswer('  The Sample ', 'the sample'));
    assert.ok(sameAnswer('the  sample', 'the sample'));
    assert.ok(!sameAnswer('the sample.', 'the samples.'));
  });

  it('drops wrong answers that match the correct answer or each other, and blanks', () => {
    assert.deepEqual(usableWrong(['Answer 1.', ' answer 1. ', 'Other', 'OTHER ', '', 'Third', 'Fourth', 'Fifth'], 'Answer 1.'), ['Other', 'Third', 'Fourth']);
    assert.deepEqual(usableWrong(undefined, 'x'), []);
  });

  it('makes 10 questions: multiple choice where possible, about 3 true / false', () => {
    const qs = buildQuiz({ cards: [...TERMS, ...CONCEPTS], distractors: wrongFor(CONCEPTS), random: seeded(7) });
    assert.equal(qs.length, 10);
    assert.equal(qs.filter((q) => q.type === 'tf').length, 3);
    assert.equal(new Set(qs.map((q) => q.flashcard_id)).size, 10, 'each card at most once');
    for (const q of qs) {
      if (q.type === 'mc') {
        assert.equal(q.choices.length, 4);
        assert.equal(new Set(q.choices.map((c) => c.toLowerCase())).size, 4);
        assert.equal(q.choices[q.answer_index], q.answer_text);
      } else {
        assert.deepEqual(q.choices, TF_CHOICES);
        assert.equal(q.answer_index === 0, q.statement === q.answer_text, 'True exactly when the statement is the real answer');
      }
    }
  });

  it('term questions: the definition is asked, the wrong options are other key terms of the lesson', () => {
    const qs = buildQuiz({ cards: TERMS, random: seeded(3), count: 5 }).filter((q) => q.type === 'mc');
    assert.ok(qs.length > 0);
    const names = TERMS.map((t) => t.front);
    for (const q of qs) {
      const card = TERMS.find((t) => t.id === q.flashcard_id);
      assert.equal(q.question, card.back);
      assert.equal(q.answer_text, card.front);
      for (const c of q.choices) assert.ok(names.includes(c));
    }
  });

  it('key terms without a card count as wrong options, but a plural of the right term does not', () => {
    const cards = [term(1, 'Hypothesis', 'A testable prediction.'), term(2, 'Sample', 'Part of the population.')];
    const qs = buildQuiz({ cards, extraTerms: ['Hypotheses', 'Variable', 'Population', 'Data'], count: 2, random: seeded(2) });
    const mc = qs.find((q) => q.flashcard_id === 1);
    assert.equal(mc.type, 'mc', 'enough other terms with the extra key terms');
    assert.ok(!mc.choices.includes('Hypotheses'));
  });

  it('with fewer than 3 other terms, a term question is true / false against another card’s definition', () => {
    const cards = TERMS.slice(0, 3);
    const qs = buildQuiz({ cards, random: seeded(5) });
    assert.equal(qs.length, 3);
    for (const q of qs) {
      assert.equal(q.type, 'tf');
      const card = cards.find((t) => t.id === q.flashcard_id);
      assert.equal(q.question, card.front);
      assert.ok(cards.some((c) => c.back === q.statement));
    }
    assert.ok(qs.some((q) => q.answer_index === 1), 'some statements are false');
  });

  it('a concept card without saved wrong answers is true / false; its false statement is another card’s answer', () => {
    let falseSeen = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const qs = buildQuiz({ cards: CONCEPTS.slice(0, 4), random: seeded(seed) });
      assert.equal(qs.length, 4);
      for (const q of qs) {
        assert.equal(q.type, 'tf');
        if (q.answer_index === 1) {
          falseSeen++;
          assert.notEqual(q.statement, q.answer_text);
          assert.ok(CONCEPTS.slice(0, 4).some((c) => c.back === q.statement && c.id !== q.flashcard_id));
        }
      }
    }
    assert.ok(falseSeen > 0);
  });

  it('with 1-2 saved wrong answers the false statement comes from them', () => {
    const cards = CONCEPTS.slice(0, 2);
    const distractors = new Map([[cards[0].id, ['Saved wrong']], [cards[1].id, ['Other saved', 'Answer 2.']]]);
    for (let seed = 1; seed <= 10; seed++) {
      for (const q of buildQuiz({ cards, distractors, random: seeded(seed) })) {
        if (q.answer_index === 1) assert.equal(q.statement, q.flashcard_id === cards[0].id ? 'Saved wrong' : 'Other saved');
      }
    }
  });

  it('a short lesson gets fewer questions instead of failing; a single card gets none', () => {
    assert.equal(buildQuiz({ cards: CONCEPTS.slice(0, 6), distractors: wrongFor(CONCEPTS) }).length, 6);
    assert.deepEqual(buildQuiz({ cards: [concept(1)] }), []);
    assert.equal(usableCount([concept(1)]), 0);
    assert.equal(usableCount([concept(1), concept(2)]), 2);
    // two cards with the same answer cannot be wrong against each other
    assert.equal(usableCount([concept(1), { ...concept(2), back: 'answer 1.' }]), 0);
  });

  it('is deterministic for the same random source', () => {
    const make = () => buildQuiz({ cards: [...TERMS, ...CONCEPTS], distractors: wrongFor(CONCEPTS), random: seeded(42) });
    assert.deepEqual(make(), make());
  });

  it('a retake keeps the same questions and answers, in a new order with options moved', () => {
    const first = buildQuiz({ cards: [...TERMS, ...CONCEPTS], distractors: wrongFor(CONCEPTS), random: seeded(9) });
    const again = reshuffle(first, seeded(10));
    const byCard = (qs) => Object.fromEntries(qs.map((q) => [q.flashcard_id, q]));
    assert.deepEqual(Object.keys(byCard(again)).sort(), Object.keys(byCard(first)).sort());
    assert.notDeepEqual(again.map((q) => q.flashcard_id), first.map((q) => q.flashcard_id));
    for (const q of again) {
      const before = byCard(first)[q.flashcard_id];
      assert.equal(q.choices[q.answer_index], before.choices[before.answer_index]);
      assert.deepEqual([...q.choices].sort(), [...before.choices].sort());
      if (q.type === 'tf') assert.deepEqual(q.choices, TF_CHOICES);
    }
  });

  it('shuffle keeps every item', () => {
    assert.deepEqual(shuffle([1, 2, 3, 4, 5], seeded(1)).sort(), [1, 2, 3, 4, 5]);
  });
});
