import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkRebuild, confirmed, RebuildRefused, resetLesson } from '../src/services/rebuild-lesson.js';
import { addCodes, seedLesson, startStudyApp } from './helpers.js';

// `npm run lesson:rebuild`: the lesson stays (id, title, owner, sharing, source numbers), what was generated for it
// goes, and nothing is touched once a participant other than P00 has recorded something on it.
describe('rebuilding a lesson', () => {
  let t;
  let lessonId;
  let cards;
  const idOf = (code) => t.db.prepare('SELECT id FROM participants WHERE code = ?').get(code).id;
  const count = (table, where = '') => t.db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get().n;

  beforeEach(async () => {
    t = await startStudyApp();
    addCodes(t.db, 'P01');
    ({ lessonId, cards } = seedLesson(t.db));
    t.db.prepare("UPDATE lessons SET origin = 'student', owner_participant_id = ?, shared_at = '2026-10-02T00:00:00Z', source_kind = 'slide', source_numbers = '[1,2]', source_total = 2, filename = 'mine.pptx' WHERE id = ?").run(idOf('P01'), lessonId);
    t.db.prepare("INSERT INTO key_points (lesson_id, position, text) VALUES (?, 0, 'k')").run(lessonId);
    t.db.prepare("INSERT INTO key_terms (lesson_id, term, definition, evidence) VALUES (?, 't', 'd', 'e')").run(lessonId);
    t.db.prepare("INSERT INTO jobs (lesson_id, stage, status) VALUES (?, 'quiz_review', 'done')").run(lessonId);
  });
  afterEach(() => t.close());

  it('keeps the lesson and its fields, and removes what was generated, with P00’s test records', () => {
    addCodes(t.db, 'P00');
    t.db.prepare('INSERT INTO flashcard_reviews (participant_id, flashcard_id, rating) VALUES (?, ?, 3)').run(idOf('P00'), cards[0]);
    t.db.prepare('INSERT INTO quiz_attempts (participant_id, lesson_id, score, total) VALUES (?, ?, 0, 2)').run(idOf('P00'), lessonId);
    t.db
      .prepare("INSERT INTO study_sessions (participant_id, lesson_id, activity, started_at, last_active_at, study_date) VALUES (?, ?, 'reading', '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z', '2026-10-05')")
      .run(idOf('P00'), lessonId);
    t.db.prepare("UPDATE lessons SET thinking_level = 'low', term_families = '[]' WHERE id = ?").run(lessonId);

    resetLesson(t.db, lessonId);

    const lesson = t.db.prepare('SELECT * FROM lessons WHERE id = ?').get(lessonId);
    assert.equal(lesson.title, 'Inquiry');
    assert.equal(lesson.filename, 'mine.pptx');
    assert.equal(lesson.origin, 'student');
    assert.equal(lesson.owner_participant_id, idOf('P01'));
    assert.equal(lesson.shared_at, '2026-10-02T00:00:00Z');
    assert.equal(lesson.source_numbers, '[1,2]');
    assert.equal(lesson.source_total, 2);
    assert.ok(lesson.raw_text.length > 0);
    assert.equal(lesson.status, 'processing');
    assert.equal(lesson.thinking_level, null);
    assert.equal(lesson.term_families, null);
    for (const table of ['sections', 'key_points', 'key_terms', 'flashcards', 'jobs', 'quiz_attempts', 'flashcard_reviews', 'study_sessions']) {
      assert.equal(count(table), 0, table);
    }
  });

  it('refuses when a participant other than P00 has recorded anything, and deletes nothing', () => {
    t.db.prepare('INSERT INTO flashcard_reviews (participant_id, flashcard_id, rating) VALUES (?, ?, 3)').run(idOf('P01'), cards[0]);
    assert.throws(() => resetLesson(t.db, lessonId), (err) => err instanceof RebuildRefused && /1 flashcard answers/.test(err.message));
    assert.equal(count('flashcards'), 4);
    assert.equal(count('sections'), 2);
  });

  it('refuses for a reading position, a lesson being processed and a lesson that does not exist', () => {
    t.db.prepare("INSERT INTO review_progress (participant_id, lesson_id, last_section, completed_sections) VALUES (?, ?, 1, '[0]')").run(idOf('P01'), lessonId);
    assert.throws(() => checkRebuild(t.db, lessonId), /review progress/);
    t.db.prepare('DELETE FROM review_progress').run();
    t.db.prepare("UPDATE jobs SET status = 'running'").run();
    assert.throws(() => checkRebuild(t.db, lessonId), /being processed/);
    assert.throws(() => checkRebuild(t.db, 9999), /no lesson 9999/);
  });

  it('goes on only when the lesson id is typed', () => {
    assert.equal(confirmed('26', 26), true);
    assert.equal(confirmed(' 26 ', 26), true);
    assert.equal(confirmed('', 26), false);
    assert.equal(confirmed('yes', 26), false);
    assert.equal(confirmed('25', 26), false);
  });
});
