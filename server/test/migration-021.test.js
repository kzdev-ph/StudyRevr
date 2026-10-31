import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, runMigrations } from '../src/db/index.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');

// A database as it was before 021 (migrations 001-020).
function db020() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyrevr-mig-'));
  for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f < '021')) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
  const db = openDb(':memory:');
  runMigrations(db, dir);
  fs.rmSync(dir, { recursive: true });
  return db;
}

const hasColumn = (db, table, name) =>
  db.prepare('SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = ?').get(table, name).n === 1;

describe('migration 021: quiz_statements and quiz_answers.form', () => {
  it('adds the table and the column; answers made before it have a NULL form', () => {
    const db = db020();
    const lesson = Number(db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status) VALUES ('L', 'l.pdf', 't', 1, 'ready')").run().lastInsertRowid);
    const attempt = Number(db.prepare('INSERT INTO quiz_attempts (lesson_id, score, total) VALUES (?, 0, 1)').run(lesson).lastInsertRowid);
    db.prepare("INSERT INTO quiz_answers (attempt_id, position, type, kind, question, choices, answer_index, answer_text) VALUES (?, 0, 'tf', 'concept', 'q', '[\"True\",\"False\"]', 0, 'a')").run(attempt);
    assert.equal(hasColumn(db, 'quiz_answers', 'form'), false);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'quiz_statements'").get().n, 0);

    assert.equal(runMigrations(db)[0], '021_quiz_statements.sql');

    assert.equal(hasColumn(db, 'quiz_answers', 'form'), true);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'quiz_statements'").get().n, 1);
    assert.equal(db.prepare('SELECT form FROM quiz_answers WHERE attempt_id = ?').get(attempt).form, null);
    db.prepare("UPDATE quiz_answers SET form = 'statement' WHERE attempt_id = ?").run(attempt);
    assert.equal(db.prepare('SELECT form FROM quiz_answers WHERE attempt_id = ?').get(attempt).form, 'statement');
    db.close();
  });

  it('deleting a flashcard deletes its statements row, and the status is checked', () => {
    const db = db020();
    runMigrations(db);
    const lesson = Number(db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status) VALUES ('L', 'l.pdf', 't', 1, 'ready')").run().lastInsertRowid);
    const card = Number(db.prepare("INSERT INTO flashcards (lesson_id, front, back) VALUES (?, 'f', 'b')").run(lesson).lastInsertRowid);
    db.prepare("INSERT INTO quiz_statements (flashcard_id, card_hash, true_text, false_text, status) VALUES (?, 'h', 't', 'f', 'ok')").run(card);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM quiz_statements').get().n, 1);
    assert.throws(() => db.prepare("INSERT INTO quiz_statements (flashcard_id, card_hash, status) VALUES (?, 'h', 'maybe')").run(card));

    db.prepare('DELETE FROM flashcards WHERE id = ?').run(card);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM quiz_statements').get().n, 0);
    db.close();
  });
});
