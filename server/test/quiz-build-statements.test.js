import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/flashcards/scheduler.js';
import { buildQuiz, quizCandidates, usableCount } from '../src/quiz/build.js';
import { questionLeaks } from '../src/quiz/leaks.js';
import { cardHash } from '../src/quiz/review-flags.js';

const seeded = (seed = 1) => createRng(seed);

const term = (id, front, back) => ({ id, kind: 'term', front, back, evidence: `${front} quote` });
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

// the first 6 concept cards can be multiple choice (saved wrong answers); the last 2 have none (forced Yes/No)
const MC_CARDS = CONCEPTS.slice(0, 6);
const FORCED = CONCEPTS.slice(6);
const distractors = wrongFor(MC_CARDS);
const CARDS = [...TERMS, ...CONCEPTS];

const row = (card, over = {}) => ({
  card_hash: cardHash(card),
  true_text: `The topic holds that ${card.back}`,
  false_text: `The topic holds that wrong claim ${card.id}.`,
  status: 'ok',
  why: null,
  ...over,
});
const pairsFor = (cards, over = {}) => new Map(cards.map((c) => [c.id, row(c, over)]));
const find = (qs, card) => qs.find((q) => q.flashcard_id === card.id);
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

describe('quiz building with true / false pairs', () => {
  it('gives the same output as before when statements is undefined', () => {
    for (const seed of SEEDS) {
      const legacy = buildQuiz({ cards: CARDS, distractors, random: seeded(seed) });
      const same = buildQuiz({ cards: CARDS, distractors, statements: undefined, random: seeded(seed) });
      assert.deepEqual(same, legacy);
      for (const q of legacy) assert.ok(!('form' in q), 'no form key without pairs');
    }
    for (const p of quizCandidates(CARDS, { distractors })) {
      assert.deepEqual(p.yesNo, p.falseClean);
      assert.equal(p.pair, null);
      assert.equal(p.tfForm, null);
    }
  });

  it('an MC-able concept card without a pair is never True/False; a forced card keeps the old form', () => {
    const statements = new Map();
    for (const seed of SEEDS) {
      const qs = buildQuiz({ cards: CARDS, distractors, statements, random: seeded(seed) });
      for (const card of MC_CARDS) {
        const q = find(qs, card);
        if (q) assert.equal(q.type, 'mc', `card ${card.id}, seed ${seed}`);
      }
      for (const q of qs.filter((x) => x.type === 'tf')) assert.ok(!MC_CARDS.some((c) => c.id === q.flashcard_id) && !('form' in q));
    }
    const cands = quizCandidates(CARDS, { distractors, statements });
    for (const card of MC_CARDS) {
      const p = cands.find((c) => c.card.id === card.id);
      assert.equal(p.mcClean.length, 3);
      assert.deepEqual(p.yesNo, []);
      assert.ok(p.falseClean.length > 0, 'falseClean keeps its meaning');
    }
    for (const card of FORCED) {
      const p = cands.find((c) => c.card.id === card.id);
      assert.deepEqual(p.yesNo, p.falseClean);
      assert.ok(p.yesNo.length > 0);
    }
    const forced = buildQuiz({ cards: CARDS, distractors, statements, random: seeded(3) }).filter((q) => FORCED.some((c) => c.id === q.flashcard_id));
    for (const q of forced) {
      assert.equal(q.type, 'tf');
      assert.ok(!('form' in q));
    }
  });

  it('asks an ok pair with both truths across seeds; answer_text is the true sentence', () => {
    const statements = pairsFor(CONCEPTS);
    const seen = new Set();
    for (const seed of SEEDS) {
      const qs = buildQuiz({ cards: CARDS, distractors, statements, random: seeded(seed) });
      for (const q of qs.filter((x) => x.form === 'statement')) {
        const card = CONCEPTS.find((c) => c.id === q.flashcard_id);
        const r = statements.get(card.id);
        assert.equal(q.type, 'tf');
        assert.equal(q.question, card.front);
        assert.equal(q.answer_text, r.true_text);
        assert.equal(q.statement, q.answer_index === 0 ? r.true_text : r.false_text);
        assert.deepEqual(questionLeaks(q), []);
        seen.add(q.answer_index);
      }
    }
    assert.deepEqual([...seen].sort(), [0, 1]);
    const cands = quizCandidates(CARDS, { distractors, statements });
    for (const card of CONCEPTS) {
      const p = cands.find((c) => c.card.id === card.id);
      assert.equal(p.tfForm, 'statement');
      assert.deepEqual(p.yesNo, [statements.get(card.id).false_text]);
      assert.ok(p.reviewable.includes(statements.get(card.id).false_text));
    }
  });

  it('cleans trailing marks of the true and false sentences together', () => {
    const card = MC_CARDS[0];
    const statements = new Map([[card.id, row(card, { true_text: 'The topic is about rivers.', false_text: 'The topic is about a desert' })]]);
    const [p] = quizCandidates([card, ...MC_CARDS.slice(1)], { distractors, statements });
    assert.equal(p.tfForm, 'statement');
    for (const seed of SEEDS) {
      const q = find(buildQuiz({ cards: CARDS, distractors, statements, random: seeded(seed) }), card);
      if (q?.form === 'statement') {
        assert.equal(q.answer_text, 'The topic is about rivers');
        assert.ok(['The topic is about rivers', 'The topic is about a desert'].includes(q.statement));
      }
    }
  });

  it('a pending, flagged, rejected or stale pair is not used', () => {
    const card = MC_CARDS[0];
    const cases = {
      pending: { status: 'pending' },
      flagged: { status: 'flagged' },
      rejected: { status: 'rejected' },
      stale: { card_hash: 'old' },
      'empty true': { true_text: ' ' },
      'empty false': { false_text: '' },
    };
    for (const [name, over] of Object.entries(cases)) {
      const statements = new Map([[card.id, row(card, over)]]);
      const p = quizCandidates(CARDS, { distractors, statements }).find((c) => c.card.id === card.id);
      assert.equal(p.tfForm, null, name);
      assert.deepEqual(p.yesNo, [], name);
      for (const seed of SEEDS) assert.ok(find(buildQuiz({ cards: CARDS, distractors, statements, random: seeded(seed) }), card)?.form !== 'statement', name);
    }
    // a pair that is waiting or flagged is still shown to the reviewer
    for (const status of ['pending', 'flagged']) {
      const statements = new Map([[card.id, row(card, { status })]]);
      const p = quizCandidates(CARDS, { distractors, statements }).find((c) => c.card.id === card.id);
      assert.ok(p.pair && p.reviewable.includes(p.pair.false), status);
    }
    for (const status of ['rejected']) {
      const p = quizCandidates(CARDS, { distractors, statements: new Map([[card.id, row(card, { status })]]) }).find((c) => c.card.id === card.id);
      assert.equal(p.pair, null);
    }
  });

  it('a pair with a flagged twin, a flagged true statement or a flagged card is not used', () => {
    const card = FORCED[0];
    const statements = new Map([[card.id, row(card)]]);
    const reviewOf = (over) => ({ cardHash: cardHash(card), card: [], set: [], trueStatement: [], options: new Map(), ...over });
    const base = quizCandidates(CARDS, { distractors, statements }).find((c) => c.card.id === card.id);
    assert.equal(base.tfForm, 'statement');
    const flag = { flag: 'not_in_lesson', why: '' };
    const twin = statements.get(card.id).false_text.trim().replace(/\s+/g, ' ').toLowerCase();
    const reviews = {
      'flagged twin': reviewOf({ options: new Map([[twin, [flag]]]) }),
      'flagged true statement': reviewOf({ trueStatement: [flag] }),
      'flagged card': reviewOf({ card: [flag] }),
    };
    for (const [name, review] of Object.entries(reviews)) {
      const p = quizCandidates(CARDS, { distractors, statements, reviews: new Map([[card.id, review]]) }).find((c) => c.card.id === card.id);
      assert.equal(p.tfForm, null, name);
      assert.ok(!p.yesNo.includes(statements.get(card.id).false_text), name);
    }
  });

  it('term and list cards are unchanged', () => {
    const lessonText = 'Intro\n\nSteps:\n- plant seeds in spring\n- water them every week\n- weed the garden often\n- harvest in autumn\n';
    const item = { id: 30, kind: 'concept', front: 'Which step comes first in the garden?', back: 'Plant seeds in spring', evidence: 'plant seeds in spring' };
    const cards = [...CARDS, item];
    const statements = new Map([[item.id, row(item)], ...pairsFor(TERMS)]);
    const withMap = quizCandidates(cards, { distractors, lessonText, statements });
    const without = quizCandidates(cards, { distractors, lessonText });
    for (const p of withMap.filter((x) => x.card.kind === 'term' || x.card.id === item.id)) {
      const q = without.find((x) => x.card.id === p.card.id);
      assert.deepEqual(p, q, `card ${p.card.id}`);
      assert.equal(p.tfForm, null);
    }
  });

  it('the same seed gives the same quiz', () => {
    const statements = pairsFor([...MC_CARDS.slice(0, 3), ...FORCED]);
    for (const seed of SEEDS) {
      const a = buildQuiz({ cards: CARDS, distractors, statements, random: seeded(seed) });
      const b = buildQuiz({ cards: CARDS, distractors, statements, random: seeded(seed) });
      assert.deepEqual(a, b);
    }
  });

  it('usableCount is never lower than without statements', () => {
    const variants = [new Map(), pairsFor(CONCEPTS), pairsFor(CONCEPTS, { status: 'pending' }), pairsFor(FORCED)];
    const legacy = usableCount(CARDS, { distractors });
    for (const statements of variants) assert.ok(usableCount(CARDS, { distractors, statements }) >= legacy);
    assert.equal(usableCount(CARDS, { distractors, statements: undefined }), legacy);
  });
});
