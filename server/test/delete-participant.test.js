import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, runMigrations } from '../src/db/index.js';
import { addCodes, seedLesson, startStudyApp } from './helpers.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'delete-participant.js');

// Runs the withdrawal script on the database file, typing `input` at its prompt.
function run(dbPath, args, input = '') {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, DB_PATH: dbPath }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
}

const PER_PARTICIPANT = ['flashcard_progress', 'flashcard_reviews', 'quiz_attempts', 'review_progress', 'study_sessions', 'events'];

describe('npm run participant:delete', () => {
  let dir;
  let dbPath;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyrevr-withdraw-'));
    dbPath = path.join(dir, 'study.db');
    const db = openDb(dbPath);
    runMigrations(db);
    addCodes(db, 'P01', 'P02');
    const { lessonId, cards } = seedLesson(db);
    db.prepare("INSERT INTO quiz_distractors (flashcard_id, choices) SELECT id, '[]' FROM flashcards").run();
    const t = await startStudyApp({ db });
    // both participants study the same lesson
    for (const as of ['P01', 'P02']) {
      await t.call('POST', `/api/flashcards/${cards[0]}/review`, { as, body: { rating: 3, deck: lessonId } });
      const quiz = (await t.call('POST', `/api/lessons/${lessonId}/quiz/attempts`, { as, body: {} })).body;
      await t.call('POST', `/api/quiz/attempts/${quiz.attempt.id}/answers`, { as, body: { position: 0, choice: 0 } });
      await t.call('PUT', `/api/lessons/${lessonId}/review-progress`, { as, body: { last_section: 1 } });
      await t.call('POST', '/api/sessions', { as, body: { lesson_id: lessonId, activity: 'reading' } });
      await t.call('POST', '/api/events', { as, body: { type: 'stats_view' } });
    }
    await t.close();
    db.close();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const counts = (code) => {
    const db = openDb(dbPath);
    const id = db.prepare('SELECT id FROM participants WHERE code = ?').get(code)?.id ?? -1;
    const c = Object.fromEntries(PER_PARTICIPANT.map((table) => [table, db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE participant_id = ?`).get(id).n]));
    c.participant = id === -1 ? 0 : 1;
    c.quiz_answers = db.prepare('SELECT COUNT(*) n FROM quiz_answers WHERE attempt_id IN (SELECT id FROM quiz_attempts WHERE participant_id = ?)').get(id).n;
    c.lessons = db.prepare('SELECT COUNT(*) n FROM lessons').get().n;
    c.flashcards = db.prepare('SELECT COUNT(*) n FROM flashcards').get().n;
    db.close();
    return c;
  };

  it('asks for the code again; anything else cancels and deletes nothing', async () => {
    const before = counts('P01');
    const res = await run(dbPath, ['P01'], 'P02\n');
    assert.equal(res.code, 1);
    assert.match(res.out, /Cancelled/);
    assert.deepEqual(counts('P01'), before);
  });

  it('deletes every record of that participant only; lessons and cards stay', async () => {
    const p02 = counts('P02');
    assert.ok(Object.values(p02).every((n) => n > 0), JSON.stringify(p02));
    const res = await run(dbPath, ['p1'], 'p01\n');
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /1 +flashcard answers/);
    assert.match(res.out, /Deleted P01/);
    const gone = counts('P01');
    assert.deepEqual({ ...gone, lessons: 0, flashcards: 0 }, { participant: 0, flashcard_progress: 0, flashcard_reviews: 0, quiz_attempts: 0, review_progress: 0, study_sessions: 0, events: 0, quiz_answers: 0, lessons: 0, flashcards: 0 });
    assert.deepEqual(counts('P02'), p02); // untouched, and lessons/cards still there
    // the deleted rows are not left readable in the file
    assert.ok(!fs.readFileSync(dbPath).includes(Buffer.from('P01')));
  });

  it('--yes skips the question; an unknown or bad code is an error', async () => {
    assert.equal((await run(dbPath, ['P02', '--yes'])).code, 0);
    assert.equal(counts('P02').participant, 0);
    assert.equal((await run(dbPath, ['P09', '--yes'])).code, 1);
    assert.equal((await run(dbPath, ['Maria'])).code, 2);
  });
});
