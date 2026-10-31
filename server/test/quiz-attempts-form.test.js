import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { createRng } from '../src/flashcards/scheduler.js';
import { cardHash } from '../src/quiz/review-flags.js';
import { seedTestLogin, studyFetch, TEST_PIN } from './helpers.js';

const fetch = studyFetch; // as participant P00, with the admin PIN (see helpers.js)

const NOON = '2026-10-05T04:00:00.000Z';

describe('quiz attempts keep the True/False form', () => {
  let db;
  let server;
  let base;

  const send = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  beforeEach(async () => {
    db = openDb(':memory:');
    runMigrations(db);
    const ai = {
      async generateJSON({ schema, user }) {
        const ns = [...user.matchAll(/^\[(\d+)\] Question:/gm)].map((m) => Number(m[1]));
        return schema.parse({ items: ns.map((n) => ({ n, wrong: [`Alpha topic ${n}`, `Beta topic ${n}`, `Gamma topic ${n}`] })) });
      },
    };
    seedTestLogin(db);
    const app = createApp(db, { maxUploadBytes: 1024 * 1024, adminPin: TEST_PIN }, { ai, runner: { enqueue() {}, idle: async () => {} }, clock: () => new Date(NOON), random: createRng(1) });
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  const rightChoice = (attemptId, position) => db.prepare('SELECT answer_index FROM quiz_answers WHERE attempt_id = ? AND position = ?').get(attemptId, position).answer_index;
  const answerAll = async (attemptId, questions, wrongAt) => {
    for (const q of questions) {
      const right = rightChoice(attemptId, q.position);
      const choice = q.position === wrongAt ? (right + 1) % q.choices.length : right;
      assert.equal((await send('POST', `/api/quiz/attempts/${attemptId}/answers`, { position: q.position, choice, time_ms: 1000 })).status, 200);
    }
  };

  it('stores form on the answer, returns it only when set, and keeps it on resume, retake and results', async () => {
    const lessonId = Number(db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status) VALUES ('Inquiry', 'inquiry.pptx', 'The topic: alpha, beta and gamma.', 200, 'ready')").run().lastInsertRowid);
    const insert = db.prepare("INSERT INTO flashcards (lesson_id, kind, front, back, evidence, position) VALUES (?, 'concept', ?, ?, ?, ?)");
    const cards = Array.from({ length: 10 }, (_, i) => ({ id: Number(insert.run(lessonId, `Question ${i + 1} about the topic?`, `Topic concept n${i + 1}.`, `quote ${i + 1}`, i + 1).lastInsertRowid), n: i + 1 }));
    const [card] = cards;
    const trueText = 'The topic holds that rivers carry fresh water to the sea.';
    const falseText = 'The topic holds that rivers carry salt water away from the sea.';
    db.prepare("INSERT INTO quiz_statements (flashcard_id, card_hash, true_text, false_text, status) VALUES (?, ?, ?, ?, 'ok')").run(
      card.id,
      cardHash({ front: `Question ${card.n} about the topic?`, back: `Topic concept n${card.n}.` }),
      trueText,
      falseText,
    );

    // start quizzes (closing each one that has no statement question) until one has it
    let first;
    for (let i = 0; i < 60 && !first; i += 1) {
      const { status, body } = await send('POST', `/api/lessons/${lessonId}/quiz/attempts`);
      assert.equal(status, 201);
      if (body.questions.some((q) => q.form)) first = body;
      else db.prepare("UPDATE quiz_attempts SET finished_at = ? WHERE id = ?").run(NOON, body.attempt.id);
    }
    assert.ok(first, 'a quiz with the statement question');

    const q = first.questions.find((x) => x.form);
    assert.equal(q.form, 'statement');
    assert.equal(q.type, 'tf');
    assert.ok([trueText, falseText].includes(q.statement), 'a full sentence');
    assert.equal(db.prepare('SELECT form FROM quiz_answers WHERE attempt_id = ? AND position = ?').get(first.attempt.id, q.position).form, 'statement');
    for (const other of first.questions.filter((x) => !x.form)) assert.ok(!('form' in other), 'no form key on the others');

    // a resume of the open attempt keeps it
    const resume = await send('POST', `/api/lessons/${lessonId}/quiz/attempts`);
    assert.equal(resume.body.resumed, true);
    assert.equal(resume.body.questions.find((x) => x.position === q.position).form, 'statement');

    // wrong on the statement question: the answer text is the true sentence
    const wrong = await send('POST', `/api/quiz/attempts/${first.attempt.id}/answers`, { position: q.position, choice: (rightChoice(first.attempt.id, q.position) + 1) % 2, time_ms: 1000 });
    assert.equal(wrong.body.correct, false);
    assert.equal(wrong.body.answer_text, trueText);
    await answerAll(first.attempt.id, first.questions.filter((x) => x.position !== q.position));

    const done = await send('POST', `/api/quiz/attempts/${first.attempt.id}/finish`, { total_ms: 9000 });
    assert.equal(done.status, 200);
    const missed = done.body.missed.find((m) => m.position === q.position);
    assert.equal(missed.form, 'statement');
    assert.equal(missed.answer_text, trueText);
    assert.ok(done.body.missed.every((m) => m.form === undefined || m.form === 'statement'));

    // a retake asks the same questions again, with the form
    const retake = await send('POST', `/api/lessons/${lessonId}/quiz/attempts`, { retake_of: first.attempt.id });
    assert.equal(retake.status, 201);
    const again = retake.body.questions.find((x) => x.statement === q.statement);
    assert.equal(again.form, 'statement');
    assert.deepEqual(
      retake.body.questions.filter((x) => x.form).map((x) => x.statement),
      first.questions.filter((x) => x.form).map((x) => x.statement),
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM quiz_answers WHERE attempt_id = ? AND form = 'statement'").get(retake.body.attempt.id).n, first.questions.filter((x) => x.form).length);
  });
});
