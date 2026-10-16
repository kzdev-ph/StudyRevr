import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sessionStatus } from '../src/sessions/store.js';
import { nextStudyDay, studyDate, studyWeek } from '../src/stats/days.js';
import { addCodes, seedLesson, startStudyApp } from './helpers.js';

const MIN = 60_000;
const at = (iso, ms = 0) => new Date(Date.parse(iso) + ms).toISOString();

describe('study days (04:00 Asia/Manila)', () => {
  it('a day starts at 04:00 Manila, so 03:59 is still the day before', () => {
    assert.equal(studyDate('2026-10-05T19:59:59.000Z'), '2026-10-05'); // 03:59:59 Oct 6 Manila
    assert.equal(studyDate('2026-10-05T20:00:00.000Z'), '2026-10-06'); // 04:00 Oct 6 Manila
    assert.equal(studyDate('2026-10-05T16:00:00.000Z'), '2026-10-05'); // midnight Manila: still Oct 5
  });

  it('a study week runs Monday 04:00 to Monday 04:00', () => {
    const w = studyWeek(new Date('2026-10-07T04:00:00.000Z')); // Wednesday
    assert.equal(w.start.toISOString(), '2026-10-04T20:00:00.000Z');
    assert.equal(w.end.toISOString(), '2026-10-11T20:00:00.000Z');
    assert.equal(w.dates[0], '2026-10-05');
    // Monday 03:00 Manila is still last week's Sunday
    assert.equal(studyWeek(new Date('2026-10-04T19:00:00.000Z')).dates[6], '2026-10-04');
    assert.equal(nextStudyDay(new Date('2026-10-05T19:59:00.000Z')).start.toISOString(), '2026-10-05T20:00:00.000Z');
  });
});

describe('sessions API', () => {
  let t;
  afterEach(() => t?.close());

  const begin = async (body = {}) => {
    t = await startStudyApp({ now: '2026-10-05T19:58:00.000Z' }); // 03:58 Manila: study day Oct 5
    addCodes(t.db, 'P01', 'P02');
    const { lessonId } = seedLesson(t.db);
    const res = await t.call('POST', '/api/sessions', { as: 'P01', body: { lesson_id: lessonId, activity: 'reading', ...body } });
    return { lessonId, res };
  };

  it('opens a session with its study day and keeps active time growing, never past the wall clock', async () => {
    const { res } = await begin();
    assert.equal(res.status, 201);
    const s = res.body.session;
    assert.deepEqual([s.activity, s.active_ms, s.ended_at, s.study_date], ['reading', 0, null, '2026-10-05']);

    t.now = at(s.started_at, 3 * MIN); // past 04:00: the session still belongs to the day it started on
    let r = await t.call('POST', `/api/sessions/${s.id}`, { as: 'P01', body: { active_ms: 2 * MIN } });
    assert.equal(r.body.session.active_ms, 2 * MIN);
    assert.equal(r.body.session.study_date, '2026-10-05');
    // a smaller number (a late, reordered heartbeat) never shrinks it; a bigger one is capped at the time since start
    r = await t.call('POST', `/api/sessions/${s.id}`, { as: 'P01', body: { active_ms: MIN } });
    assert.equal(r.body.session.active_ms, 2 * MIN);
    r = await t.call('POST', `/api/sessions/${s.id}`, { as: 'P01', body: { active_ms: 60 * MIN } });
    assert.equal(r.body.session.active_ms, 3 * MIN);
  });

  it('ends an idle session at the last interaction, and ignores reports after the end', async () => {
    const { res } = await begin();
    const s = res.body.session;
    t.now = at(s.started_at, 2 * MIN);
    await t.call('POST', `/api/sessions/${s.id}`, { as: 'P01', body: { active_ms: 2 * MIN } });
    t.now = at(s.started_at, 7 * MIN); // 5 idle minutes later the app ends it
    const end = await t.call('POST', `/api/sessions/${s.id}`, { as: 'P01', body: { active_ms: 2 * MIN, end_reason: 'idle', ended_ago_ms: 5 * MIN } });
    assert.equal(end.body.session.end_reason, 'idle');
    assert.equal(end.body.session.ended_at, at(s.started_at, 2 * MIN));
    assert.equal(end.body.session.active_ms, 2 * MIN);
    t.now = at(s.started_at, 8 * MIN);
    const late = await t.call('POST', `/api/sessions/${s.id}`, { as: 'P01', body: { active_ms: 9 * MIN } });
    assert.equal(late.body.session.active_ms, 2 * MIN);
  });

  it('a session that stops reporting reads as unclosed at its last report', () => {
    const s = { ended_at: null, end_reason: null, last_active_at: '2026-10-05T04:00:00.000Z' };
    assert.deepEqual(sessionStatus(s, new Date('2026-10-05T04:04:00.000Z')), { ended_at: null, end_reason: 'open' });
    assert.deepEqual(sessionStatus(s, new Date('2026-10-05T04:06:00.000Z')), { ended_at: '2026-10-05T04:00:00.000Z', end_reason: 'unclosed' });
  });

  it('only the owner can report on a session; bad input is a 400', async () => {
    const { res } = await begin();
    const id = res.body.session.id;
    assert.equal((await t.call('POST', `/api/sessions/${id}`, { as: 'P02', body: { active_ms: 1 } })).status, 404);
    assert.equal((await t.call('POST', `/api/sessions/${id}`, { as: 'P01', body: { active_ms: -1 } })).status, 400);
    assert.equal((await t.call('POST', `/api/sessions/${id}`, { as: 'P01', body: { active_ms: 1, end_reason: 'bored' } })).status, 400);
    assert.equal((await t.call('POST', '/api/sessions', { as: 'P01', body: { lesson_id: 1, activity: 'gaming' } })).status, 400);
    assert.equal((await t.call('POST', '/api/sessions', { as: 'P01', body: { lesson_id: 999, activity: 'quiz' } })).status, 404);
    // the All lessons flashcard deck has no lesson
    assert.equal((await t.call('POST', '/api/sessions', { as: 'P01', body: { lesson_id: null, activity: 'flashcards' } })).status, 201);
  });
});

describe('events API', () => {
  let t;
  afterEach(() => t?.close());

  it('logs self-monitoring events per participant with their study day', async () => {
    t = await startStudyApp({ now: '2026-10-05T20:30:00.000Z' }); // 04:30 Oct 6 Manila
    addCodes(t.db, 'P01');
    const { lessonId } = seedLesson(t.db);
    const ok = (body) => t.call('POST', '/api/events', { as: 'P01', body });
    assert.equal((await ok({ type: 'stats_view' })).status, 201);
    assert.equal((await ok({ type: 'review_flashcards_tap', lesson_id: lessonId, attempt_id: 7 })).status, 201);
    assert.equal((await ok({ type: 'section_simplify', lesson_id: lessonId, section_index: 1 })).status, 201);
    assert.equal((await ok({ type: 'section_translate', lesson_id: lessonId, section_index: 0 })).status, 201);
    // section events need the lesson and the section; retakes are logged by the server, never by the app
    assert.equal((await ok({ type: 'section_simplify', lesson_id: lessonId })).status, 400);
    assert.equal((await ok({ type: 'section_translate', section_index: 0 })).status, 400);
    assert.equal((await ok({ type: 'quiz_retake', lesson_id: lessonId })).status, 400);
    assert.equal((await ok({ type: 'login' })).status, 400);
    assert.deepEqual(t.db.prepare('SELECT type, lesson_id, attempt_id, section_index, study_date FROM events ORDER BY id').all(), [
      { type: 'stats_view', lesson_id: null, attempt_id: null, section_index: null, study_date: '2026-10-06' },
      { type: 'review_flashcards_tap', lesson_id: lessonId, attempt_id: 7, section_index: null, study_date: '2026-10-06' },
      { type: 'section_simplify', lesson_id: lessonId, attempt_id: null, section_index: 1, study_date: '2026-10-06' },
      { type: 'section_translate', lesson_id: lessonId, attempt_id: null, section_index: 0, study_date: '2026-10-06' },
    ]);
  });

  it('a quiz retake is logged by the server', async () => {
    t = await startStudyApp({ now: '2026-10-05T04:00:00.000Z' });
    addCodes(t.db, 'P01');
    const { lessonId } = seedLesson(t.db);
    t.db.prepare("INSERT INTO quiz_distractors (flashcard_id, choices) SELECT id, '[]' FROM flashcards").run();
    const quiz = (await t.call('POST', `/api/lessons/${lessonId}/quiz/attempts`, { as: 'P01', body: {} })).body;
    for (const q of quiz.questions) await t.call('POST', `/api/quiz/attempts/${quiz.attempt.id}/answers`, { as: 'P01', body: { position: q.position, choice: 0 } });
    await t.call('POST', `/api/quiz/attempts/${quiz.attempt.id}/finish`, { as: 'P01', body: { total_ms: 1000 } });
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM events').get().n, 0);
    const retake = (await t.call('POST', `/api/lessons/${lessonId}/quiz/attempts`, { as: 'P01', body: { retake_of: quiz.attempt.id } })).body;
    assert.deepEqual(t.db.prepare('SELECT type, lesson_id, attempt_id FROM events').all(), [{ type: 'quiz_retake', lesson_id: lessonId, attempt_id: retake.attempt.id }]);
  });
});

describe('setting changes (setting_events)', () => {
  let t;
  afterEach(() => t?.close());
  const start = async () => {
    t = await startStudyApp({ now: '2026-10-05T19:58:00.000Z' }); // 03:58 Manila: study day Oct 5
    addCodes(t.db, 'P01');
  };
  const send = (body, as = 'P01') => t.call('POST', '/api/setting-events', { as, body });

  it('logs each Motion choice with the participant and study day', async () => {
    await start();
    for (const value of ['less', 'full', 'system']) assert.equal((await send({ setting: 'motion', value })).status, 201);
    assert.deepEqual(t.db.prepare('SELECT setting, value, study_date, created_at FROM setting_events ORDER BY id').all(), [
      { setting: 'motion', value: 'less', study_date: '2026-10-05', created_at: '2026-10-05T19:58:00.000Z' },
      { setting: 'motion', value: 'full', study_date: '2026-10-05', created_at: '2026-10-05T19:58:00.000Z' },
      { setting: 'motion', value: 'system', study_date: '2026-10-05', created_at: '2026-10-05T19:58:00.000Z' },
    ]);
  });

  it('refuses an unknown setting, a value the setting does not have, and a missing participant', async () => {
    await start();
    assert.equal((await send({ setting: 'motion', value: 'reduce' })).status, 400);
    assert.equal((await send({ setting: 'motion' })).status, 400);
    assert.equal((await send({ setting: 'theme', value: 'dark' })).status, 400); // not logged yet
    assert.equal((await send({ setting: 'volume', value: 'less' })).status, 400);
    assert.equal((await send({ setting: 'motion', value: 'less' }, null)).status, 401);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM setting_events').get().n, 0);
  });

  it('leaves the events table and its type list alone', async () => {
    await start();
    await send({ setting: 'motion', value: 'less' });
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM events').get().n, 0);
    const res = await t.call('POST', '/api/events', { as: 'P01', body: { type: 'motion_setting' } });
    assert.equal(res.status, 400);
    const sql = t.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'events'").get().sql;
    assert.ok(sql.includes("CHECK (type IN ('stats_view', 'quiz_retake', 'review_flashcards_tap', 'section_simplify', 'section_translate'))"));
  });

  it('goes with the participant (cascade)', async () => {
    await start();
    await send({ setting: 'motion', value: 'less' });
    t.db.prepare("DELETE FROM participants WHERE code = 'P01'").run();
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM setting_events').get().n, 0);
  });
});
