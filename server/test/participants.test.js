import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCode, parseCodeList } from '../src/participants/codes.js';
import { addCodes, seedLesson, startStudyApp, TEST_PIN } from './helpers.js';

const NOON = '2026-10-05T04:00:00.000Z'; // 12:00 Monday in Manila

describe('participant codes', () => {
  it('normalizes typed codes so one student has one code', () => {
    for (const typed of ['P07', 'p7', ' P 7 ', 'P007', 'P-7']) assert.equal(normalizeCode(typed), 'P07', typed);
    assert.equal(normalizeCode('P100'), 'P100');
    for (const bad of ['', '7', 'X07', 'P', 'P1234', 'P07; DROP TABLE']) assert.equal(normalizeCode(bad), null, bad);
  });

  it('reads lists and ranges', () => {
    assert.deepEqual(parseCodeList('P01-P03, p7 P 12; P1 - 4'), ['P01', 'P02', 'P03', 'P07', 'P12', 'P04']);
    assert.deepEqual(parseCodeList('P08 to P10'), ['P08', 'P09', 'P10']);
    assert.throws(() => parseCodeList('P05-P01'), /backwards/);
    assert.throws(() => parseCodeList('Ana'), /not a participant code/);
    assert.throws(() => parseCodeList('  '), /one or more codes/);
    assert.throws(() => parseCodeList('P1-P500'), /at most 200/);
  });
});

describe('participants API', () => {
  let t;
  afterEach(() => t?.close());

  it('only admin can add codes; a student cannot create one', async () => {
    t = await startStudyApp({ now: NOON });
    // there is no public way to list or create codes
    assert.equal((await t.call('GET', '/api/participants')).status, 404);
    assert.equal((await t.call('POST', '/api/participants', { body: { code: 'P01' } })).status, 404);
    assert.equal((await t.call('POST', '/api/admin/participants', { body: { codes: 'P01' } })).status, 401);
    assert.equal((await t.call('POST', '/api/admin/participants', { pin: 'wrong', body: { codes: 'P01' } })).status, 401);
    // using an unknown code on a study route doesn't create it either
    await t.call('GET', '/api/flashcards/decks', { as: 'P01' });
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM participants WHERE code = 'P01'").get().n, 0);

    const added = await t.call('POST', '/api/admin/participants', { pin: TEST_PIN, body: { codes: 'P01-P03, p2' } });
    assert.equal(added.status, 201);
    assert.deepEqual(added.body, { added: ['P01', 'P02', 'P03'], existing: [] });
    const again = await t.call('POST', '/api/admin/participants', { pin: TEST_PIN, body: { codes: 'P03 P04' } });
    assert.deepEqual(again.body, { added: ['P04'], existing: ['P03'] });
    assert.equal((await t.call('POST', '/api/admin/participants', { pin: TEST_PIN, body: { codes: 'Maria' } })).status, 400);
  });

  it('the code check accepts listed codes and rejects unknown ones', async () => {
    t = await startStudyApp({ now: NOON });
    addCodes(t.db, 'P01');
    assert.deepEqual((await t.call('GET', '/api/participants/p1')).body, { participant: { code: 'P01' } });
    const unknown = await t.call('GET', '/api/participants/P02');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.message, "That code isn't on the list. Check with your teacher.");
    assert.equal((await t.call('GET', '/api/participants/hello')).status, 400);
  });

  it('every study route needs a listed code', async () => {
    t = await startStudyApp({ now: NOON });
    const { lessonId, cards } = seedLesson(t.db);
    const routes = [
      ['GET', '/api/flashcards/decks'],
      ['GET', '/api/flashcards/due'],
      ['GET', `/api/lessons/${lessonId}/flashcards/due`],
      ['POST', `/api/flashcards/${cards[0]}/review`, { rating: 3 }],
      ['POST', '/api/flashcards/reviews/1/undo', {}],
      ['GET', '/api/quiz'],
      ['POST', `/api/lessons/${lessonId}/quiz/attempts`, {}],
      ['POST', '/api/quiz/attempts/1/answers', { position: 0, choice: 0 }],
      ['POST', '/api/quiz/attempts/1/finish', {}],
      ['GET', `/api/lessons/${lessonId}/review-progress`],
      ['PUT', `/api/lessons/${lessonId}/review-progress`, { last_section: 0 }],
      ['POST', '/api/sessions', { lesson_id: lessonId, activity: 'reading' }],
      ['POST', '/api/sessions/1', { active_ms: 1 }],
      ['POST', '/api/events', { type: 'stats_view' }],
      ['GET', '/api/stats'],
    ];
    for (const [method, path, body] of routes) {
      const none = await t.call(method, path, { body });
      assert.equal(none.status, 401, `${method} ${path} without a code`);
      assert.equal(none.body.error.code, 'participant_required');
      const unknown = await t.call(method, path, { as: 'P42', body });
      assert.equal(unknown.status, 401, `${method} ${path} with an unknown code`);
      assert.equal(unknown.body.error.code, 'participant_unknown');
    }
  });

  it("one participant's answers never change another's schedule, limits, quiz, events or stats", async () => {
    t = await startStudyApp({ now: NOON });
    addCodes(t.db, 'P01', 'P02');
    const { lessonId, cards } = seedLesson(t.db, { n: 4 });
    t.db.prepare("INSERT INTO settings (key, value) VALUES ('flashcard_new_per_day', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    const decks = async (as) => (await t.call('GET', '/api/flashcards/decks', { as })).body;
    const p2Before = await decks('P02');

    // P01 introduces both new cards allowed today, graduates one with Easy, and undoes nothing
    const a1 = await t.call('POST', `/api/flashcards/${cards[0]}/review`, { as: 'P01', body: { rating: 4, deck: lessonId } });
    assert.equal(a1.status, 200);
    await t.call('POST', `/api/flashcards/${cards[1]}/review`, { as: 'P01', body: { rating: 1, deck: lessonId } });
    const p1 = await decks('P01');
    assert.deepEqual(p1.limits.new_done, 2);
    assert.deepEqual(p1.decks[0].counts, { new: 0, learning: 1, due: 0 });

    // P02 still has its full daily budget and every card is new for them
    const p2 = await decks('P02');
    assert.deepEqual(p2, p2Before);
    assert.deepEqual(p2.decks[0].counts, { new: 2, learning: 0, due: 0 });
    const due = (await t.call('GET', `/api/lessons/${lessonId}/flashcards/due`, { as: 'P02' })).body;
    assert.equal(due.card.id, cards[0]);
    assert.equal(due.card.state, 0);

    // P02 can't undo P01's answer
    assert.equal((await t.call('POST', `/api/flashcards/reviews/${a1.body.review_id}/undo`, { as: 'P02', body: {} })).status, 404);
    assert.deepEqual(t.db.prepare('SELECT participant_id, COUNT(*) n FROM flashcard_progress GROUP BY participant_id').all(), [
      { participant_id: t.db.prepare("SELECT id FROM participants WHERE code = 'P01'").get().id, n: 2 },
    ]);

    // quiz: P02 doesn't resume P01's open attempt, and can't answer or finish it
    t.db.prepare("INSERT INTO quiz_distractors (flashcard_id, choices) SELECT id, '[]' FROM flashcards").run();
    const q1 = (await t.call('POST', `/api/lessons/${lessonId}/quiz/attempts`, { as: 'P01', body: {} })).body;
    const q2 = await t.call('POST', `/api/lessons/${lessonId}/quiz/attempts`, { as: 'P02', body: {} });
    assert.equal(q2.status, 201);
    assert.notEqual(q2.body.attempt.id, q1.attempt.id);
    assert.equal((await t.call('POST', `/api/quiz/attempts/${q1.attempt.id}/answers`, { as: 'P02', body: { position: 0, choice: 0 } })).status, 404);
    assert.equal((await t.call('POST', `/api/quiz/attempts/${q1.attempt.id}/finish`, { as: 'P02', body: {} })).status, 404);
    assert.equal((await t.call('POST', `/api/lessons/${lessonId}/quiz/attempts`, { as: 'P02', body: { retake_of: q1.attempt.id } })).status, 404);
    // P01 reloading resumes their own
    const again = (await t.call('POST', `/api/lessons/${lessonId}/quiz/attempts`, { as: 'P01', body: {} })).body;
    assert.equal(again.attempt.id, q1.attempt.id);
    assert.equal(again.resumed, true);

    // events and stats stay separate
    await t.call('POST', '/api/events', { as: 'P01', body: { type: 'stats_view' } });
    const s1 = (await t.call('GET', '/api/stats', { as: 'P01' })).body;
    const s2 = (await t.call('GET', '/api/stats', { as: 'P02' })).body;
    assert.equal(s1.cards.all.reviewed, 2);
    assert.equal(s2.cards.all.reviewed, 0);
    assert.equal(s2.due_tomorrow, 0);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM events WHERE participant_id = (SELECT id FROM participants WHERE code = ?)').get('P02').n, 0);
  });

  it('review progress is per participant', async () => {
    t = await startStudyApp({ now: NOON });
    addCodes(t.db, 'P01', 'P02');
    const { lessonId } = seedLesson(t.db);
    await t.call('PUT', `/api/lessons/${lessonId}/review-progress`, { as: 'P01', body: { last_section: 1, completed_sections: [0] } });
    assert.equal((await t.call('GET', `/api/lessons/${lessonId}`, { as: 'P01' })).body.review_progress.last_section, 1);
    assert.equal((await t.call('GET', `/api/lessons/${lessonId}`, { as: 'P02' })).body.review_progress, null);
    assert.equal((await t.call('GET', `/api/lessons/${lessonId}`)).body.review_progress, null);
  });
});
