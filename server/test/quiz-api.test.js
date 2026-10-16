import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AiError } from '../src/ai/client.js';
import { createApp } from '../src/app.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { createRng } from '../src/flashcards/scheduler.js';
import { studyFetch, TEST_PIN } from './helpers.js';

const fetch = studyFetch; // as participant P00, with the admin PIN (see helpers.js)

const NOON = '2026-10-05T04:00:00.000Z';

describe('quiz API', () => {
  let db;
  let server;
  let base;
  let now;
  let ai;

  const start = async (reply = (cards) => ({ items: cards.map((n) => ({ n, wrong: [`Alpha topic ${n}`, `Beta topic ${n}`, `Gamma topic ${n}`] })) })) => {
    ai = {
      calls: [],
      async generateJSON({ schema, label, user }) {
        const ns = [...user.matchAll(/^\[(\d+)\] Question:/gm)].map((m) => Number(m[1]));
        ai.calls.push({ label, ns });
        return schema.parse(await reply(ns));
      },
    };
    const runner = { enqueue() {}, idle: async () => {} };
    const app = createApp(db, { maxUploadBytes: 1024 * 1024, adminPin: TEST_PIN }, { ai, runner, clock: () => new Date(now), random: createRng(1) });
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const send = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const later = (ms) => { now = new Date(Date.parse(now) + ms).toISOString(); };

  const addLesson = (title, status = 'ready') =>
    Number(db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status) VALUES (?, ?, 'The topic: alpha, beta and gamma.', 200, ?)").run(title, `${title}.pptx`, status).lastInsertRowid);
  const addCards = (lessonId, n, kind = 'concept') => {
    const insert = db.prepare("INSERT INTO flashcards (lesson_id, kind, front, back, evidence, position) VALUES (?, ?, ?, ?, ?, ?)");
    return Array.from({ length: n }, (_, i) =>
      Number(insert.run(lessonId, kind, kind === 'term' ? `Term ${i + 1}` : `Question ${i + 1} about the topic?`, `Topic ${kind} n${i + 1}.`, `quote ${kind} ${i + 1}`, i + 1).lastInsertRowid),
    );
  };
  const flashcardState = () => db.prepare('SELECT id, state, ease, interval, due_at, reps, lapses, step FROM flashcards ORDER BY id').all();
  // the right option for a question, read from the database (the API never sends it before an answer)
  const rightChoice = (attemptId, position) => db.prepare('SELECT answer_index FROM quiz_answers WHERE attempt_id = ? AND position = ?').get(attemptId, position).answer_index;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    now = NOON;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  it('starts a 10-question quiz without sending the answers, and makes wrong answers once', async () => {
    await start();
    const id = addLesson('Inquiry');
    addCards(id, 8);
    addCards(id, 6, 'term');
    const res = await send('POST', `/api/lessons/${id}/quiz/attempts`);
    assert.equal(res.status, 201);
    assert.equal(res.body.questions.length, 10);
    assert.equal(res.body.notice, null);
    assert.deepEqual([res.body.attempt.total, res.body.attempt.retake_of, res.body.attempt.started_at, res.body.attempt.finished_at], [10, null, NOON, null]);
    for (const q of res.body.questions) {
      assert.deepEqual(Object.keys(q).sort(), ['choices', 'kind', 'position', 'question', 'statement', 'type']);
      assert.equal(q.choices.length, q.type === 'mc' ? 4 : 2);
    }
    assert.deepEqual(res.body.questions.map((q) => q.position), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(ai.calls.length, 1);
    assert.equal(ai.calls[0].label, 'the quiz answer options');
    assert.equal(ai.calls[0].ns.length, 8, 'concept cards only');

    await send('POST', `/api/lessons/${id}/quiz/attempts`);
    assert.equal(ai.calls.length, 1, 'saved wrong answers are reused');
  });

  it('grades each answer once, logs time, and finishing returns score and missed questions', async () => {
    await start();
    const id = addLesson('Inquiry');
    addCards(id, 6);
    addCards(id, 6, 'term');
    const before = flashcardState();
    const { body } = await send('POST', `/api/lessons/${id}/quiz/attempts`);
    const attemptId = body.attempt.id;

    const early = await send('POST', `/api/quiz/attempts/${attemptId}/finish`, { total_ms: 1000 });
    assert.equal(early.status, 409);

    for (const q of body.questions) {
      const right = rightChoice(attemptId, q.position);
      const choice = q.position < 2 ? (right + 1) % q.choices.length : right; // miss the first two
      later(5000);
      const r = await send('POST', `/api/quiz/attempts/${attemptId}/answers`, { position: q.position, choice, time_ms: 4200 });
      assert.equal(r.status, 200);
      assert.equal(r.body.correct, q.position >= 2);
      assert.equal(r.body.answer_index, right);
      assert.match(r.body.evidence, /^quote /);
      assert.ok(r.body.answer_text);
    }
    const again = await send('POST', `/api/quiz/attempts/${attemptId}/answers`, { position: 0, choice: 0 });
    assert.equal(again.status, 409, 'a question is answered once');

    const rows = db.prepare('SELECT position, chosen_index, correct, time_ms, answered_at FROM quiz_answers WHERE attempt_id = ? ORDER BY position').all(attemptId);
    assert.equal(rows.length, 10);
    assert.equal(rows[0].correct, 0);
    assert.equal(rows[2].correct, 1);
    assert.equal(rows[0].time_ms, 4200);
    assert.equal(rows[0].answered_at, '2026-10-05T04:00:05.000Z');
    assert.equal(rows[9].answered_at, '2026-10-05T04:00:50.000Z');

    later(1000);
    const done = await send('POST', `/api/quiz/attempts/${attemptId}/finish`, { total_ms: 51_000 });
    assert.equal(done.status, 200);
    assert.deepEqual([done.body.attempt.score, done.body.attempt.total, done.body.attempt.percent], [8, 10, 80]);
    assert.deepEqual([done.body.attempt.finished_at, done.body.attempt.duration_ms], ['2026-10-05T04:00:51.000Z', 51_000]);
    assert.deepEqual(done.body.missed.map((m) => m.position), [0, 1]);
    for (const m of done.body.missed) {
      assert.ok(m.your_answer && m.right_answer && m.your_answer !== m.right_answer);
      assert.match(m.evidence, /^quote /);
    }
    assert.equal(done.body.previous_best_percent, null, 'first finished attempt');

    const twice = await send('POST', `/api/quiz/attempts/${attemptId}/finish`, { total_ms: 99_000 });
    assert.equal(twice.body.attempt.duration_ms, 51_000, 'finishing again changes nothing');
    assert.equal((await send('POST', `/api/quiz/attempts/${attemptId}/answers`, { position: 0, choice: 0 })).status, 409);

    assert.deepEqual(flashcardState(), before, 'the quiz never touches flashcard scheduling');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM flashcard_reviews').get().n, 0);
  });

  it('a retake asks the same questions in a new order and records retake_of', async () => {
    await start();
    const id = addLesson('Inquiry');
    addCards(id, 8);
    addCards(id, 6, 'term');
    const first = (await send('POST', `/api/lessons/${id}/quiz/attempts`)).body;
    const retake = await send('POST', `/api/lessons/${id}/quiz/attempts`, { retake_of: first.attempt.id });
    assert.equal(retake.status, 201);
    assert.equal(retake.body.attempt.retake_of, first.attempt.id);
    assert.equal(ai.calls.length, 1);
    const key = (q) => `${q.type}|${q.question}|${q.statement}`;
    assert.deepEqual(retake.body.questions.map(key).sort(), first.questions.map(key).sort());
    assert.notDeepEqual(retake.body.questions.map(key), first.questions.map(key));
    const cardsOf = (attemptId) => db.prepare('SELECT flashcard_id FROM quiz_answers WHERE attempt_id = ? ORDER BY flashcard_id').all(attemptId);
    assert.deepEqual(cardsOf(retake.body.attempt.id), cardsOf(first.attempt.id));

    const other = addLesson('Other');
    addCards(other, 3);
    assert.equal((await send('POST', `/api/lessons/${other}/quiz/attempts`, { retake_of: first.attempt.id })).status, 400);
    assert.equal((await send('POST', `/api/lessons/${id}/quiz/attempts`, { retake_of: 999 })).status, 404);
  });

  it('results compare with the best earlier finished score', async () => {
    await start();
    const id = addLesson('Inquiry');
    addCards(id, 4);
    const take = async (rightCount, retakeOf) => {
      const { body } = await send('POST', `/api/lessons/${id}/quiz/attempts`, retakeOf ? { retake_of: retakeOf } : {});
      for (const q of body.questions) {
        const right = rightChoice(body.attempt.id, q.position);
        await send('POST', `/api/quiz/attempts/${body.attempt.id}/answers`, { position: q.position, choice: q.position < rightCount ? right : (right + 1) % q.choices.length });
      }
      return (await send('POST', `/api/quiz/attempts/${body.attempt.id}/finish`, { total_ms: 1000 })).body;
    };
    const first = await take(2);
    assert.deepEqual([first.attempt.percent, first.previous_best_percent], [50, null]);
    const second = await take(4, first.attempt.id);
    assert.deepEqual([second.attempt.percent, second.previous_best_percent, second.attempt.retake_of], [100, 50, first.attempt.id]);
    const third = await take(1);
    assert.equal(third.previous_best_percent, 100);
  });

  it('a short lesson gets fewer questions and says so', async () => {
    await start();
    const id = addLesson('Short');
    addCards(id, 4);
    const res = await send('POST', `/api/lessons/${id}/quiz/attempts`);
    assert.equal(res.status, 201);
    assert.equal(res.body.questions.length, 4);
    assert.equal(res.body.notice, 'This lesson supports 4 questions.');
  });

  it('when the AI fails the quiz still starts, with true / false from other cards’ answers, and a notice', async () => {
    await start(() => {
      throw new AiError('rate_limited', 'The AI provider is rate limiting requests. Try again shortly.', 429);
    });
    const id = addLesson('Inquiry');
    addCards(id, 5);
    const res = await send('POST', `/api/lessons/${id}/quiz/attempts`);
    assert.equal(res.status, 201);
    assert.equal(res.body.questions.length, 5);
    assert.ok(res.body.questions.every((q) => q.type === 'tf'));
    assert.match(res.body.notice, /supports 5 questions\. Answer options for some questions couldn’t be made, so they are true or false this time\./);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM quiz_distractors').get().n, 0, 'nothing cached, so the next quiz tries again');
  });

  it('two quick starts share one wrong-answers call', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await start(async (ns) => {
      await gate;
      return { items: ns.map((n) => ({ n, wrong: [`Alpha topic ${n}`, `Beta topic ${n}`, `Gamma topic ${n}`] })) };
    });
    const id = addLesson('Inquiry');
    addCards(id, 5);
    const a = send('POST', `/api/lessons/${id}/quiz/attempts`);
    const b = send('POST', `/api/lessons/${id}/quiz/attempts`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const [ra, rb] = [await a, await b];
    assert.deepEqual([ra.status, rb.status].sort(), [200, 201], 'one starts the quiz, the other picks it up');
    assert.equal(ra.body.attempt.id, rb.body.attempt.id);
    assert.equal(ai.calls.length, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM quiz_attempts').get().n, 1);
  });

  describe('resuming', () => {
    const answerFirst = async (attempt, n, ms = 3000) => {
      for (let position = 0; position < n; position += 1) {
        const r = await send('POST', `/api/quiz/attempts/${attempt.id}/answers`, { position, choice: rightChoice(attempt.id, position), time_ms: ms });
        assert.equal(r.status, 200);
      }
    };
    const setup = async () => {
      await start();
      const id = addLesson('Inquiry');
      addCards(id, 8);
      addCards(id, 6, 'term');
      return id;
    };
    const attemptCount = () => db.prepare('SELECT COUNT(*) AS n FROM quiz_attempts').get().n;

    it('returns an unfinished attempt started under 2 hours ago, at its first unanswered question', async () => {
      const id = await setup();
      const first = (await send('POST', `/api/lessons/${id}/quiz/attempts`)).body;
      await answerFirst(first.attempt, 3);
      later(90 * 60 * 1000);

      const res = await send('POST', `/api/lessons/${id}/quiz/attempts`);
      assert.equal(res.status, 200);
      assert.equal(res.body.resumed, true);
      assert.equal(res.body.attempt.id, first.attempt.id);
      assert.equal(res.body.next_position, 3);
      assert.equal(res.body.elapsed_ms, 9000);
      assert.match(res.body.notice, /question 4 of 10/);
      assert.deepEqual(res.body.questions.map((q) => q.question), first.questions.map((q) => q.question), 'same questions, same order');
      for (const q of res.body.questions) assert.deepEqual(Object.keys(q).sort(), ['choices', 'kind', 'position', 'question', 'statement', 'type']);
      assert.equal(attemptCount(), 1);

      // it carries on: the answered ones stay answered, the rest can be answered and finished
      assert.equal((await send('POST', `/api/quiz/attempts/${first.attempt.id}/answers`, { position: 0, choice: 0 })).status, 409);
      for (let position = 3; position < 10; position += 1) {
        await send('POST', `/api/quiz/attempts/${first.attempt.id}/answers`, { position, choice: rightChoice(first.attempt.id, position) });
      }
      const done = await send('POST', `/api/quiz/attempts/${first.attempt.id}/finish`, { total_ms: 60_000 });
      assert.equal(done.status, 200);
      assert.deepEqual([done.body.attempt.score, done.body.attempt.total], [10, 10]);
    });

    it('starts a fresh attempt once the unfinished one is 2 hours old, and leaves the old one alone', async () => {
      const id = await setup();
      const first = (await send('POST', `/api/lessons/${id}/quiz/attempts`)).body;
      await answerFirst(first.attempt, 2);
      later(2 * 60 * 60 * 1000);

      const res = await send('POST', `/api/lessons/${id}/quiz/attempts`);
      assert.equal(res.status, 201);
      assert.equal(res.body.resumed, false);
      assert.notEqual(res.body.attempt.id, first.attempt.id);
      assert.equal(res.body.next_position, 0);
      assert.equal(attemptCount(), 2);
      const old = db.prepare('SELECT finished_at, started_at FROM quiz_attempts WHERE id = ?').get(first.attempt.id);
      assert.deepEqual([old.finished_at, old.started_at], [null, NOON], 'the old attempt is untouched');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM quiz_answers WHERE attempt_id = ? AND chosen_index IS NOT NULL').get(first.attempt.id).n, 2);
    });

    it('a reload does not create a second attempt', async () => {
      const id = await setup();
      const first = (await send('POST', `/api/lessons/${id}/quiz/attempts`)).body;
      for (let i = 0; i < 3; i += 1) {
        later(60_000);
        const again = await send('POST', `/api/lessons/${id}/quiz/attempts`);
        assert.equal(again.body.attempt.id, first.attempt.id);
        assert.equal(again.body.next_position, 0);
        assert.equal(again.body.notice, 'Picking up where you left off, at question 1 of 10.');
      }
      assert.equal(attemptCount(), 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM quiz_answers').get().n, 10);
    });

    it('does not resume a finished attempt, another lesson’s attempt, or when a retake is asked for', async () => {
      const id = await setup();
      const other = addLesson('Other');
      addCards(other, 4);
      const first = (await send('POST', `/api/lessons/${id}/quiz/attempts`)).body;
      const elsewhere = (await send('POST', `/api/lessons/${other}/quiz/attempts`)).body;
      assert.notEqual(elsewhere.attempt.id, first.attempt.id);

      const retake = await send('POST', `/api/lessons/${id}/quiz/attempts`, { retake_of: first.attempt.id });
      assert.equal(retake.status, 201);
      assert.equal(retake.body.attempt.retake_of, first.attempt.id);

      await answerFirst(retake.body.attempt, 10);
      assert.equal((await send('POST', `/api/quiz/attempts/${retake.body.attempt.id}/finish`, { total_ms: 1000 })).status, 200);
      // the first attempt is still open and is the one that resumes
      const res = await send('POST', `/api/lessons/${id}/quiz/attempts`);
      assert.equal(res.body.attempt.id, first.attempt.id);
      assert.equal(res.body.resumed, true);
    });

    it('an attempt with every question answered but not finished resumes with nothing left to answer', async () => {
      const id = await setup();
      const first = (await send('POST', `/api/lessons/${id}/quiz/attempts`)).body;
      await answerFirst(first.attempt, 10);
      const res = await send('POST', `/api/lessons/${id}/quiz/attempts`);
      assert.equal(res.body.attempt.id, first.attempt.id);
      assert.equal(res.body.next_position, null);
      assert.equal(res.body.notice, null);
    });

    it('leaves flashcard scheduling alone', async () => {
      const id = await setup();
      const before = flashcardState();
      const first = (await send('POST', `/api/lessons/${id}/quiz/attempts`)).body;
      await answerFirst(first.attempt, 4);
      await send('POST', `/api/lessons/${id}/quiz/attempts`);
      assert.deepEqual(flashcardState(), before);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM flashcard_reviews').get().n, 0);
    });
  });

  it('refuses lessons that cannot be quizzed, with clear messages', async () => {
    await start();
    const none = addLesson('No cards');
    assert.equal((await send('POST', `/api/lessons/${none}/quiz/attempts`)).status, 409);
    const one = addLesson('One card');
    addCards(one, 1);
    const single = await send('POST', `/api/lessons/${one}/quiz/attempts`);
    assert.equal(single.status, 409);
    assert.match(single.body.error.message, /at least 2/);
    const busy = addLesson('Busy', 'processing');
    assert.equal((await send('POST', `/api/lessons/${busy}/quiz/attempts`)).status, 409);
    assert.equal((await send('POST', '/api/lessons/999/quiz/attempts')).status, 404);
    assert.equal((await send('POST', '/api/lessons/abc/quiz/attempts')).status, 400);
    assert.equal(ai.calls.length, 0);
  });

  it('rejects bad answers', async () => {
    await start();
    const id = addLesson('Inquiry');
    addCards(id, 4);
    const { body } = await send('POST', `/api/lessons/${id}/quiz/attempts`);
    const url = `/api/quiz/attempts/${body.attempt.id}/answers`;
    assert.equal((await send('POST', url, { position: 0 })).status, 400);
    assert.equal((await send('POST', url, { position: 0, choice: 9 })).status, 400);
    assert.equal((await send('POST', url, { position: 99, choice: 0 })).status, 404);
    assert.equal((await send('POST', '/api/quiz/attempts/999/answers', { position: 0, choice: 0 })).status, 404);
    const capped = await send('POST', url, { position: 0, choice: 0, time_ms: 9e9 });
    assert.equal(capped.status, 200);
    assert.equal(db.prepare('SELECT time_ms FROM quiz_answers WHERE attempt_id = ? AND position = 0').get(body.attempt.id).time_ms, 3_600_000);
  });

  it('lists lessons with the questions they support and the best finished score', async () => {
    await start();
    const a = addLesson('Inquiry');
    addCards(a, 12);
    const b = addLesson('Short');
    addCards(b, 3);
    const c = addLesson('Empty');
    const { body } = await send('POST', `/api/lessons/${b}/quiz/attempts`);
    for (const q of body.questions) await send('POST', `/api/quiz/attempts/${body.attempt.id}/answers`, { position: q.position, choice: rightChoice(body.attempt.id, q.position) });
    await send('POST', `/api/quiz/attempts/${body.attempt.id}/finish`, { total_ms: 9000 });
    await send('POST', `/api/lessons/${b}/quiz/attempts`); // left part-way: not counted

    const list = await send('GET', '/api/quiz');
    assert.equal(list.status, 200);
    assert.equal(list.body.quiz_length, 10);
    const row = (id) => list.body.lessons.find((l) => l.lesson_id === id);
    assert.deepEqual([row(a).questions, row(a).attempts, row(a).best], [10, 0, null]);
    assert.deepEqual([row(b).questions, row(b).attempts, row(b).best], [3, 1, { score: 3, total: 3, percent: 100 }]);
    assert.deepEqual([row(c).cards, row(c).questions], [0, 0]);
  });

  it('deleting a lesson removes its attempts and answers', async () => {
    await start();
    const id = addLesson('Inquiry');
    addCards(id, 4);
    await send('POST', `/api/lessons/${id}/quiz/attempts`);
    db.prepare('DELETE FROM lessons WHERE id = ?').run(id);
    for (const table of ['quiz_attempts', 'quiz_answers', 'quiz_distractors']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  });

  it('keeps the logged questions when a card is deleted', async () => {
    await start();
    const id = addLesson('Inquiry');
    addCards(id, 4);
    const { body } = await send('POST', `/api/lessons/${id}/quiz/attempts`);
    db.prepare('DELETE FROM flashcards WHERE lesson_id = ?').run(id);
    const rows = db.prepare('SELECT flashcard_id, question FROM quiz_answers WHERE attempt_id = ?').all(body.attempt.id);
    assert.equal(rows.length, 4);
    assert.ok(rows.every((r) => r.flashcard_id === null && r.question));
  });
});
