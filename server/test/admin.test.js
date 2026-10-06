import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addCodes, seedLesson, startStudyApp, TEST_PIN } from './helpers.js';

// Every route behind the admin PIN: the admin area itself and the routes moved behind it in Phase 6.
const adminRoutes = (lessonId) => [
  ['POST', '/api/admin/unlock'],
  ['GET', '/api/admin/participants'],
  ['POST', '/api/admin/participants', { codes: 'P05' }],
  ['GET', '/api/admin/participants/P01/stats'],
  ['GET', '/api/admin/export.zip'],
  ['GET', '/api/admin/export/summary.csv'],
  ['GET', '/api/admin/export/sessions.csv?include_p00=1'],
  ['POST', '/api/lessons'],
  ['POST', `/api/lessons/${lessonId}/retry`],
  ['DELETE', `/api/lessons/${lessonId}`],
  ['POST', `/api/lessons/${lessonId}/flashcards/generate`],
  ['GET', '/api/settings/ai'],
  ['PUT', '/api/settings/ai', { provider: 'ollama' }],
  ['GET', '/api/settings/models'],
  ['POST', '/api/settings/test-ai', {}],
];

describe('admin PIN', () => {
  let t;
  afterEach(() => t?.close());

  it('a missing or wrong PIN is rejected on every admin route, even with a participant code', async () => {
    t = await startStudyApp();
    addCodes(t.db, 'P01');
    const { lessonId } = seedLesson(t.db);
    for (const [method, path, body] of adminRoutes(lessonId)) {
      for (const pin of [undefined, 'wrong-pin', TEST_PIN.slice(0, -1)]) {
        t.now = new Date(Date.parse(t.now) + 2 * 60_000).toISOString(); // past any lockout, to see the 401 itself
        const res = await t.call(method, path, { as: 'P01', pin, body });
        assert.equal(res.status, 401, `${method} ${path} pin=${pin}`);
        assert.equal(res.body.error.code, 'admin_pin');
      }
    }
    // nothing changed: the lesson is still there, no code was added, no setting saved
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM lessons').get().n, 1);
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM participants WHERE code = 'P05'").get().n, 0);
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM settings WHERE key = 'ai_provider'").get().n, 0);
  });

  it('the right PIN opens the admin routes', async () => {
    t = await startStudyApp();
    addCodes(t.db, 'P01');
    seedLesson(t.db);
    assert.equal((await t.call('POST', '/api/admin/unlock', { pin: TEST_PIN })).status, 204);
    const list = await t.call('GET', '/api/admin/participants', { pin: TEST_PIN });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.participants.map((p) => p.participant), ['P00', 'P01']);
    assert.equal((await t.call('GET', '/api/admin/participants/P01/stats', { pin: TEST_PIN })).body.participant, 'P01');
    assert.equal((await t.call('GET', '/api/admin/export/summary.csv', { pin: TEST_PIN })).status, 200);
    // viewing someone's stats as admin is not their stats_view
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM events').get().n, 0);
  });

  it('with no ADMIN_PIN set, admin is off for everyone', async () => {
    t = await startStudyApp({ adminPin: '' });
    const { lessonId } = seedLesson(t.db);
    for (const [method, path, body] of adminRoutes(lessonId)) {
      for (const pin of [undefined, '', TEST_PIN]) {
        const res = await t.call(method, path, { pin, body });
        assert.equal(res.status, 403, `${method} ${path}`);
        assert.equal(res.body.error.code, 'admin_off');
      }
    }
    assert.deepEqual((await t.call('GET', '/api/health')).body, { ok: true, admin: false });
  });

  it('locks an address out for a minute after 5 wrong PINs', async () => {
    t = await startStudyApp({ now: '2026-10-05T04:00:00.000Z' });
    for (let i = 0; i < 5; i += 1) assert.equal((await t.call('POST', '/api/admin/unlock', { pin: `nope${i}` })).status, 401);
    const locked = await t.call('POST', '/api/admin/unlock', { pin: TEST_PIN });
    assert.equal(locked.status, 429);
    assert.match(locked.body.error.message, /Try again in 60 s/);
    t.now = '2026-10-05T04:01:01.000Z';
    assert.equal((await t.call('POST', '/api/admin/unlock', { pin: TEST_PIN })).status, 204);
  });

  it('students can still study: reading lessons, rewrites, flashcards and quizzes need no PIN', async () => {
    t = await startStudyApp();
    addCodes(t.db, 'P01');
    const { lessonId } = seedLesson(t.db);
    for (const [method, path] of [['GET', '/api/lessons'], ['GET', `/api/lessons/${lessonId}`], ['GET', '/api/flashcards/decks'], ['GET', '/api/quiz'], ['GET', '/api/stats']]) {
      assert.equal((await t.call(method, path, { as: 'P01' })).status, 200, path);
    }
  });
});
