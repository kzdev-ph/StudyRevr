import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, runMigrations } from '../src/db/index.js';
import { distractorsPrompt } from '../src/ai/prompts.js';
import { BATCH_SIZE, cardsNeedingDistractors, checkWrong, ensureDistractors, loadDistractors, pickWrongSet } from '../src/quiz/distractors.js';
import { contentWords } from '../src/quiz/leaks.js';

const quiet = { warn() {}, log() {}, error() {}, info() {} };

// A fake AI that answers each wrong-answers call with `reply(cards, call)`, where cards are parsed back out of the prompt.
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

const TEXT = 'A study uses a survey to collect data from many people. An interview asks one person questions in depth. Sampling saves time and money.';
const ANSWER = 'It is used to collect data from many people.';
const CLEAN = ['It is used to save time and money.', 'It is used to ask one person in depth.', 'It is used to study a person in depth.'];
const threeClean = (cards) => ({ items: cards.map((c) => ({ n: c.n, wrong: CLEAN })) });

describe('quiz wrong answers', () => {
  let db;
  let lessonId;
  const addCards = (n, kind = 'concept') => {
    const insert = db.prepare("INSERT INTO flashcards (lesson_id, kind, front, back, evidence, position) VALUES (?, ?, ?, ?, 'a quote', ?)");
    return Array.from({ length: n }, (_, i) => Number(insert.run(lessonId, kind, `Why is a survey used in study ${i + 1}?`, kind === 'term' ? `Term answer ${i + 1}.` : ANSWER, i + 1).lastInsertRowid));
  };
  const save = (id, wrong) => db.prepare("INSERT INTO quiz_distractors (flashcard_id, choices, made_at) VALUES (?, ?, 'x')").run(id, JSON.stringify(wrong));

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    lessonId = Number(db.prepare("INSERT INTO lessons (title, filename, raw_text, status) VALUES ('L', 'l.pptx', ?, 'ready')").run(TEXT).lastInsertRowid);
  });

  it('makes them for concept cards only, in one call, and saves them for reuse', async () => {
    const concepts = addCards(4);
    addCards(3, 'term');
    const ai = fakeAi(threeClean);
    assert.deepEqual(await ensureDistractors({ db, ai, lessonId, log: quiet }), { made: 4, error: null });
    assert.equal(ai.calls.length, 1);
    assert.equal(ai.calls[0].cards.length, 4);
    const saved = loadDistractors(db, lessonId);
    assert.deepEqual([...saved.keys()].sort(), concepts.sort());
    assert.deepEqual(saved.get(concepts[0]), CLEAN);

    assert.deepEqual(await ensureDistractors({ db, ai, lessonId, log: quiet }), { made: 0, error: null });
    assert.equal(ai.calls.length, 1, 'the second quiz reuses them');
  });

  it(`splits more than ${BATCH_SIZE} concept cards into batches of at most ${BATCH_SIZE}`, async () => {
    addCards(32);
    const ai = fakeAi(threeClean);
    const { made } = await ensureDistractors({ db, ai, lessonId, concurrency: 2, log: quiet });
    assert.equal(made, 32);
    assert.deepEqual(ai.calls.map((c) => c.cards.length), [15, 15, 2]);
    assert.deepEqual(ai.calls.map((c) => c.cards[0].n), [1, 1, 1], 'each batch is numbered from 1');
  });

  it('drops wrong answers that match the correct answer or each other (case-insensitive, trimmed)', async () => {
    const [id] = addCards(1);
    const ai = fakeAi(() => ({ items: [{ n: 1, wrong: [` ${ANSWER.toLowerCase()} `, CLEAN[0], `${CLEAN[0].toUpperCase()} `, CLEAN[1], '', CLEAN[2]] }] }));
    await ensureDistractors({ db, ai, lessonId, log: quiet });
    assert.deepEqual(loadDistractors(db, lessonId).get(id), CLEAN);
    assert.equal(ai.calls.length, 1);
  });

  it('saves [] for a card the reply left out, after asking for it once more', async () => {
    const [a, b] = addCards(2);
    const ai = fakeAi((cards, call) => ({ items: call === 1 ? [{ n: 1, wrong: CLEAN }] : [] }));
    await ensureDistractors({ db, ai, lessonId, log: quiet });
    const saved = loadDistractors(db, lessonId);
    assert.deepEqual(saved.get(a), CLEAN);
    assert.deepEqual(saved.get(b), []);
    assert.deepEqual(ai.calls.map((c) => c.cards.length), [2, 1]);
  });

  it('a failed batch saves nothing and reports the error; the next run tries again', async () => {
    addCards(20);
    const ai = fakeAi((cards, call) => {
      if (call === 2) throw new Error('Rate limited, try again shortly.');
      return threeClean(cards);
    });
    const first = await ensureDistractors({ db, ai, lessonId, log: quiet });
    assert.deepEqual(first, { made: 15, error: 'Rate limited, try again shortly.' });
    const second = await ensureDistractors({ db, ai, lessonId, log: quiet });
    assert.deepEqual(second, { made: 5, error: null });
    assert.equal(ai.calls.at(-1).cards.length, 5);
  });

  describe('the leak check on each reply', () => {
    const NEGATIVE = ['It is used to hide data from many people.', 'It is never used to collect any data.'];

    it('drops negative or reversed wrong answers and asks once more, saying why; the clean ones are kept', async () => {
      const [id] = addCards(1);
      const ai = fakeAi((cards, call) => ({ items: [{ n: 1, wrong: call === 1 ? [CLEAN[0], ...NEGATIVE] : [CLEAN[1], CLEAN[2]] }] }));
      assert.deepEqual(await ensureDistractors({ db, ai, lessonId, log: quiet }), { made: 1, error: null });
      assert.equal(ai.calls.length, 2);
      assert.equal(ai.calls[1].label, 'the quiz answer options (second try)');
      assert.match(ai.calls[1].user, /Kept: "It is used to save time and money\."/);
      assert.match(ai.calls[1].user, /Rejected: "It is used to hide data from many people\." \(tone: [^)]+\); "It is never used/);
      assert.match(ai.calls[1].system, /rejected answers and why/);
      assert.deepEqual(loadDistractors(db, lessonId).get(id), [CLEAN[1], CLEAN[2], CLEAN[0]], 'the new answers first, then the kept one');
    });

    it('asks only once more: what is still clean is saved, and the quiz asks that card as Yes/No', async () => {
      const [id] = addCards(1);
      const ai = fakeAi(() => ({ items: [{ n: 1, wrong: [CLEAN[0], ...NEGATIVE] }] }));
      await ensureDistractors({ db, ai, lessonId, log: quiet });
      assert.equal(ai.calls.length, 2);
      assert.deepEqual(loadDistractors(db, lessonId).get(id), [CLEAN[0]]);
    });

    it('a set where the right answer still stands out is asked again with the problem named (Filipino)', async () => {
      db.prepare('UPDATE lessons SET raw_text = ? WHERE id = ?').run('Ginagamit ang Filipino sa pamahalaan sa pagbibigay ng impormasyon at serbisyo. Malaki ang papel nito sa batas, buwis at ugnayan sa ibang bansa.', lessonId);
      const id = Number(db.prepare("INSERT INTO flashcards (lesson_id, kind, front, back, evidence, position) VALUES (?, 'concept', 'Paano ginagamit ang Filipino sa pamahalaan?', 'Ginagamit ito sa pagbibigay ng impormasyon at serbisyo sa mamamayan.', 'q', 1)").run(lessonId).lastInsertRowid);
      const opening = ['Malaking papel ito sa pagbuo ng mga batas ng bansa.', 'Malaking papel ito sa pangongolekta ng buwis ng bansa.', 'Malaking papel ito sa ugnayan sa ibang bansa ngayon.'];
      const fixed = ['Ginagamit ito sa pagbuo ng mga batas ng bansa.', 'Ginagamit ito sa pangongolekta ng buwis sa bansa.', 'Ginagamit ito sa ugnayan sa ibang bansa ngayon.'];
      const ai = fakeAi((cards, call) => ({ items: [{ n: 1, wrong: call === 1 ? opening : fixed }] }));
      await ensureDistractors({ db, ai, lessonId, log: quiet });
      assert.match(ai.calls[0].user, /about 10 words, in Filipino/);
      assert.match(ai.calls[1].user, /Problem with the set: .*opening/);
      assert.deepEqual(loadDistractors(db, lessonId).get(id), fixed);
    });

    it('if the second try fails, the first try’s clean answers are saved and no error is reported', async () => {
      const [id] = addCards(1);
      const ai = fakeAi((cards, call) => {
        if (call === 2) throw new Error('Timed out.');
        return { items: [{ n: 1, wrong: [CLEAN[0], ...NEGATIVE] }] };
      });
      assert.deepEqual(await ensureDistractors({ db, ai, lessonId, log: quiet }), { made: 1, error: null });
      assert.deepEqual(loadDistractors(db, lessonId).get(id), [CLEAN[0]]);
    });

    it('a saved set that fails the checks is remade only when asked to (admin retry), never by a quiz start', async () => {
      const [bad, good, given] = addCards(3);
      db.prepare("UPDATE flashcards SET front = 'Why is a survey used to collect data from many people?' WHERE id = ?").run(given); // rule a
      save(bad, [CLEAN[0], ...NEGATIVE]);
      save(good, CLEAN);
      save(given, []);
      assert.deepEqual(cardsNeedingDistractors(db, lessonId).map((c) => c.id), []);
      assert.deepEqual(cardsNeedingDistractors(db, lessonId, { includeFailing: true }).map((c) => c.id), [bad], 'not the card whose question gives the answer away');

      const ai = fakeAi(threeClean);
      assert.deepEqual(await ensureDistractors({ db, ai, lessonId, log: quiet }), { made: 0, error: null });
      assert.equal(ai.calls.length, 0);
      assert.deepEqual(await ensureDistractors({ db, ai, lessonId, includeFailing: true, log: quiet }), { made: 1, error: null });
      assert.deepEqual(ai.calls[0].cards.map((c) => c.question), ['Why is a survey used in study 1?']);
      assert.deepEqual(loadDistractors(db, lessonId).get(bad), CLEAN);
    });

    it('checkWrong and pickWrongSet: per-option reasons, and the first set of 3 that gives nothing away', () => {
      const lessonWords = new Set(contentWords(TEXT));
      const { clean, rejected } = checkWrong([...NEGATIVE, 'Short.', 'It is used to grow rice in the mountains.', ...CLEAN], ANSWER, lessonWords);
      assert.deepEqual(clean, CLEAN);
      assert.deepEqual(rejected.map((r) => r.why.split(':')[0]), ['tone', 'tone', 'length', 'about nothing in the lesson']);
      const echo = pickWrongSet('Why is a survey used?', 'A survey is used to reach many people.', ['To save time.', 'A survey is used to ask one person.', 'To save money.', 'To ask in depth.']);
      assert.equal(echo.ok, true);
      assert.ok(echo.wrong.includes('A survey is used to ask one person.'), 'the set includes an option that also echoes the question');
      assert.equal(pickWrongSet('Why is a survey used?', 'A survey is used to reach many people.', ['To save time.', 'To save money.', 'To ask in depth.']).ok, false);
    });
  });

  it('the prompt asks for wrong answers like the correct one, same tone, from the lesson only, and explains Notes:', () => {
    const { system, user } = distractorsPrompt({ cards: [{ n: 1, question: 'Why sample?', answer: 'To save time.', evidence: 'Sampling saves time.', words: 3, language: 'en' }], keyTerms: ['Sample'] });
    assert.match(system, /similar in length and style to the correct answer/);
    assert.match(system, /Same tone and polarity as the correct answer/);
    assert.match(system, /Stay on the subject of the question/);
    assert.match(system, /directly answer THIS question/);
    assert.match(system, /Never use another card's correct answer/);
    assert.doesNotMatch(system, /reverse a relationship/);
    assert.match(system, /Use ONLY the lesson content/);
    assert.match(system, /"Notes:"/);
    assert.match(system, /key terms: Sample/);
    assert.doesNotMatch(system, /rejected answers/, 'only the follow-up explains rejections');
    assert.match(user, /\[1\] Question: Why sample\?\n {4}Correct answer: To save time\.\n {4}From the lesson: "Sampling saves time\."\n {4}Write each wrong answer in about 3 words, in English\./);
  });
});
