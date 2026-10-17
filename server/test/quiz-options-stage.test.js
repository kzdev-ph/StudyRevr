import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AiError } from '../src/ai/client.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { getJobStatus, queueJob, STAGES } from '../src/pipeline/jobs.js';
import { createPipelineRunner } from '../src/pipeline/runner.js';
import { loadDistractors } from '../src/quiz/distractors.js';
import { addCodes, cleanReview, seedLesson, startStudyApp, TEST_PIN } from './helpers.js';

const quiet = { error() {}, warn() {}, log() {}, info() {} };

// A fake AI for the wrong-answers call. Set `fail` to make every call throw; `calls` counts them. The quiz review that
// follows the stage (services/quiz-review.js) flags nothing and is counted apart (`reviews`).
const fakeAi = () => {
  const ai = {
    fail: null,
    calls: 0,
    reviews: 0,
    async generateJSON({ user, schema, label }) {
      if (label?.startsWith('the quiz review')) {
        ai.reviews += 1;
        return schema.parse(cleanReview(user));
      }
      ai.calls += 1;
      if (ai.fail) throw ai.fail;
      const numbers = [...user.matchAll(/^\[(\d+)\] Question:/gm)].map((m) => Number(m[1]));
      return schema.parse({ items: numbers.map((n) => ({ n, wrong: [`Alpha topic answer ${n}.`, `Beta topic answer ${n}.`, `Gamma topic answer ${n}.`] })) });
    },
  };
  return ai;
};
const rateLimit = () => new AiError('rate_limit', 'The AI provider is rate limiting requests (HTTP 429). Try again shortly.');

describe('quiz answer options as a processing step', () => {
  let t;
  let ai;
  let runner;
  let lessonId;
  const call = (method, path, opts = {}) => t.call(method, path, { pin: TEST_PIN, ...opts });
  const saved = () => loadDistractors(t.db, lessonId).size;
  const runStage = async () => {
    queueJob(t.db, lessonId, { stage: 'quiz_options', keepLesson: true });
    runner.enqueue(lessonId);
    await runner.idle();
  };

  beforeEach(async () => {
    ai = fakeAi();
    const db = openDb(':memory:');
    runMigrations(db);
    runner = createPipelineRunner({ db, ai, log: quiet });
    t = await startStudyApp({ db, ai, runner });
    addCodes(t.db, 'P01');
    ({ lessonId } = seedLesson(t.db, { n: 4 }));
  });
  afterEach(async () => {
    await t.close();
    t.db.close();
  });

  it('comes after the flashcards, followed only by the quiz review', () => {
    assert.deepEqual(STAGES.slice(-3), ['flashcards', 'quiz_options', 'quiz_review']);
  });

  it('makes and saves the wrong answers; a lesson still processing becomes ready with a finished job', async () => {
    queueJob(t.db, lessonId, { stage: 'quiz_options' });
    assert.equal(getJobStatus(t.db, lessonId).lesson.status, 'processing');
    runner.enqueue(lessonId);
    await runner.idle();

    assert.equal(ai.calls, 1);
    assert.equal(saved(), 4);
    const { lesson, job } = getJobStatus(t.db, lessonId);
    assert.equal(lesson.status, 'ready');
    assert.deepEqual([job.stage, job.status, job.error], ['done', 'done', null]);
  });

  it('a student then starts the quiz without any AI call', async () => {
    await runStage();
    ai.fail = rateLimit(); // would fail the quiz start if it asked the AI
    const calls = ai.calls;

    const res = await t.call('POST', `/api/lessons/${lessonId}/quiz/attempts`, { as: 'P01', body: {} });
    assert.equal(res.status, 201);
    assert.equal(ai.calls, calls, 'no new AI call');
    assert.doesNotMatch(res.body.notice ?? '', /couldn’t be made/);
    assert.ok(res.body.questions.some((q) => q.type === 'mc'), 'the saved options make multiple-choice questions');
  });

  it('shows in the progress the upload page polls: the stage, running, with its batch count', async () => {
    const seen = [];
    const original = ai.generateJSON;
    ai.generateJSON = async (args) => {
      if (args.label?.startsWith('the quiz review')) return original(args);
      seen.push(getJobStatus(t.db, lessonId).job);
      return original(args);
    };
    await runStage();
    assert.equal(seen[0].stage, 'quiz_options');
    assert.equal(seen[0].status, 'running');
    assert.deepEqual(seen[0].progress, { done: 0, total: 1 });
    assert.deepEqual(getJobStatus(t.db, lessonId).job.progress, { done: 1, total: 1 });
  });

  it('skips the stage when every concept card already has its options', async () => {
    await runStage();
    const calls = ai.calls;
    await runStage();
    assert.equal(ai.calls, calls);
    assert.equal(getJobStatus(t.db, lessonId).job.status, 'done');
  });

  describe('when the AI fails', () => {
    beforeEach(async () => {
      ai.fail = rateLimit();
      await runStage();
    });

    it('the job records the error, but the lesson is ready with its review and cards intact', () => {
      const { lesson, job } = getJobStatus(t.db, lessonId);
      assert.deepEqual([lesson.status, lesson.error], ['ready', null]);
      assert.deepEqual([job.stage, job.status], ['quiz_options', 'failed']);
      assert.match(job.error, /quiz answer options couldn’t be made/);
      assert.match(job.error, /rate limiting/);
      assert.equal(saved(), 0);
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM flashcards WHERE lesson_id = ?').get(lessonId).n, 4);
    });

    it('a lesson that was still processing also ends up ready', async () => {
      const other = seedLesson(t.db, { title: 'Other' }).lessonId;
      queueJob(t.db, other, { stage: 'quiz_options' });
      runner.enqueue(other);
      await runner.idle();
      const { lesson, job } = getJobStatus(t.db, other);
      assert.equal(lesson.status, 'ready');
      assert.deepEqual([job.stage, job.status], ['quiz_options', 'failed']);
    });

    it('the lesson list tells admin which lesson needs it, and why', async () => {
      const row = (await call('GET', '/api/lessons?counts=1')).body.lessons.find((l) => l.id === lessonId);
      assert.equal(row.quiz_options.missing, 4);
      assert.equal(row.quiz_options.status, 'failed');
      assert.match(row.quiz_options.error, /rate limiting/);
    });

    it('the quiz still starts and makes the options itself, on demand (the fallback)', async () => {
      ai.fail = null;
      const calls = ai.calls;
      const res = await t.call('POST', `/api/lessons/${lessonId}/quiz/attempts`, { as: 'P01', body: {} });
      assert.equal(res.status, 201);
      assert.equal(ai.calls, calls + 1);
      assert.equal(saved(), 4);
    });

    it('and if the AI is still down it starts with true / false questions and a notice', async () => {
      const res = await t.call('POST', `/api/lessons/${lessonId}/quiz/attempts`, { as: 'P01', body: {} });
      assert.equal(res.status, 201);
      assert.match(res.body.notice, /couldn’t be made/);
      assert.ok(res.body.questions.every((q) => q.type === 'tf'));
    });

    it('admin retries with a button: it runs the stage again and keeps the lesson ready', async () => {
      ai.fail = null;
      const res = await call('POST', `/api/lessons/${lessonId}/quiz-options`);
      assert.equal(res.status, 202);
      assert.equal(res.body.lesson.status, 'ready');
      assert.deepEqual([res.body.job.stage, res.body.job.status], ['quiz_options', 'queued']);

      await runner.idle();
      assert.equal(saved(), 4);
      const { lesson, job } = getJobStatus(t.db, lessonId);
      assert.deepEqual([lesson.status, job.status], ['ready', 'done']);
      const row = (await call('GET', '/api/lessons?counts=1')).body.lessons.find((l) => l.id === lessonId);
      assert.equal(row.quiz_options.missing, 0);
    });

    it('a failed retry reports the error again and can be tried once more', async () => {
      assert.equal((await call('POST', `/api/lessons/${lessonId}/quiz-options`)).status, 202);
      await runner.idle();
      assert.equal(getJobStatus(t.db, lessonId).job.status, 'failed');
      ai.fail = null;
      assert.equal((await call('POST', `/api/lessons/${lessonId}/quiz-options`)).status, 202);
      await runner.idle();
      assert.equal(saved(), 4);
    });
  });

  it('a failed batch keeps the batches that worked, so a retry only asks for the rest', async () => {
    const insert = t.db.prepare("INSERT INTO flashcards (lesson_id, kind, front, back, evidence, position) VALUES (?, 'concept', ?, ?, 'quote', ?)");
    for (let i = 5; i <= 20; i++) insert.run(lessonId, `Extra Q${i}: what about the topic?`, `Topic answer ${i} about rivers and lakes.`, i); // 20 cards: batches of 15 and 5
    const original = ai.generateJSON;
    let n = 0;
    ai.generateJSON = (args) => (args.label?.startsWith('the quiz review') ? original(args) : ++n === 2 ? Promise.reject(rateLimit()) : original(args));

    await runStage();
    assert.equal(getJobStatus(t.db, lessonId).job.status, 'failed');
    assert.equal(saved(), 15);

    assert.equal((await call('POST', `/api/lessons/${lessonId}/quiz-options`)).status, 202);
    await runner.idle();
    assert.equal(saved(), 20);
    assert.equal(n, 3, 'the retry asked only for the 5 left');
  });

  it('the retry route needs the admin PIN and refuses when the lesson is busy or has nothing to make', async () => {
    assert.equal((await call('POST', `/api/lessons/${lessonId}/quiz-options`, { pin: null })).status, 401);
    assert.equal((await call('POST', '/api/lessons/9999/quiz-options')).status, 404);

    queueJob(t.db, lessonId); // processing
    assert.equal((await call('POST', `/api/lessons/${lessonId}/quiz-options`)).status, 409);
    t.db.prepare("UPDATE lessons SET status = 'failed' WHERE id = ?").run(lessonId);
    assert.equal((await call('POST', `/api/lessons/${lessonId}/quiz-options`)).status, 409);
    t.db.prepare("UPDATE lessons SET status = 'ready' WHERE id = ?").run(lessonId);
    t.db.prepare("UPDATE jobs SET status = 'running' WHERE lesson_id = ?").run(lessonId);
    assert.equal((await call('POST', `/api/lessons/${lessonId}/quiz-options`)).status, 409, 'already running');
    t.db.prepare("UPDATE jobs SET status = 'done', stage = 'done' WHERE lesson_id = ?").run(lessonId);

    assert.equal((await call('POST', `/api/lessons/${lessonId}/quiz-options`)).status, 202);
    await runner.idle();
    assert.equal((await call('POST', `/api/lessons/${lessonId}/quiz-options`)).status, 409, 'nothing left to make');
    assert.equal(ai.calls, 1);
  });

  it('a quiz started while the stage is running shares its AI call', async () => {
    let release;
    const original = ai.generateJSON;
    ai.generateJSON = async (args) => {
      if (args.label?.startsWith('the quiz review')) return original(args);
      await new Promise((resolve) => { release = resolve; });
      return original(args);
    };
    queueJob(t.db, lessonId, { stage: 'quiz_options', keepLesson: true });
    runner.enqueue(lessonId);
    while (!release) await new Promise((resolve) => setImmediate(resolve)); // the stage's call is waiting

    const start = t.call('POST', `/api/lessons/${lessonId}/quiz/attempts`, { as: 'P01', body: {} });
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    assert.equal((await start).status, 201);
    await runner.idle();
    assert.equal(ai.calls, 1, 'one call served both');
  });
});
