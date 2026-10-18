import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, runMigrations } from '../src/db/index.js';
import { quizCheck } from '../scripts/quiz-check.js';
import { EN_LESSON, FIL_LESSON } from './fixtures/leak-lessons.js';

const SCRIPT = fileURLToPath(new URL('../scripts/quiz-check.js', import.meta.url));

// The two fixture lessons, written into a database file the way the app stores them.
function seed(db) {
  const ids = {};
  for (const lesson of [EN_LESSON, FIL_LESSON]) {
    const lessonId = Number(db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status) VALUES (?, 'x.pptx', ?, 100, 'ready')").run(lesson.title, lesson.text).lastInsertRowid);
    ids[lesson.title] = lessonId;
    for (const term of lesson.keyTerms) db.prepare('INSERT INTO key_terms (lesson_id, term, definition) VALUES (?, ?, ?)').run(lessonId, term, 'x');
    const byOld = new Map();
    lesson.cards.forEach((c, i) => {
      byOld.set(c.id, Number(db.prepare('INSERT INTO flashcards (lesson_id, kind, front, back, evidence, position) VALUES (?, ?, ?, ?, ?, ?)').run(lessonId, c.kind, c.front, c.back, c.evidence, i + 1).lastInsertRowid));
    });
    for (const [old, wrong] of Object.entries(lesson.distractors))
      db.prepare("INSERT INTO quiz_distractors (flashcard_id, choices, made_at) VALUES (?, ?, 'x')").run(byOld.get(Number(old)), JSON.stringify(wrong));
  }
  return ids;
}

describe('npm run quiz:check', () => {
  let dir;
  let dbPath;
  let ids;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyrevr-quizcheck-'));
    dbPath = path.join(dir, 'study.db');
    const db = openDb(dbPath);
    runMigrations(db);
    ids = seed(db);
    db.close();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reports every lesson: flagged cards, skipped questions by rule, and the clean questions line', () => {
    const { code, out } = quizCheck(['--db', dbPath]);
    assert.equal(code, 0);
    assert.match(out, /Lesson \d+: Photosynthesis basics \(ready\)/);
    assert.match(out, /Lesson \d+: Pag-unlad ng Wika \(ready\)/);
    assert.equal(out.match(/Clean questions available: 5 of 10/g).length, 2);
    assert.match(out, /Flashcards that give their answer away \(g, i, j, k\): 1 {2}\[g 1\]/, 'English: card 7 (g)');
    assert.match(out, /Info: term definitions that name their term \(h; the quiz blanks it\): #\d+/, 'English: card 3 (h), information only');
    assert.match(out, /Multiple choice: 4 possible, 2 clean, 2 skipped {2}\[c 2, f 1\]/, 'English: cards 5 (tone; one option also restates the answer) and 6 (length)');
    assert.match(out, /Term definitions shown with the term blanked \(d\)/);
    assert.match(out, /#\d+ "Why do leaves look green\?" .*tone/);
  });

  it('checks one lesson with --lesson, and a relative --db is resolved from where it was typed', () => {
    const { code, out } = quizCheck(['--db', 'study.db', '--lesson', String(ids['Pag-unlad ng Wika'])], { cwd: dir });
    assert.equal(code, 0);
    assert.doesNotMatch(out, /Photosynthesis/);
    assert.match(out, /Multiple choice: 3 possible, 1 clean, 2 skipped {2}\[c 2, f 1\]/, 'Filipino: cards 14 (tone; one wrong answer is about nothing in the lesson) and 16 (opening; one echoed word is not rule b)');
    assert.match(out, /opening: every wrong option starts "malaking papel"/);
  });

  it('opens the database read-only and changes nothing', () => {
    const before = fs.readFileSync(dbPath);
    quizCheck(['--db', dbPath]);
    assert.ok(fs.readFileSync(dbPath).equals(before));
  });

  it('works on a database from before the settled column (migration 010)', () => {
    const db = openDb(dbPath);
    db.exec("ALTER TABLE quiz_distractors DROP COLUMN settled; DELETE FROM schema_migrations WHERE version LIKE '010%'");
    db.close();
    const { code, out } = quizCheck(['--db', dbPath]);
    assert.equal(code, 0);
    assert.equal(out.match(/Clean questions available: 5 of 10/g).length, 2);
  });

  it('explains bad arguments, a missing file and an unknown lesson', () => {
    assert.equal(quizCheck(['--lesson', 'abc'], { dbPath }).code, 2);
    assert.equal(quizCheck(['--nope'], { dbPath }).code, 2);
    assert.match(quizCheck(['--db', path.join(dir, 'missing.db')]).err, /Couldn't open/);
    assert.match(quizCheck(['--db', dbPath, '--lesson', '999']).err, /Lesson 999 isn't in/);
    fs.writeFileSync(path.join(dir, 'other.db'), '');
    assert.match(quizCheck(['--db', path.join(dir, 'other.db')]).err, /isn't a StudyRevr database/);
  });

  it('runs as a command, using DB_PATH when no --db is given', async () => {
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, DB_PATH: dbPath }, stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '';
      child.stdout.on('data', (d) => { text += d; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, text }));
    });
    assert.equal(out.code, 0);
    assert.match(out.text, /Clean questions available: 5 of 10/);
  });
});
