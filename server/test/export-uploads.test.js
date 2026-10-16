import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { addCodes, seedLesson, startStudyApp, TEST_PIN } from './helpers.js';

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

// Phase 7B: the research export says where each lesson came from, logs the uploads' events, and keeps the teacher's
// lessons apart from the students' in the summary (main measures: the teacher's lessons only; _all twins: every lesson).
describe("research export with students' uploads", () => {
  let t;
  let l; // lesson ids: admin (the teacher's), priv (P01's private upload), shared (P02's, shared), p00 (the researcher's own upload)
  const ids = {};

  beforeEach(async () => {
    t = await startStudyApp({ now: '2026-10-05T04:00:00.000Z' });
    addCodes(t.db, 'P01', 'P02');
    for (const r of t.db.prepare('SELECT id, code FROM participants').all()) ids[r.code] = r.id;
    const make = (title, origin, owner, sharedAt = null) => {
      const seeded = seedLesson(t.db, { title, n: 3 });
      t.db.prepare('UPDATE lessons SET origin = ?, owner_participant_id = ?, shared_at = ? WHERE id = ?').run(origin, owner, sharedAt, seeded.lessonId);
      return seeded;
    };
    const admin = make('Teacher lesson', 'admin', null);
    const priv = make('Private upload', 'student', ids.P01);
    const shared = make('Shared upload', 'student', ids.P02, '2026-10-05T03:00:00.000Z');
    const p00 = make('Researcher upload', 'student', ids.P00);
    l = { admin: admin.lessonId, priv: priv.lessonId, shared: shared.lessonId, p00: p00.lessonId };
    t.db.prepare("INSERT INTO quiz_distractors (flashcard_id, choices) SELECT id, '[]' FROM flashcards").run();

    // P01 studies all three lessons they can see: 10, 20 and 30 minutes of reading
    const as = 'P01';
    let hour = 5;
    for (const [key, ms] of [['admin', 10 * MIN], ['shared', 20 * MIN], ['priv', 30 * MIN]]) {
      t.now = `2026-10-05T${String(hour).padStart(2, '0')}:00:00.000Z`;
      hour += 1;
      const s = (await t.call('POST', '/api/sessions', { as, body: { lesson_id: l[key], activity: 'reading' } })).body.session;
      t.now = new Date(Date.parse(t.now) + ms).toISOString();
      await t.call('POST', `/api/sessions/${s.id}`, { as, body: { active_ms: ms, end_reason: 'left' } });
    }
    // one flashcard answer on the teacher's lesson (Good), one on the private one (Again)
    await t.call('POST', `/api/flashcards/${admin.cards[0]}/review`, { as, body: { rating: 3, deck: l.admin } });
    await t.call('POST', `/api/flashcards/${priv.cards[0]}/review`, { as, body: { rating: 1, deck: l.priv } });
    // simpler taps: one on the teacher's lesson, two on the private one
    await t.call('POST', '/api/events', { as, body: { type: 'section_simplify', lesson_id: l.admin, section_index: 0 } });
    await t.call('POST', '/api/events', { as, body: { type: 'section_simplify', lesson_id: l.priv, section_index: 0 } });
    await t.call('POST', '/api/events', { as, body: { type: 'section_simplify', lesson_id: l.priv, section_index: 1 } });
    // the log of uploads: P01 uploaded, P02's was shared by admin, the researcher uploaded too
    const ev = t.db.prepare("INSERT INTO lesson_events (participant_id, type, lesson_id, lesson_title, actor, detail, created_at, study_date) VALUES (?, ?, ?, ?, ?, ?, ?, '2026-10-05')");
    ev.run(ids.P01, 'lesson_uploaded', l.priv, 'Private upload', 'student', 'private.docx', '2026-10-05T04:30:00.000Z');
    ev.run(ids.P02, 'lesson_shared', l.shared, 'Shared upload', 'admin', null, '2026-10-05T04:40:00.000Z');
    ev.run(ids.P00, 'lesson_uploaded', l.p00, 'Researcher upload', 'student', 'mine.docx', '2026-10-05T04:50:00.000Z');
    t.now = '2026-10-06T09:00:00.000Z';
  });
  afterEach(() => t.close());

  const file = async (name, query = '') => {
    const res = await t.call('GET', `/api/admin/export/${name}.csv${query}`, { pin: TEST_PIN });
    assert.equal(res.status, 200, name);
    return res.body;
  };

  it('lessons.csv says where each lesson came from: admin, student, shared, and the owner', async () => {
    const rows = parseCsv(await file('lessons'));
    const by = Object.fromEntries(rows.map((r) => [r.title, r]));
    const priv = `Student upload ${l.priv}`;
    const shared = `Student upload ${l.shared}`;
    assert.deepEqual(Object.keys(by).sort(), [priv, shared, 'Teacher lesson'].sort(), "the researcher's private upload is left out with P00; uploads carry the generic title");
    assert.deepEqual([by['Teacher lesson'].origin, by['Teacher lesson'].shared, by['Teacher lesson'].owner], ['admin', '', '']);
    assert.deepEqual([by[priv].origin, by[priv].shared, by[priv].shared_at, by[priv].owner], ['student', '0', '', 'P01']);
    assert.deepEqual([by[shared].origin, by[shared].shared, by[shared].shared_at, by[shared].owner], ['student', '1', '2026-10-05T03:00:00.000Z', 'P02']);
    assert.equal(by['Teacher lesson'].lesson_id, String(l.admin));
    assert.ok(parseCsv(await file('lessons', '?include_p00=1')).some((r) => r.owner === 'P00'));
  });

  it("lessons.csv keeps a shared lesson's origin when its owner was withdrawn", async () => {
    t.db.prepare('UPDATE lessons SET owner_participant_id = NULL WHERE id = ?').run(l.shared);
    const row = parseCsv(await file('lessons')).find((r) => r.title === `Student upload ${l.shared}`);
    assert.deepEqual([row.origin, row.shared, row.owner], ['student', '1', '']);
  });

  it('lesson_events.csv lists the uploads\' events with the participant, and leaves P00 out', async () => {
    const rows = parseCsv(await file('lesson_events'));
    assert.deepEqual(rows.map((r) => [r.participant, r.type, r.actor, r.lesson_title, r.detail, r.study_date]), [
      ['P01', 'lesson_uploaded', 'student', `Student upload ${l.priv}`, '.docx', '2026-10-05'],
      ['P02', 'lesson_shared', 'admin', `Student upload ${l.shared}`, '', '2026-10-05'],
    ]);
    assert.equal(parseCsv(await file('lesson_events', '?include_p00=1')).length, 3);
  });

  it("lessons.csv keeps the researcher's shared upload (other participants' rows point to it)", async () => {
    t.db.prepare('UPDATE lessons SET shared_at = ? WHERE id = ?').run('2026-10-05T03:30:00.000Z', l.p00);
    const rows = parseCsv(await file('lessons'));
    assert.ok(rows.some((r) => r.lesson_id === String(l.p00) && r.owner === 'P00'));
  });

  it("no export file shows a student upload's real title or file name; the teacher's lessons keep theirs", async () => {
    const REAL = ['Private upload', 'Shared upload', 'Researcher upload', 'private.docx', 'mine.docx'];
    // every kind of record that carries a lesson title: sessions (done in beforeEach), reviews, events, quiz attempts, AI calls
    await t.call('POST', '/api/events', { as: 'P01', body: { type: 'section_translate', lesson_id: l.priv, section_index: 0 } });
    const attempt = await t.call('POST', `/api/lessons/${l.priv}/quiz/attempts`, { as: 'P01', body: {} });
    assert.equal(attempt.status, 201);
    t.db.prepare("INSERT INTO ai_calls (participant_id, lesson_id, section_index, kind, outcome, source, from_cache, saved_shared, created_at, study_date) VALUES (?, ?, 0, 'simplify', 'ok', 'default', 0, 0, '2026-10-05T06:00:00.000Z', '2026-10-05')").run(ids.P01, l.priv);
    const zip = await JSZip.loadAsync(Buffer.from(await (await t.call('GET', '/api/admin/export.zip?include_p00=1', { pin: TEST_PIN, raw: true })).arrayBuffer()));
    const names = Object.keys(zip.files);
    assert.ok(names.length >= 12);
    for (const name of names) {
      if (name === 'quiz_answers.csv') continue; // the questions are lesson content (the seeded cards repeat the title); it has no title column
      const text = await zip.file(name).async('string');
      for (const real of REAL) assert.ok(!text.includes(real), `${name} shows "${real}"`);
    }
    const csv = async (n) => parseCsv(await zip.file(`${n}.csv`).async('string'));
    for (const n of ['sessions', 'flashcard_reviews', 'events', 'quiz_attempts', 'ai_calls']) {
      const rows = await csv(n);
      const forPriv = rows.filter((r) => r.lesson_id === String(l.priv));
      assert.ok(forPriv.length > 0, `${n} has a row for the private upload`);
      for (const r of forPriv) assert.equal(r.lesson_title, `Student upload ${l.priv}`, n);
      for (const r of rows.filter((x) => x.lesson_id === String(l.admin))) assert.equal(r.lesson_title, 'Teacher lesson', n);
    }
    const readme = await zip.file('README.txt').async('string');
    assert.ok(readme.includes(`Student upload <lesson_id>`));
    assert.ok(readme.includes(`L${l.shared} = Student upload ${l.shared}`));
    assert.ok(readme.includes(`L${l.admin} = Teacher lesson`));
  });

  it('the codebook explains the new files, the _all columns and that no original file is kept', async () => {
    const res = await t.call('GET', '/api/admin/export.zip', { pin: TEST_PIN, raw: true });
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const readme = await zip.file('README.txt').async('string');
    for (const text of ['lessons.csv', 'lesson_events.csv', '_all', 'origin admin', 'never kept', 'lesson_deleted_by_student']) assert.ok(readme.includes(text), text);
    assert.ok(/teacher's lessons only/i.test(readme));
  });

  it("summary.csv: main measures count the teacher's lessons, _all counts every lesson, per-lesson columns cover teacher and shared lessons", async () => {
    const text = await file('summary');
    const header = text.replace(/^﻿/, '').split('\r\n')[0].split(',');
    assert.deepEqual(header.filter((h) => h.startsWith('retention_quiz_first_pct_L')), [`retention_quiz_first_pct_L${l.admin}`, `retention_quiz_first_pct_L${l.shared}`]);
    // each _all twin sits right after its main measure
    for (const h of header.filter((c) => c.endsWith('_all'))) assert.equal(header[header.indexOf(h) - 1], h.slice(0, -4), h);
    assert.ok(!header.includes('self_monitoring_stats_views_all'), 'stats views are not tied to a lesson: no twin');
    const p1 = parseCsv(text).find((r) => r.participant === 'P01');
    const pick = (cols) => Object.fromEntries(cols.map((c) => [c, p1[c]]));
    assert.deepEqual(pick(['planning_reading_min', 'planning_reading_min_all', 'planning_total_min', 'planning_total_min_all']), {
      planning_reading_min: '10',
      planning_reading_min_all: '60',
      planning_total_min: '10',
      planning_total_min_all: '60',
    });
    assert.deepEqual(pick(['planning_total_sessions', 'planning_total_sessions_all', 'planning_days_active', 'planning_days_active_all']), {
      planning_total_sessions: '1', planning_total_sessions_all: '3', planning_days_active: '1', planning_days_active_all: '1',
    });
    assert.deepEqual(pick(['retention_cards_reviewed', 'retention_cards_reviewed_all', 'retention_good_easy_pct', 'retention_good_easy_pct_all']), {
      retention_cards_reviewed: '1', retention_cards_reviewed_all: '2', retention_good_easy_pct: '100', retention_good_easy_pct_all: '50',
    });
    assert.deepEqual(pick(['self_monitoring_simplify_taps', 'self_monitoring_simplify_taps_all']), { self_monitoring_simplify_taps: '1', self_monitoring_simplify_taps_all: '3' });
  });

  it('a shared upload counts in the _all measures but not in the teacher-lesson ones', async () => {
    const p2 = parseCsv(await file('summary')).find((r) => r.participant === 'P02');
    assert.deepEqual([p2.planning_reading_min, p2.planning_reading_min_all], ['0', '0']);
    const other = { as: 'P02' };
    t.now = '2026-10-06T09:00:00.000Z';
    const s = (await t.call('POST', '/api/sessions', { ...other, body: { lesson_id: l.shared, activity: 'reading' } })).body.session;
    t.now = '2026-10-06T09:10:00.000Z';
    await t.call('POST', `/api/sessions/${s.id}`, { ...other, body: { active_ms: 5 * MIN, end_reason: 'left' } });
    const after = parseCsv(await file('summary')).find((r) => r.participant === 'P02');
    assert.deepEqual([after.planning_reading_min, after.planning_reading_min_all], ['0', '5']);
  });
});
