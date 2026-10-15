import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addCodes, startStudyApp, TEST_PIN } from './helpers.js';

const TEXT = [
  'Ang wika ay dinamiko dahil patuloy itong nagbabago kasabay ng pamumuhay at kultura.',
  'Ginagamit ang Wikang Filipino sa edukasyon upang mas madaling maipaliwanag ang mga konsepto.',
  'Sa pamahalaan, ginagamit ito sa pagbibigay ng impormasyon at serbisyo sa mamamayan.',
].join('\n\n');

// A fake AI for the regenerate call: `reply` is what it answers; `calls` keeps each prompt.
const fakeAi = () => {
  const ai = {
    reply: null,
    calls: [],
    async generateJSON({ system, user, schema, label }) {
      ai.calls.push({ system, user, label });
      return schema.parse(ai.reply);
    },
  };
  return ai;
};

describe('admin: cards that give their answer away', () => {
  let t;
  let ai;
  let lessonId;
  let leaky;
  let clean;
  let term;
  const call = (method, path, opts = {}) => t.call(method, path, { pin: TEST_PIN, ...opts });

  beforeEach(async () => {
    ai = fakeAi();
    t = await startStudyApp({ ai });
    addCodes(t.db, 'P01');
    lessonId = Number(t.db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status) VALUES ('Wika', 'w.pptx', ?, 40, 'ready')").run(TEXT).lastInsertRowid);
    const insert = t.db.prepare('INSERT INTO flashcards (lesson_id, kind, front, back, evidence, position) VALUES (?, ?, ?, ?, ?, ?)');
    leaky = Number(insert.run(lessonId, 'concept', 'Bakit nagbabago ang wika kasabay ng pamumuhay at kultura?', 'Nagbabago ang wika kasabay ng pamumuhay at kultura.', 'patuloy itong nagbabago kasabay ng pamumuhay at kultura', 1).lastInsertRowid);
    clean = Number(insert.run(lessonId, 'concept', 'Paano ginagamit ang Wikang Filipino sa edukasyon?', 'Upang mas madaling maipaliwanag ang mga konsepto.', 'upang mas madaling maipaliwanag ang mga konsepto', 2).lastInsertRowid);
    term = Number(insert.run(lessonId, 'term', 'Wikang Filipino', 'Ang Wikang Filipino ang pambansang wika ng bansa.', 'Ginagamit ang Wikang Filipino sa edukasyon', 3).lastInsertRowid);
    t.db.prepare("INSERT INTO quiz_distractors (flashcard_id, choices, made_at) VALUES (?, '[\"a\",\"b\",\"c\"]', 'x')").run(leaky);
  });
  afterEach(async () => {
    await t.close();
  });

  it('the lesson list counts them, and the leak report lists them with the rules they break', async () => {
    const row = (await call('GET', '/api/lessons')).body.lessons.find((l) => l.id === lessonId);
    assert.deepEqual(row.leaks, { cards: 2 });
    const res = await call('GET', `/api/admin/lessons/${lessonId}/leaks`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.cards.flagged.map((c) => [c.id, [...new Set(c.rules.map((r) => r.rule))]]), [[leaky, ['g', 'k']], [term, ['h']]]);
    assert.equal(res.body.can_regenerate, true);
    assert.equal(typeof res.body.quiz.clean_questions, 'number');
    assert.equal((await call('GET', `/api/admin/lessons/${lessonId}/leaks`, { pin: null })).status, 401);
    assert.equal((await call('GET', '/api/admin/lessons/999/leaks')).status, 404);
  });

  it('regenerates a concept card in place and clears its saved quiz answers', async () => {
    ai.reply = { question: 'Bakit tinatawag na dinamiko ang wika ayon sa aralin?', answer: 'Sumasabay ito sa pamumuhay at kultura ng mga tao.', evidence: 'patuloy itong nagbabago kasabay ng pamumuhay at kultura' };
    const res = await call('POST', `/api/admin/flashcards/${leaky}/regenerate`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.card.id, leaky);
    const row = t.db.prepare('SELECT front, back, evidence FROM flashcards WHERE id = ?').get(leaky);
    assert.deepEqual(row, { front: ai.reply.question, back: ai.reply.answer, evidence: ai.reply.evidence });
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM quiz_distractors WHERE flashcard_id = ?').get(leaky).n, 0);
    assert.match(ai.calls[0].user, /What gives it away: .*front holds/);
    assert.match(ai.calls[0].system, /must not contain any of these answers from other cards: .*Upang mas madaling/);
    const list = (await call('GET', '/api/lessons')).body.lessons.find((l) => l.id === lessonId);
    assert.deepEqual([list.leaks.cards, list.quiz_options.missing], [1, 2], 'one left (the term card); the new card needs quiz answers again');
  });

  it('regenerates a term card’s definition only, and refuses one that still names the term', async () => {
    ai.reply = { definition: 'Ang Wikang Filipino ay ginagamit sa paaralan.' };
    const still = await call('POST', `/api/admin/flashcards/${term}/regenerate`);
    assert.equal(still.status, 422);
    assert.equal(still.body.error.code, 'card_not_better');
    assert.match(still.body.error.message, /still gives its answer away \(h:/);
    assert.equal(t.db.prepare('SELECT back FROM flashcards WHERE id = ?').get(term).back, 'Ang Wikang Filipino ang pambansang wika ng bansa.', 'unchanged');

    ai.reply = { definition: 'Ang pambansang pananalita na ginagamit sa edukasyon upang maipaliwanag ang mga konsepto.' };
    const ok = await call('POST', `/api/admin/flashcards/${term}/regenerate`);
    assert.equal(ok.status, 200);
    assert.deepEqual(t.db.prepare('SELECT front, back, evidence FROM flashcards WHERE id = ?').get(term), {
      front: 'Wikang Filipino',
      back: ai.reply.definition,
      evidence: 'Ginagamit ang Wikang Filipino sa edukasyon',
    });
    assert.match(ai.calls[0].system, /term card: the student sees the definition and must name the term "Wikang Filipino"/);
  });

  it('refuses a new card whose quote isn’t in the lesson', async () => {
    ai.reply = { question: 'Ano ang katangian ng wika?', answer: 'Sumasabay ito sa pamumuhay ng tao.', evidence: 'a quote that is nowhere in the lesson text' };
    const res = await call('POST', `/api/admin/flashcards/${leaky}/regenerate`);
    assert.equal(res.status, 422);
    assert.match(res.body.error.message, /didn't check out/);
  });

  it('is blocked once a participant other than P00 has studied the lesson; P00 records don’t count', async () => {
    ai.reply = { question: 'Ano ang katangian ng wika ayon sa aralin?', answer: 'Sumasabay ito sa pamumuhay at kultura ng tao.', evidence: 'patuloy itong nagbabago kasabay ng pamumuhay at kultura' };
    const p00 = t.db.prepare("SELECT id FROM participants WHERE code = 'P00'").get().id;
    t.db.prepare("INSERT INTO events (participant_id, type, lesson_id, created_at, study_date) VALUES (?, 'stats_view', ?, 'x', '2026-10-05')").run(p00, lessonId);
    assert.equal((await call('GET', `/api/admin/lessons/${lessonId}/leaks`)).body.can_regenerate, true);

    const p01 = t.db.prepare("SELECT id FROM participants WHERE code = 'P01'").get().id;
    t.db.prepare("INSERT INTO flashcard_reviews (participant_id, flashcard_id, rating, reviewed_at, prev_interval, new_interval, state, ease) VALUES (?, ?, 3, 'x', 0, 1, 0, 2.5)").run(p01, clean);
    const res = await call('POST', `/api/admin/flashcards/${leaky}/regenerate`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'lesson_has_records');
    assert.equal(res.body.error.records.flashcard_answers, 1);
    assert.equal(ai.calls.length, 0);
    assert.equal((await call('GET', `/api/admin/lessons/${lessonId}/leaks`)).body.can_regenerate, false);
    assert.equal((await call('POST', `/api/admin/flashcards/${leaky}/regenerate`, { pin: null })).status, 401);
    assert.equal((await call('POST', '/api/admin/flashcards/999/regenerate')).status, 404);
  });
});
