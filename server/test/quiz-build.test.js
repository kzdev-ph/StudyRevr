import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/flashcards/scheduler.js';
import { buildQuiz, hasBlank, hasText, quizCandidates, reshuffle, sameAnswer, shuffle, TF_CHOICES, usableCount, usableWrong } from '../src/quiz/build.js';
import { questionLeaks } from '../src/quiz/leaks.js';
import { distractorMap, EN_LESSON, FIL_LESSON } from './fixtures/leak-lessons.js';

const seeded = (seed = 1) => createRng(seed);

const term = (id, front, back) => ({ id, kind: 'term', front, back, evidence: `${front} quote` });
// every concept card is about "the topic", so another card's answer is a believable false statement for it; each
// answer has a word of its own (two answers that differ only in a number would be one answer to the leak checks)
const NAMES = 'rivers mountains forests deserts islands valleys oceans glaciers meadows canyons volcanoes beaches'.split(' ');
const concept = (id, n = id) => ({ id, kind: 'concept', front: `Question ${n} about the topic?`, back: `Topic answer number ${n}: ${NAMES[n % NAMES.length]}.`, evidence: `quote ${n}` });
const TERMS = [
  term(1, 'Hypothesis', 'A testable prediction about variables.'),
  term(2, 'Independent variable', 'The factor the researcher changes.'),
  term(3, 'Dependent variable', 'The factor that is measured.'),
  term(4, 'Population', 'The whole group the study is about.'),
  term(5, 'Sample', 'The part of the population that is studied.'),
];
const CONCEPTS = Array.from({ length: 8 }, (_, i) => concept(10 + i, i + 1));
const wrongFor = (cards) => new Map(cards.map((c) => [c.id, [`Topic reason alpha ${c.id}.`, `Topic cause beta ${c.id}.`, `Topic effect gamma ${c.id}.`]]));

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

  it('never keeps an option without text: zero-width, no-break space, gap marks and bare punctuation are blank too', () => {
    const blanks = ['', '   ', '​', ' ', '﻿​ ', '___', ' ___ ', '...', '…', '-'];
    for (const b of blanks) assert.ok(!hasText(b), JSON.stringify(b));
    for (const t of ['A', '7', 'Ang wika', 'a ___ b']) assert.ok(hasText(t), t);
    assert.deepEqual(usableWrong(['Other', ...blanks, 'Third'], 'Answer 1.', Infinity), ['Other', 'Third']);
    assert.ok(hasBlank({ type: 'mc', question: 'Q?', choices: ['a', '​', 'c', 'd'] }));
    assert.ok(hasBlank({ type: 'tf', question: 'Q?', statement: ' ' }));
    assert.ok(!hasBlank({ type: 'tf', question: 'Q?', statement: 'It holds.' }));
  });

  it('a term whose definition is only its own term (blank once hidden) is never asked or shown', () => {
    const cards = [
      { id: 1, kind: 'term', front: 'Sampling', back: 'Sampling', evidence: 'x' },
      { id: 2, kind: 'term', front: 'Survey', back: 'Asks many people the same questions.', evidence: 'x' },
      { id: 3, kind: 'term', front: 'Interview', back: 'Asks one person questions in depth.', evidence: 'x' },
      { id: 4, kind: 'term', front: 'Census', back: 'Counts every member of a population.', evidence: 'x' },
      { id: 5, kind: 'term', front: 'Pilot', back: 'A small trial run before the real study.', evidence: 'x' },
    ];
    const [empty, ...others] = quizCandidates(cards);
    assert.equal(empty.shown, '___');
    assert.equal(empty.mcClean.length + empty.falseClean.length, 0);
    for (const c of others) assert.ok(![...c.mcClean, ...c.falseClean].some((t) => !hasText(t)), 'a blank definition is not offered to another term');
    const qs = buildQuiz({ cards, random: seeded(3) });
    assert.ok(qs.length > 0);
    for (const q of qs) assert.ok(!hasBlank(q) && q.flashcard_id !== 1, JSON.stringify(q));
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
    const distractors = new Map([[cards[0].id, ['Saved wrong']], [cards[1].id, ['Other saved', cards[1].back]]]);
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
    assert.equal(usableCount([concept(1), { ...concept(2), back: 'topic answer number 1: mountains.' }]), 0);
  });

  it('a term card is never asked against a concept card’s answer, and is skipped with no other definition', () => {
    const cards = [term(1, 'Hypothesis', 'A testable prediction about variables.'), ...CONCEPTS.slice(0, 4)];
    for (let seed = 1; seed <= 20; seed++) {
      assert.ok(!buildQuiz({ cards, distractors: wrongFor(CONCEPTS), random: seeded(seed) }).some((q) => q.flashcard_id === 1));
    }
    const two = [term(1, 'Hypothesis', 'A testable prediction about variables.'), term(2, 'Sample', 'The part of the population that is studied.'), ...CONCEPTS.slice(0, 4)];
    for (let seed = 1; seed <= 20; seed++) {
      for (const q of buildQuiz({ cards: two, distractors: wrongFor(CONCEPTS), random: seeded(seed) }).filter((x) => x.kind === 'term' && x.answer_index === 1)) {
        assert.ok(two.some((c) => c.kind === 'term' && c.back === q.statement), 'the false statement is another definition');
      }
    }
  });

  it('a term Yes/No false statement goes through rule e: not one naming the asked term, negative, or in another language', () => {
    const cards = [
      term(1, 'Hypothesis', 'A testable prediction about variables.'),
      term(2, 'Sample', 'The part of the population that is studied.'),
      term(3, 'Guess', 'A rough hypothesis made before any testing.'),
      term(4, 'Bias', 'A result that is not fair to every group.'),
      term(5, 'Populasyon', 'Ang buong pangkat na pinag-aaralan ng mananaliksik.'),
    ];
    const p = quizCandidates(cards).find((x) => x.card.id === 1);
    assert.equal(p.falsePool.length, 4);
    assert.deepEqual(p.falseClean, ['The part of the population that is studied.']);
    for (let seed = 1; seed <= 30; seed++)
      for (const q of buildQuiz({ cards, random: seeded(seed) }).filter((x) => x.flashcard_id === 1 && x.type === 'tf' && x.answer_index === 1))
        assert.equal(q.statement, 'The part of the population that is studied.');
  });

  it('a definition is blanked under the stems termInText uses, so no term question shows its term (English marker word in the term)', () => {
    const cards = [
      term(1, 'Law of marketing', 'Marketing is the process of selling a product.'),
      term(2, 'Supply', 'The amount of a product sellers offer.'),
      term(3, 'Demand', 'The amount buyers want to buy.'),
      term(4, 'Price', 'What buyers pay for a product.'),
    ];
    assert.equal(quizCandidates(cards).find((p) => p.card.id === 1).shown, '___ is the process of selling a product.');
    for (let seed = 1; seed <= 30; seed++)
      for (const q of buildQuiz({ cards, random: seeded(seed) })) assert.deepEqual(questionLeaks(q), [], `${q.type} #${q.flashcard_id}: ${q.question} / ${q.statement}`);
  });

  it('a saved wrong answer that is another card’s answer is used neither as an option nor as a false statement', () => {
    const cards = CONCEPTS.slice(0, 3);
    const distractors = wrongFor(cards);
    distractors.set(cards[0].id, [cards[1].back, ...distractors.get(cards[0].id).slice(1)]);
    const [first] = quizCandidates(cards, { distractors });
    assert.equal(first.mcClean.length, 0, 'only 2 clean wrong answers left: no multiple choice');
    assert.ok(!first.falseClean.includes(cards[1].back));
    assert.equal(first.falseClean.length, 2);
  });
});

// The leak rules applied while building (rules in leaks.js, tested in quiz-leaks.test.js).
for (const lesson of [EN_LESSON, FIL_LESSON]) {
  const opts = { distractors: distractorMap(lesson), extraTerms: lesson.keyTerms, lessonText: lesson.text };
  const byId = (id) => lesson.cards.find((c) => c.id === id);
  describe(`quiz building skips what gives the answer away (${lesson.title})`, () => {
    const quizzes = Array.from({ length: 40 }, (_, i) => buildQuiz({ cards: lesson.cards, ...opts, random: seeded(i + 1) }));
    const asked = quizzes.flat();

    it('no built question breaks a leak rule', () => {
      const lessonWords = null;
      for (const q of asked) assert.deepEqual(questionLeaks(q, { lessonWords }), [], `${q.type} #${q.flashcard_id}: ${q.question} / ${q.statement}`);
    });

    it('a lesson that can’t fill 10 clean questions gets fewer', () => {
      assert.equal(usableCount(lesson.cards, opts), 6);
      for (const quiz of quizzes) assert.equal(quiz.length, 6);
    });

    it('cards whose question holds the answer, or whose every wrong answer is a reversal, are never asked', () => {
      const never = lesson === EN_LESSON ? [5, 7] : [17];
      for (const q of asked) assert.ok(!never.includes(q.flashcard_id), `card ${q.flashcard_id} was asked`);
    });

    it('a card whose wrong answers stand out is asked as Yes/No only, with a plausible false statement', () => {
      const tfOnly = lesson === EN_LESSON ? [6] : [14, 16];
      for (const q of asked.filter((x) => tfOnly.includes(x.flashcard_id))) {
        assert.equal(q.type, 'tf');
        if (q.answer_index === 1) assert.ok(lesson.distractors[q.flashcard_id].includes(q.statement));
      }
      if (lesson === FIL_LESSON) {
        const falses = asked.filter((q) => q.flashcard_id === 14 && q.answer_index === 1).map((q) => q.statement);
        assert.ok(falses.length > 0);
        assert.ok(falses.every((s) => !/mahirapan|itago/.test(s)), 'the reversed wrong answers are never the false statement');
      }
    });

    it('a definition that holds its own term is shown with the term blanked, and the stored answer is unchanged', () => {
      const id = lesson === EN_LESSON ? 3 : 13;
      const card = byId(id);
      const shown = quizCandidates(lesson.cards, opts).find((p) => p.card.id === id).shown;
      assert.match(shown, /___/);
      for (const q of asked.filter((x) => x.flashcard_id === id)) {
        assert.equal(q.answer_text, card.back);
        if (q.type === 'tf' && q.answer_index === 0) assert.equal(q.statement, shown);
      }
    });
  });
}

describe('quiz building, continued', () => {

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
