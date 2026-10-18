import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AiError } from '../src/ai/client.js';
import { createApp } from '../src/app.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { loadSchedulerConfig } from '../src/flashcards/config.js';
import { createPipelineRunner } from '../src/pipeline/runner.js';
import { addCodes, seedLesson, TEST_PIN } from './helpers.js';

const quiet = { warn() {}, log() {}, info() {}, error() {} };

describe('admin: prepare simpler and Taglish versions', () => {
  let db;
  let server;
  let base;
  let runner;
  let calls;
  let fail; // (label, user) -> true to make that call fail
  let lessonId;

  const ai = {
    async generateJSON({ user, schema, label, config, live }) {
      calls.push({ label, user, config, live });
      if (fail(label, user)) throw new AiError('rate_limit', 'The AI provider is rate limiting requests (HTTP 429). Try again shortly.');
      const reply = label.includes('simpler') ? { simple: 'Simple.', example: 'Like a line.' } : { title: 'Pamagat', content: 'Laman.', check_questions: [] };
      return schema.parse(reply);
    },
  };

  beforeEach(async () => {
    calls = [];
    fail = () => false;
    db = openDb(':memory:');
    runMigrations(db);
    db.prepare("INSERT INTO settings (key, value) VALUES ('show_taglish', 'true')").run(); // students see Filipino/Taglish
    addCodes(db, 'P01');
    ({ lessonId } = seedLesson(db));
    runner = createPipelineRunner({ db, ai, log: quiet, tuning: () => ({ concurrency: 2, madeBy: { provider: 'google', model: 'gemini-3.5-flash-lite' } }) });
    const app = createApp(db, { maxUploadBytes: 1024 * 1024, adminPin: TEST_PIN, clientDist: null }, { ai, runner });
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  const call = async (method, path, { pin = TEST_PIN, as, body } = {}) => {
    const headers = {};
    if (pin) headers['x-admin-pin'] = pin;
    if (as) headers['x-participant'] = as;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const listed = async () => (await call('GET', '/api/lessons')).body.lessons.find((l) => l.id === lessonId).section_versions;
  const prepare = async () => {
    const res = await call('POST', `/api/lessons/${lessonId}/section-versions`);
    await runner.idle();
    return res;
  };

  it('makes every missing version with the Default, saves them shared, and taps then need no AI call', async () => {
    assert.deepEqual(await listed(), { missing: 4, total: 4, status: null, error: null, progress: null });
    const res = await prepare();
    assert.equal(res.status, 202);
    assert.equal(calls.length, 4);
    assert.ok(calls.every((c) => c.config === undefined && !c.live), 'the pipeline client with the admin Default, not a live call');
    const rows = db.prepare('SELECT simple_version, filipino_version, simple_made_by, filipino_made_by FROM sections WHERE lesson_id = ?').all(lessonId);
    for (const r of rows) {
      assert.ok(r.simple_version && r.filipino_version);
      assert.deepEqual([r.simple_made_by, r.filipino_made_by], ['google/gemini-3.5-flash-lite', 'google/gemini-3.5-flash-lite']);
    }
    const after = await listed();
    assert.deepEqual([after.missing, after.status], [0, null], 'a finished job reads as done');
    assert.equal(db.prepare('SELECT status FROM lessons WHERE id = ?').get(lessonId).status, 'ready');

    const section = db.prepare('SELECT id FROM sections WHERE lesson_id = ? ORDER BY position LIMIT 1').get(lessonId).id;
    const tap = await call('POST', `/api/sections/${section}/translate`, { pin: null, as: 'P01' });
    assert.equal(tap.body.cached, true);
    assert.equal(calls.length, 4);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_calls').get().n, 0, 'no live AI call');

    const again = await call('POST', `/api/lessons/${lessonId}/section-versions`);
    assert.equal(again.status, 409, 'nothing left to make');
  });

  it('a failed version leaves the lesson ready, reports the failure, and a retry makes only the rest', async () => {
    fail = (label, user) => label.includes('Taglish') && user.includes('Section title: Two');
    await prepare();
    const failed = await listed();
    assert.deepEqual([failed.missing, failed.status], [1, 'failed']);
    assert.match(failed.error, /1 simpler \/ Taglish version couldn’t be made/);
    assert.equal(db.prepare('SELECT status FROM lessons WHERE id = ?').get(lessonId).status, 'ready');

    calls = [];
    fail = () => false;
    await prepare();
    assert.equal(calls.length, 1);
    assert.equal((await listed()).missing, 0);
  });

  it('is admin only, and only for a ready lesson', async () => {
    assert.equal((await call('POST', `/api/lessons/${lessonId}/section-versions`, { pin: null })).status, 401);
    db.prepare("UPDATE lessons SET status = 'processing' WHERE id = ?").run(lessonId);
    assert.equal((await call('POST', `/api/lessons/${lessonId}/section-versions`)).status, 409);
  });
});

describe('admin settings: new cards per day and the student-key switch', () => {
  let db;
  let server;
  let base;

  beforeEach(async () => {
    db = openDb(':memory:');
    runMigrations(db);
    const app = createApp(db, { maxUploadBytes: 1024 * 1024, adminPin: TEST_PIN, clientDist: null }, { ai: {}, runner: { enqueue() {} } });
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  const send = async (method, body, pin = TEST_PIN) => {
    const headers = { 'content-type': 'application/json' };
    if (pin) headers['x-admin-pin'] = pin;
    const res = await fetch(`${base}/api/settings`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  it('reads the defaults, saves both, and the scheduler uses the new limit', async () => {
    assert.deepEqual((await send('GET')).body, { flashcard_new_per_day: 20, allow_student_keys: false, student_keys_saved: 0, allow_student_uploads: false, student_uploads_per_day: 2, lesson_thinking: 'low', show_taglish: false });
    const saved = await send('PUT', { flashcard_new_per_day: 12, allow_student_keys: true });
    assert.deepEqual(saved.body, { flashcard_new_per_day: 12, allow_student_keys: true, student_keys_saved: 0, allow_student_uploads: false, student_uploads_per_day: 2, lesson_thinking: 'low', show_taglish: false });
    assert.equal(loadSchedulerConfig(db).newPerDay, 12);
  });

  it('"Delete all student keys" removes every saved key, is behind the PIN, and the count follows', async () => {
    addCodes(db, 'P01', 'P02');
    for (const code of ['P01', 'P02']) {
      const id = db.prepare('SELECT id FROM participants WHERE code = ?').get(code).id;
      db.prepare("INSERT INTO participant_ai_keys VALUES (?, 'deepseek', 'deepseek-chat', 'sk-secret-to-delete-1234', '1234', 'x', 'x')").run(id);
    }
    assert.equal((await send('GET')).body.student_keys_saved, 2);
    const del = (pin) => fetch(`${base}/api/admin/student-keys`, { method: 'DELETE', headers: pin ? { 'x-admin-pin': pin } : {} });
    assert.equal((await del(null)).status, 401);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM participant_ai_keys').get().n, 2, 'nothing deleted without the PIN');
    const res = await del(TEST_PIN);
    assert.deepEqual([res.status, await res.json()], [200, { deleted: 2 }]);
    assert.equal((await send('GET')).body.student_keys_saved, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM admin_events WHERE type = 'student_keys_deleted'").get().n, 1);
    assert.deepEqual(await (await del(TEST_PIN)).json(), { deleted: 0 });
  });

  it('is behind the PIN and validates the values', async () => {
    assert.equal((await send('GET', undefined, null)).status, 401);
    assert.equal((await send('PUT', { flashcard_new_per_day: -1 })).status, 400);
    assert.equal((await send('PUT', { flashcard_new_per_day: 2.5 })).status, 400);
    assert.equal((await send('PUT', { something_else: 1 })).status, 400);
  });
});
