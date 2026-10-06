import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, runMigrations } from '../src/db/index.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');

// A database as it was after Phase 5 (migrations 001-007), with study data in it.
function phase5Db() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyrevr-mig-'));
  for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f < '008')) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
  const db = openDb(':memory:');
  runMigrations(db, dir);
  fs.rmSync(dir, { recursive: true });
  const lesson = Number(db.prepare("INSERT INTO lessons (title, filename, status) VALUES ('L', 'l.pptx', 'ready')").run().lastInsertRowid);
  const card = (state, due) =>
    Number(
      db
        .prepare("INSERT INTO flashcards (lesson_id, front, back, state, ease, interval, due_at, reps, lapses, step) VALUES (?, 'f', 'b', ?, 2.3, 4, ?, 3, 1, 0)")
        .run(lesson, state, due).lastInsertRowid,
    );
  const studied = card(2, '2026-10-04T20:00:00.000Z');
  const fresh = Number(db.prepare("INSERT INTO flashcards (lesson_id, front, back) VALUES (?, 'f2', 'b2')").run(lesson).lastInsertRowid);
  db.prepare("INSERT INTO flashcard_reviews (flashcard_id, rating, reviewed_at, state, snapshot) VALUES (?, 3, '2026-10-01T05:00:00.000Z', 0, '{}')").run(studied);
  db.prepare("INSERT INTO flashcard_reviews (flashcard_id, rating, reviewed_at, state, snapshot) VALUES (?, 4, '2026-10-02T05:00:00.000Z', 1, '{}')").run(studied);
  const attempt = Number(
    db.prepare("INSERT INTO quiz_attempts (lesson_id, score, total, started_at, finished_at) VALUES (?, 3, 4, '2026-10-02T06:00:00Z', '2026-10-02T06:05:00Z')").run(lesson).lastInsertRowid,
  );
  db.prepare("INSERT INTO quiz_answers (attempt_id, position, type, kind, question, choices, answer_index, answer_text) VALUES (?, 0, 'tf', 'concept', 'q', '[\"True\",\"False\"]', 0, 'a')").run(attempt);
  db.prepare("INSERT INTO review_progress (lesson_id, last_section, completed_sections) VALUES (?, 2, '[0,1]')").run(lesson);
  db.prepare("INSERT INTO study_sessions (lesson_id, tab, started_at, duration_sec) VALUES (?, 'flashcard', '2026-10-01T19:30:00.000Z', 90)").run(lesson);
  return { db, lesson, studied, fresh, attempt };
}

describe('migration 008: participants', () => {
  it('moves every existing record to P00 and loses nothing', () => {
    const { db, lesson, studied, fresh, attempt } = phase5Db();
    const before = Object.fromEntries(['flashcards', 'flashcard_reviews', 'quiz_attempts', 'quiz_answers', 'review_progress', 'study_sessions'].map((t) => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
    assert.equal(runMigrations(db)[0], '008_participants.sql');

    const p00 = db.prepare("SELECT id FROM participants WHERE code = 'P00'").get().id;
    assert.deepEqual(db.prepare('SELECT code FROM participants').all(), [{ code: 'P00' }]);
    for (const [table, n] of Object.entries(before)) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, n, table);

    // the studied card's schedule became P00's; the new card has no schedule row (it is new for everyone)
    assert.deepEqual(db.prepare('SELECT participant_id, flashcard_id, state, ease, interval, due_at, reps, lapses FROM flashcard_progress').all(), [
      { participant_id: p00, flashcard_id: studied, state: 2, ease: 2.3, interval: 4, due_at: '2026-10-04T20:00:00.000Z', reps: 3, lapses: 1 },
    ]);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM flashcard_progress WHERE flashcard_id = ?').get(fresh).n, 0);
    assert.deepEqual(db.prepare('SELECT DISTINCT participant_id FROM flashcard_reviews').all(), [{ participant_id: p00 }]);
    assert.deepEqual(db.prepare('SELECT id, participant_id, score FROM quiz_attempts').all(), [{ id: attempt, participant_id: p00, score: 3 }]);
    assert.deepEqual(db.prepare('SELECT participant_id, lesson_id, last_section, completed_sections FROM review_progress').get(), {
      participant_id: p00, lesson_id: lesson, last_section: 2, completed_sections: '[0,1]',
    });
    // the old session row: flashcard -> flashcards, seconds -> ms, and its 04:00 Manila study day (03:30 Oct 2 -> Oct 1)
    const s = db.prepare('SELECT participant_id, activity, active_ms, study_date FROM study_sessions').get();
    assert.deepEqual(s, { participant_id: p00, activity: 'flashcards', active_ms: 90_000, study_date: '2026-10-01' });
    db.close();
  });

  it('works on an empty database and can run again safely', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    assert.deepEqual(runMigrations(db), []);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM participants').get().n, 1);
    db.close();
  });
});
