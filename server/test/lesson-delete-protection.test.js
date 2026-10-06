import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addCodes, seedLesson, startStudyApp, TEST_PIN } from './helpers.js';

// Deleting a lesson is blocked once a participant other than P00 has studied it. Deleting would remove their flashcard
// answers and quiz attempts (and answers) and cut their sessions and events off from the lesson.
describe('deleting a lesson that participants have studied', () => {
  let t;
  let lessonId;
  let cards;
  const idOf = (code) => t.db.prepare('SELECT id FROM participants WHERE code = ?').get(code).id;
  const del = (id = lessonId, pin = TEST_PIN) => t.call('DELETE', `/api/lessons/${id}`, { pin });
  const lessonExists = () => Boolean(t.db.prepare('SELECT 1 FROM lessons WHERE id = ?').get(lessonId));

  const addReview = (code) =>
    t.db.prepare('INSERT INTO flashcard_reviews (participant_id, flashcard_id, rating) VALUES (?, ?, 3)').run(idOf(code), cards[0]);
  const addAttempt = (code, answers = 0) => {
    const attemptId = Number(t.db.prepare('INSERT INTO quiz_attempts (participant_id, lesson_id, score, total) VALUES (?, ?, 0, 2)').run(idOf(code), lessonId).lastInsertRowid);
    for (let i = 0; i < answers; i++) {
      t.db
        .prepare(`INSERT INTO quiz_answers (attempt_id, position, flashcard_id, type, kind, question, choices, answer_index, answer_text)
                  VALUES (?, ?, ?, 'mc', 'concept', 'Q?', '["a","b"]', 0, 'a')`)
        .run(attemptId, i, cards[i]);
    }
    return attemptId;
  };
  const addSession = (code) =>
    t.db
      .prepare("INSERT INTO study_sessions (participant_id, lesson_id, activity, started_at, last_active_at, study_date) VALUES (?, ?, 'reading', '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z', '2026-10-05')")
      .run(idOf(code), lessonId);
  const addEvent = (code) =>
    t.db.prepare("INSERT INTO events (participant_id, type, lesson_id, section_index, created_at, study_date) VALUES (?, 'section_simplify', ?, 0, '2026-10-05T00:00:00Z', '2026-10-05')").run(idOf(code), lessonId);

  beforeEach(async () => {
    t = await startStudyApp();
    addCodes(t.db, 'P01', 'P02');
    ({ lessonId, cards } = seedLesson(t.db));
  });
  afterEach(() => t.close());

  it('is blocked, with the counts it would remove, and nothing is deleted', async () => {
    addReview('P01');
    addReview('P02');
    addAttempt('P01', 2);
    addSession('P01');
    addSession('P02');
    addSession('P02');
    addEvent('P01');

    const res = await del();
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'lesson_has_records');
    assert.deepEqual(res.body.error.records, { flashcard_answers: 2, quiz_attempts: 1, quiz_answers: 2, sessions: 3, events: 1 });
    assert.match(res.body.error.message, /can’t be deleted/);
    assert.match(res.body.error.message, /remove 2 flashcard answers and 1 quiz attempt \(2 quiz answers\)/);
    assert.match(res.body.error.message, /cut 3 study sessions and 1 event off from the lesson/);

    assert.ok(lessonExists());
    const count = (table) => t.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    assert.deepEqual([count('flashcards'), count('flashcard_reviews'), count('quiz_attempts'), count('quiz_answers'), count('study_sessions')], [4, 2, 1, 2, 3]);
  });

  for (const [what, add] of [
    ['a flashcard answer', () => addReview('P01')],
    ['a quiz attempt', () => addAttempt('P01')],
    ['a quiz answer', () => addAttempt('P01', 1)],
    ['a study session', () => addSession('P01')],
    ['an event', () => addEvent('P01')],
  ]) {
    it(`is blocked by ${what} alone`, async () => {
      add();
      assert.equal((await del()).status, 409);
      assert.ok(lessonExists());
    });
  }

  it('does not count P00, the researcher’s test data: the lesson is deleted along with it', async () => {
    addReview('P00');
    addAttempt('P00', 2);
    addSession('P00');
    addEvent('P00');
    assert.equal((await del()).status, 204);
    assert.equal(lessonExists(), false);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM quiz_attempts').get().n, 0);
  });

  it('is allowed when the participants have not studied it, or their data is withdrawn first', async () => {
    const other = seedLesson(t.db, { title: 'Other' });
    addReview('P01'); // on the first lesson only
    assert.equal((await del(other.lessonId)).status, 204);

    assert.equal((await del()).status, 409);
    t.db.prepare('DELETE FROM participants WHERE code = ?').run('P01'); // what npm run participant:delete does
    assert.equal((await del()).status, 204);
  });

  it('still needs the admin PIN and still answers 404 for an unknown lesson', async () => {
    addReview('P01');
    assert.equal((await del(lessonId, null)).status, 401);
    assert.equal((await del(9999)).status, 404);
  });
});
