import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, runMigrations } from '../src/db/index.js';
import { ensureStatements } from '../src/services/quiz-statements.js';
import { cardsNeedingStatements, loadStatements } from '../src/quiz/statement-store.js';
import { cardHash } from '../src/quiz/review-flags.js';

const quiet = { warn() {}, log() {}, error() {}, info() {} };
const now = () => new Date('2026-01-01T00:00:00Z');

// A fake AI that answers each statements call with `reply(cards, call)`, where cards are parsed back out of the prompt.
const fakeAi = (reply) => {
  const ai = {
    calls: [],
    async generateJSON({ user, system, schema, label, responseSchema }) {
      const cards = [...user.matchAll(/^\[(\d+)\] Question: (.*)\n {4}Answer: (.*)\n {4}From the lesson: "(.*)"$/gm)].map((m) => ({ n: Number(m[1]), question: m[2], answer: m[3], evidence: m[4] }));
      ai.calls.push({ user, system, label, responseSchema, cards });
      return schema.parse(await reply(cards, ai.calls.length));
    },
  };
  return ai;
};

const TEXT = 'A survey is used to collect data from many people. An interview asks one person questions in depth. Sampling saves time and money.';
const ANSWER = 'To collect data from many people.';
const QUOTE = 'A survey is used to collect data from many people.';
const GOOD = { true_statement: 'A survey is used to collect data from many people.', false_statement: 'A survey is used to ask one person questions in depth.' };
const good = (cards) => ({ items: cards.map((c) => ({ n: c.n, ...GOOD })) });

describe('quiz True/False statements (AI call)', () => {
  let db;
  let lessonId;
  const addCards = (n) => {
    const insert = db.prepare("INSERT INTO flashcards (lesson_id, kind, front, back, evidence, position) VALUES (?, 'concept', ?, ?, ?, ?)");
    return Array.from({ length: n }, (_, i) => Number(insert.run(lessonId, `What is a survey used for in study ${i + 1}?`, ANSWER, QUOTE, i + 1).lastInsertRowid));
  };
  const rows = () => loadStatements(db, lessonId);

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    lessonId = Number(db.prepare("INSERT INTO lessons (title, filename, raw_text, status) VALUES ('L', 'l.pptx', ?, 'ready')").run(TEXT).lastInsertRowid);
  });

  it('makes 1 call for 25 cards and 2 for 26, with the label and the quiz_true_false schema', async () => {
    addCards(25);
    assert.equal(cardsNeedingStatements(db, lessonId).length, 25);
    const one = fakeAi(good);
    assert.deepEqual(await ensureStatements({ db, ai: one, lessonId, log: quiet, now }), { made: 25, rejected: 0, error: null });
    assert.equal(one.calls.length, 1);
    assert.equal(one.calls[0].label, 'the quiz true/false statements');
    assert.equal(one.calls[0].responseSchema.name, 'quiz_true_false');

    addCards(1);
    const two = fakeAi(good);
    assert.deepEqual(await ensureStatements({ db, ai: two, lessonId, log: quiet, now }), { made: 1, rejected: 0, error: null });
    assert.equal(two.calls.length, 1, 'only the new card is asked for');

    db.prepare('DELETE FROM quiz_statements').run();
    const both = fakeAi(good);
    await ensureStatements({ db, ai: both, lessonId, log: quiet, now });
    assert.deepEqual(both.calls.map((c) => c.cards.length), [25, 1]);
    assert.equal(both.calls[1].cards[0].n, 1, 'each batch is numbered from 1');
  });

  it('saves each pair by its number as pending, and ignores a number that is not in the batch', async () => {
    const [a, b] = addCards(2);
    const ai = fakeAi((cards) => ({ items: [{ n: 2, ...GOOD, true_statement: ` ${GOOD.true_statement} ` }, { n: 1, ...GOOD }, { n: 9, ...GOOD }] }));
    assert.deepEqual(await ensureStatements({ db, ai, lessonId, log: quiet, now }), { made: 2, rejected: 0, error: null });
    const saved = rows();
    assert.deepEqual([...saved.keys()].sort(), [a, b].sort());
    for (const id of [a, b]) {
      const card = db.prepare('SELECT id, front, back FROM flashcards WHERE id = ?').get(id);
      assert.deepEqual(
        { hash: saved.get(id).card_hash, t: saved.get(id).true_text, f: saved.get(id).false_text, status: saved.get(id).status, why: saved.get(id).why },
        { hash: cardHash(card), t: GOOD.true_statement, f: GOOD.false_statement, status: 'pending', why: null },
      );
    }
  });

  it('saves a card the reply left out as rejected', async () => {
    const [a, b] = addCards(2);
    const ai = fakeAi((cards) => ({ items: [{ n: 1, ...GOOD }] }));
    assert.deepEqual(await ensureStatements({ db, ai, lessonId, log: quiet, now }), { made: 1, rejected: 1, error: null });
    assert.equal(rows().get(a).status, 'pending');
    assert.deepEqual({ status: rows().get(b).status, why: rows().get(b).why, t: rows().get(b).true_text }, { status: 'rejected', why: 'no statement in the reply', t: null });
  });

  it('gives an error and saves nothing when the reply matches none of the cards, then asks again next time', async () => {
    addCards(2);
    const bad = fakeAi(() => ({ items: [{ n: 7, ...GOOD }] }));
    const result = await ensureStatements({ db, ai: bad, lessonId, log: quiet, now });
    assert.deepEqual({ made: result.made, rejected: result.rejected, error: typeof result.error }, { made: 0, rejected: 0, error: 'string' });
    assert.equal(rows().size, 0);

    const empty = fakeAi(() => ({ items: [] }));
    assert.equal(typeof (await ensureStatements({ db, ai: empty, lessonId, log: quiet, now })).error, 'string');
    assert.equal(rows().size, 0);

    const again = fakeAi(good);
    assert.deepEqual(await ensureStatements({ db, ai: again, lessonId, log: quiet, now }), { made: 2, rejected: 0, error: null });
  });

  it('keeps the other batches when one batch fails', async () => {
    addCards(3);
    const ai = fakeAi((cards, call) => (call === 1 ? { items: [] } : good(cards)));
    const result = await ensureStatements({ db, ai, lessonId, batchSize: 2, log: quiet, now });
    assert.equal(typeof result.error, 'string');
    assert.equal(result.made, 1);
    assert.equal(rows().size, 1);
  });

  it('saves a pair the code checks reject as rejected, with why', async () => {
    const [id] = addCards(1);
    const ai = fakeAi((cards) => ({ items: [{ n: 1, true_statement: GOOD.true_statement, false_statement: 'A survey is not used to collect data from many people.' }] }));
    assert.deepEqual(await ensureStatements({ db, ai, lessonId, log: quiet, now }), { made: 0, rejected: 1, error: null });
    const row = rows().get(id);
    assert.equal(row.status, 'rejected');
    assert.equal(row.true_text, null);
    assert.match(row.why, /false twin: /);
    assert.equal(cardsNeedingStatements(db, lessonId).length, 0, 'a rejected row is not asked for again');
  });

  it('does not save a pair for a card that changed during the call', async () => {
    const [a, b] = addCards(2);
    const ai = fakeAi((cards) => {
      db.prepare('UPDATE flashcards SET back = ? WHERE id = ?').run('To gather data from a crowd of people.', a);
      return good(cards);
    });
    assert.deepEqual(await ensureStatements({ db, ai, lessonId, log: quiet, now }), { made: 1, rejected: 0, error: null });
    assert.deepEqual([...rows().keys()], [b]);
  });

  it('makes no call the second time', async () => {
    addCards(3);
    const ai = fakeAi(good);
    await ensureStatements({ db, ai, lessonId, log: quiet, now });
    assert.deepEqual(await ensureStatements({ db, ai, lessonId, log: quiet, now }), { made: 0, rejected: 0, error: null });
    assert.equal(ai.calls.length, 1);
  });

  it('shares one run per lesson: a second call while the first is in flight waits for it', async () => {
    addCards(2);
    const ai = fakeAi(async (cards) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return good(cards);
    });
    const [first, second] = await Promise.all([ensureStatements({ db, ai, lessonId, log: quiet, now }), ensureStatements({ db, ai, lessonId, log: quiet, now })]);
    assert.equal(ai.calls.length, 1, 'one call served both');
    assert.deepEqual([first, second], [{ made: 2, rejected: 0, error: null }, { made: 2, rejected: 0, error: null }]);
    assert.deepEqual(await ensureStatements({ db, ai, lessonId, log: quiet, now }), { made: 0, rejected: 0, error: null }, 'and the run is forgotten once it ends');
  });

  it('reports progress by batch', async () => {
    addCards(3);
    const seen = [];
    await ensureStatements({ db, ai: fakeAi(good), lessonId, batchSize: 2, log: quiet, now, onProgress: (p) => seen.push(p) });
    assert.deepEqual(seen, [{ done: 0, total: 2 }, { done: 1, total: 2 }, { done: 2, total: 2 }]);
  });
});
