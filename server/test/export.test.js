import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { csvCell, toCsv } from '../src/export/csv.js';
import { addCodes, seedLesson, startStudyApp, TEST_PIN } from './helpers.js';

const SECRET_KEY = 'AIza-EXPORT-SECRET-0001';
const MIN = 60_000;

// minimal CSV reader for the tests (handles quotes and CRLF)
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const body = text.replace(/^﻿/, '');
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\r') continue;
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  const [head, ...rest] = rows;
  return rest.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

describe('CSV writing', () => {
  it('quotes when needed and defuses spreadsheet formulas', () => {
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
    assert.equal(csvCell('+1'), "'+1");
    assert.equal(csvCell('@sum'), "'@sum");
    assert.equal(csvCell(-3), '-3');
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(true), '1');
    assert.equal(toCsv(['a', 'b'], [{ a: 1, b: 'x' }]), 'a,b\r\n1,x\r\n');
  });
});

describe('research export', () => {
  let t;
  let lessonId;
  let cards;
  const ids = {};

  beforeEach(async () => {
    t = await startStudyApp({ now: '2026-10-05T04:00:00.000Z' });
    addCodes(t.db, 'P01', 'P02');
    ({ lessonId, cards } = seedLesson(t.db, { title: '=Risky title', n: 4 }));
    for (const r of t.db.prepare('SELECT id, code FROM participants').all()) ids[r.code] = r.id;
    // secrets that must never appear in an export
    t.db.prepare("INSERT INTO settings (key, value) VALUES ('ai_api_key:google', ?), ('ai_model:google', 'gemini-secret-model')").run(SECRET_KEY);
    // a student's own key (Phase 7A) and a live AI call of theirs
    t.db.prepare("INSERT INTO participant_ai_keys VALUES (?, 'deepseek', 'deepseek-chat', 'sk-STUDENT-EXPORT-SECRET', 'CRET', 'x', 'x')").run(ids.P01);
    t.db.prepare("INSERT INTO ai_calls (participant_id, kind, outcome, source, provider, model, created_at, study_date) VALUES (?, 'simplify', 'ok', 'student', 'deepseek', 'deepseek-chat', '2026-10-05T05:00:00.000Z', '2026-10-05')").run(ids.P01);
    t.db.prepare("INSERT INTO quiz_distractors (flashcard_id, choices) SELECT id, '[]' FROM flashcards").run();

    // P01: two flashcard answers (Good, Again), 12 min reading + 6 min flashcards over two days, a finished quiz
    // (first attempt), a retake, an abandoned attempt, and events
    const as = 'P01';
    await t.call('POST', `/api/flashcards/${cards[0]}/review`, { as, body: { rating: 3, deck: lessonId } });
    await t.call('POST', `/api/flashcards/${cards[1]}/review`, { as, body: { rating: 1, deck: lessonId } });
    const session = async (activity, now, ms) => {
      t.now = now;
      const s = (await t.call('POST', '/api/sessions', { as, body: { lesson_id: lessonId, activity } })).body.session;
      t.now = new Date(Date.parse(now) + ms).toISOString();
      await t.call('POST', `/api/sessions/${s.id}`, { as, body: { active_ms: ms, end_reason: 'left' } });
    };
    await session('reading', '2026-10-05T05:00:00.000Z', 12 * MIN);
    await session('flashcards', '2026-10-06T05:00:00.000Z', 6 * MIN);

    t.now = '2026-10-06T06:00:00.000Z';
    const quiz = (await t.call('POST', `/api/lessons/${lessonId}/quiz/attempts`, { as, body: {} })).body;
    ids.first = quiz.attempt.id;
    for (const q of quiz.questions) await t.call('POST', `/api/quiz/attempts/${quiz.attempt.id}/answers`, { as, body: { position: q.position, choice: 0 } });
    await t.call('POST', `/api/quiz/attempts/${quiz.attempt.id}/finish`, { as, body: { total_ms: 60_000 } });
    const retake = (await t.call('POST', `/api/lessons/${lessonId}/quiz/attempts`, { as, body: { retake_of: quiz.attempt.id } })).body;
    ids.retake = retake.attempt.id; // left part-way, 3 hours before "now" below: abandoned
    await t.call('POST', `/api/quiz/attempts/${retake.attempt.id}/answers`, { as, body: { position: 0, choice: 0 } });
    await t.call('POST', '/api/events', { as, body: { type: 'stats_view' } });
    await t.call('POST', '/api/events', { as, body: { type: 'stats_view' } });
    await t.call('POST', '/api/events', { as, body: { type: 'review_flashcards_tap', lesson_id: lessonId, attempt_id: ids.first } });
    await t.call('POST', '/api/events', { as, body: { type: 'section_simplify', lesson_id: lessonId, section_index: 1 } });
    await t.call('POST', '/api/events', { as, body: { type: 'section_translate', lesson_id: lessonId, section_index: 0 } });

    // P00: the researcher's own test data
    await t.call('POST', `/api/flashcards/${cards[0]}/review`, { as: 'P00', body: { rating: 4, deck: lessonId } });
    await t.call('POST', '/api/events', { as: 'P00', body: { type: 'stats_view' } });
    await t.call('POST', '/api/setting-events', { as, body: { setting: 'motion', value: 'less' } });
    await t.call('POST', '/api/setting-events', { as: 'P00', body: { setting: 'motion', value: 'full' } });
    t.now = '2026-10-06T09:00:00.000Z';
  });
  afterEach(() => t.close());

  const file = async (name, query = '') => {
    const res = await t.call('GET', `/api/admin/export/${name}.csv${query}`, { pin: TEST_PIN });
    assert.equal(res.status, 200, name);
    return res.body;
  };

  it('the zip has every file and the codebook, and no secret anywhere', async () => {
    const res = await t.call('GET', '/api/admin/export.zip?include_p00=1', { pin: TEST_PIN, raw: true });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const names = Object.keys(zip.files).sort();
    assert.deepEqual(names, ['README.txt', 'ai_calls.csv', 'due_reviews.csv', 'events.csv', 'flashcard_reviews.csv', 'quiz_answers.csv', 'quiz_attempts.csv', 'sessions.csv', 'setting_events.csv', 'summary.csv']);
    for (const name of names) {
      const text = await zip.file(name).async('string');
      for (const secret of [SECRET_KEY, TEST_PIN, 'gemini-secret-model', 'ai_api_key', 'sk-STUDENT-EXPORT-SECRET']) assert.ok(!text.includes(secret), `${secret} in ${name}`);
    }
    const readme = await zip.file('README.txt').async('string');
    for (const col of ['self_monitoring_simplify_taps', 'self_monitoring_translate_taps', 'planning_on_time_rate', `L${lessonId} = =Risky title`]) assert.ok(readme.includes(col), col);
  });

  it('setting_events.csv lists each setting change; the codebook explains it and says time_ms is not affected', async () => {
    const rows = parseCsv(await file('setting_events'));
    assert.deepEqual(rows.map((r) => [r.participant, r.setting, r.value, r.study_date]), [['P01', 'motion', 'less', parseCsv(await file('events')).find((r) => r.participant === 'P01').study_date]]);
    assert.ok('event_id' in rows[0] && 'created_at' in rows[0]);
    const all = parseCsv(await file('setting_events', '?include_p00=1'));
    assert.deepEqual(all.map((r) => [r.participant, r.value]), [['P00', 'full'], ['P01', 'less']]);
    const zip = await JSZip.loadAsync(Buffer.from(await (await t.call('GET', '/api/admin/export.zip', { pin: TEST_PIN, raw: true })).arrayBuffer()));
    const readme = await zip.file('README.txt').async('string');
    assert.ok(/setting_events.csv/.test(readme) && /never changes time_ms/.test(readme));
  });

  it('leaves P00 out unless asked', async () => {
    for (const name of ['summary', 'sessions', 'flashcard_reviews', 'quiz_attempts', 'quiz_answers', 'events', 'setting_events']) {
      const rows = parseCsv(await file(name));
      assert.ok(rows.length > 0, name);
      assert.ok(rows.every((r) => r.participant !== 'P00'), name);
    }
    const all = parseCsv(await file('summary', '?include_p00=1')).map((r) => r.participant);
    assert.deepEqual(all, ['P00', 'P01', 'P02']);
    assert.ok(parseCsv(await file('events', '?include_p00=1')).some((r) => r.participant === 'P00'));
  });

  it('marks abandoned attempts and retakes', async () => {
    const attempts = parseCsv(await file('quiz_attempts'));
    const first = attempts.find((a) => Number(a.attempt_id) === ids.first);
    const retake = attempts.find((a) => Number(a.attempt_id) === ids.retake);
    assert.deepEqual([first.status, first.is_retake, first.retake_of, first.is_first_attempt, first.percent !== ''], ['finished', '0', '', '1', true]);
    assert.deepEqual([retake.status, retake.is_retake, Number(retake.retake_of), retake.is_first_attempt, retake.answered, retake.score], ['abandoned', '1', ids.first, '0', '1', '']);
    const answers = parseCsv(await file('quiz_answers')).filter((a) => Number(a.attempt_id) === ids.retake);
    assert.equal(answers.length, 4);
    assert.ok(answers.every((a) => a.attempt_status === 'abandoned' && a.is_retake === '1'));
    assert.deepEqual(answers.map((a) => a.correct === ''), [false, true, true, true]);
  });

  it('sessions, reviews and events carry the right columns', async () => {
    const sessions = parseCsv(await file('sessions'));
    assert.deepEqual(sessions.map((s) => [s.activity, s.active_min, s.end_reason, s.study_date, s.lesson_title]), [
      ['reading', '12', 'left', '2026-10-05', "'=Risky title"],
      ['flashcards', '6', 'left', '2026-10-06', "'=Risky title"],
    ]);
    const reviews = parseCsv(await file('flashcard_reviews'));
    assert.deepEqual(reviews.map((r) => [r.rating_name, r.good_or_easy, r.state_before, r.due_status]), [['good', '1', 'new', 'n/a'], ['again', '0', 'new', 'n/a']]);
    const events = parseCsv(await file('events'));
    assert.deepEqual(events.map((e) => [e.type, e.section_index]), [
      ['quiz_retake', ''], ['stats_view', ''], ['stats_view', ''], ['review_flashcards_tap', ''], ['section_simplify', '1'], ['section_translate', '0'],
    ]);
  });

  it('the summary columns are grouped by SDL dimension and match hand counts', async () => {
    const text = await file('summary');
    const header = text.replace(/^﻿/, '').split('\r\n')[0].split(',');
    assert.deepEqual(header, [
      'participant',
      'planning_days_active', 'planning_total_sessions', 'planning_reading_min', 'planning_flashcards_min', 'planning_quiz_min', 'planning_total_min',
      'planning_first_study_date', 'planning_last_study_date', 'planning_reviews_on_time', 'planning_reviews_late', 'planning_reviews_still_overdue',
      'planning_avg_days_late', 'planning_on_time_rate',
      'retention_cards_reviewed', 'retention_good_easy_pct', 'retention_quiz_first_pct_mean', `retention_quiz_first_pct_L${lessonId}`,
      'self_monitoring_stats_views', 'self_monitoring_quiz_retakes', 'self_monitoring_review_flashcards_taps', 'self_monitoring_simplify_taps', 'self_monitoring_translate_taps',
    ]);
    const [p1, p2] = parseCsv(text);
    const firstPct = t.db.prepare('SELECT ROUND(100.0 * score / total, 1) p FROM quiz_attempts WHERE id = ?').get(ids.first).p;
    assert.deepEqual(p1, {
      participant: 'P01',
      planning_days_active: '2', // Oct 5 (reviews, reading) and Oct 6 (flashcards, quiz)
      planning_total_sessions: '2',
      planning_reading_min: '12',
      planning_flashcards_min: '6',
      planning_quiz_min: '0',
      planning_total_min: '18',
      planning_first_study_date: '2026-10-05',
      planning_last_study_date: '2026-10-06',
      planning_reviews_on_time: '0',
      planning_reviews_late: '0',
      planning_reviews_still_overdue: '0',
      planning_avg_days_late: '',
      planning_on_time_rate: '',
      retention_cards_reviewed: '2',
      retention_good_easy_pct: '50',
      retention_quiz_first_pct_mean: String(firstPct),
      [`retention_quiz_first_pct_L${lessonId}`]: String(firstPct),
      self_monitoring_stats_views: '2',
      self_monitoring_quiz_retakes: '1',
      self_monitoring_review_flashcards_taps: '1',
      self_monitoring_simplify_taps: '1',
      self_monitoring_translate_taps: '1',
    });
    assert.equal(p2.participant, 'P02');
    assert.equal(p2.planning_days_active, '0');
    assert.equal(p2.retention_cards_reviewed, '0');
    assert.equal(p2.self_monitoring_stats_views, '0');
  });

  it('an unknown file is a 404', async () => {
    assert.equal((await t.call('GET', '/api/admin/export/settings.csv', { pin: TEST_PIN })).status, 404);
  });
});
