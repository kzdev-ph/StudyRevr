import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, runMigrations } from '../src/db/index.js';
import { distractorsPrompt } from '../src/ai/prompts.js';
import { BATCH_SIZE, ensureDistractors, loadDistractors } from '../src/quiz/distractors.js';

const quiet = { warn() {}, log() {}, error() {} };

// A fake AI that answers each wrong-answers call with `reply(cards)`, where cards are parsed back out of the prompt.
const fakeAi = (reply) => {
  const ai = {
    calls: [],
    async generateJSON({ user, system, schema, label }) {
      const cards = [...user.matchAll(/^\[(\d+)\] Question: (.*)\n {4}Correct answer: (.*)$/gm)].map((m) => ({ n: Number(m[1]), question: m[2], answer: m[3] }));
      ai.calls.push({ user, system, label, cards });
      return schema.parse(await reply(cards, ai.calls.length));
    },
  };
  return ai;
};
const threeWrong = (cards) => ({ items: cards.map((c) => ({ n: c.n, wrong: [`wrong 1 for ${c.question}`, `wrong 2 for ${c.question}`, `wrong 3 for ${c.question}`] })) });

describe('quiz wrong answers', () => {
  let db;
  let lessonId;
  const addCards = (n, kind = 'concept') => {
    const insert = db.prepare("INSERT INTO flashcards (lesson_id, kind, front, back, evidence, position) VALUES (?, ?, ?, ?, 'a quote', ?)");
    return Array.from({ length: n }, (_, i) => Number(insert.run(lessonId, kind, `${kind} Q${i + 1}?`, `Answer ${i + 1}.`, i + 1).lastInsertRowid));
  };

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    lessonId = Number(db.prepare("INSERT INTO lessons (title, filename, status) VALUES ('L', 'l.pptx', 'ready')").run().lastInsertRowid);
  });

  it('makes them for concept cards only, in one call, and saves them for reuse', async () => {
    const concepts = addCards(4);
    addCards(3, 'term');
    const ai = fakeAi(threeWrong);
    assert.deepEqual(await ensureDistractors({ db, ai, lessonId, log: quiet }), { made: 4, error: null });
    assert.equal(ai.calls.length, 1);
    assert.equal(ai.calls[0].cards.length, 4);
    const saved = loadDistractors(db, lessonId);
    assert.deepEqual([...saved.keys()].sort(), concepts.sort());
    assert.deepEqual(saved.get(concepts[0]), ['wrong 1 for concept Q1?', 'wrong 2 for concept Q1?', 'wrong 3 for concept Q1?']);

    assert.deepEqual(await ensureDistractors({ db, ai, lessonId, log: quiet }), { made: 0, error: null });
    assert.equal(ai.calls.length, 1, 'the second quiz reuses them');
  });

  it(`splits more than ${BATCH_SIZE} concept cards into batches of at most ${BATCH_SIZE}`, async () => {
    addCards(32);
    const ai = fakeAi(threeWrong);
    const { made } = await ensureDistractors({ db, ai, lessonId, concurrency: 2, log: quiet });
    assert.equal(made, 32);
    assert.deepEqual(ai.calls.map((c) => c.cards.length), [15, 15, 2]);
    assert.deepEqual(ai.calls.map((c) => c.cards[0].n), [1, 1, 1], 'each batch is numbered from 1');
  });

  it('drops wrong answers that match the correct answer or each other (case-insensitive, trimmed)', async () => {
    const [id] = addCards(1);
    const ai = fakeAi(() => ({ items: [{ n: 1, wrong: [' answer 1. ', 'Plausible', 'PLAUSIBLE ', 'Another', ''] }] }));
    await ensureDistractors({ db, ai, lessonId, log: quiet });
    assert.deepEqual(loadDistractors(db, lessonId).get(id), ['Plausible', 'Another']);
  });

  it('saves [] for a card the reply left out, so it is not asked again', async () => {
    const [a, b] = addCards(2);
    const ai = fakeAi(() => ({ items: [{ n: 1, wrong: ['x', 'y', 'z'] }] }));
    await ensureDistractors({ db, ai, lessonId, log: quiet });
    const saved = loadDistractors(db, lessonId);
    assert.deepEqual(saved.get(a), ['x', 'y', 'z']);
    assert.deepEqual(saved.get(b), []);
  });

  it('a failed batch saves nothing and reports the error; the next run tries again', async () => {
    addCards(20);
    const ai = fakeAi((cards, call) => {
      if (call === 2) throw new Error('Rate limited, try again shortly.');
      return threeWrong(cards);
    });
    const first = await ensureDistractors({ db, ai, lessonId, log: quiet });
    assert.deepEqual(first, { made: 15, error: 'Rate limited, try again shortly.' });
    const second = await ensureDistractors({ db, ai, lessonId, log: quiet });
    assert.deepEqual(second, { made: 5, error: null });
    assert.equal(ai.calls.at(-1).cards.length, 5);
  });

  it('the prompt asks for wrong answers like the correct one, from the lesson only, and explains Notes:', () => {
    const { system, user } = distractorsPrompt({ cards: [{ n: 1, question: 'Why sample?', answer: 'To save time.', evidence: 'Sampling saves time.' }], keyTerms: ['Sample'] });
    assert.match(system, /similar in length and style to the correct answer/);
    assert.match(system, /Use ONLY the lesson content/);
    assert.match(system, /"Notes:"/);
    assert.match(system, /key terms: Sample/);
    assert.match(user, /\[1\] Question: Why sample\?\n {4}Correct answer: To save time\.\n {4}From the lesson: "Sampling saves time\."/);
  });
});
