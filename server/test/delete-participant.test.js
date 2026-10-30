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

const PER_PARTICIPANT = ['flashcard_progress', 'flashcard_reviews', 'quiz_attempts', 'review_progress', 'study_sessions', 'events', 'setting_events'];

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
      await t.call('POST', '/api/setting-events', { as, body: { setting: 'motion', value: 'less' } });
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
    assert.match(res.out, /1 +setting changes/);
    assert.match(res.out, /Deleted P01/);
    const gone = counts('P01');
    assert.deepEqual({ ...gone, lessons: 0, flashcards: 0 }, { participant: 0, flashcard_progress: 0, flashcard_reviews: 0, quiz_attempts: 0, review_progress: 0, study_sessions: 0, events: 0, setting_events: 0, quiz_answers: 0, lessons: 0, flashcards: 0 });
    assert.deepEqual(counts('P02'), p02); // untouched, and lessons/cards still there
    // the deleted rows are not left readable in the file
    assert.ok(!fs.readFileSync(dbPath).includes(Buffer.from('P01')));
  });

  it('deletes their private uploaded lessons with everything on them; shared ones stay but lose the owner', async () => {
    let db = openDb(dbPath);
    const p01 = db.prepare("SELECT id FROM participants WHERE code = 'P01'").get().id;
    const p02 = db.prepare("SELECT id FROM participants WHERE code = 'P02'").get().id;
    const upload = (title, owner, sharedAt = null) => {
      const { lessonId } = seedLesson(db, { title });
      db.prepare("UPDATE lessons SET origin = 'student', owner_participant_id = ?, shared_at = ? WHERE id = ?").run(owner, sharedAt, lessonId);
      db.prepare("INSERT INTO lesson_events (participant_id, type, lesson_id, lesson_title, actor, detail, created_at, study_date) VALUES (?, 'lesson_uploaded', ?, ?, 'student', 'x.docx', '2026-10-05T04:00:00.000Z', '2026-10-05')").run(owner, lessonId, title);
      return lessonId;
    };
    const mineSecret = upload('P01 Private Secret Title', p01);
    const mineShared = upload('P01 Shared Title', p01, '2026-10-05T05:00:00.000Z');
    const theirs = upload('P02 Private Title', p02);
    db.close();

    const preview = await run(dbPath, ['P01'], 'P01\n');
    assert.equal(preview.code, 0, preview.out);
    assert.match(preview.out, /1 +private uploaded lessons/);
    assert.match(preview.out, /1 +shared uploaded lessons/);
    assert.match(preview.out, /2 +lesson upload events|1 +lesson upload events/);

    db = openDb(dbPath);
    const titles = db.prepare('SELECT title, origin, owner_participant_id AS owner FROM lessons WHERE id IN (?, ?, ?) ORDER BY id').all(mineSecret, mineShared, theirs);
    assert.deepEqual(titles, [
      { title: 'P01 Shared Title', origin: 'student', owner: null }, // stays, the owner is gone
      { title: 'P02 Private Title', origin: 'student', owner: p02 }, // someone else's private lesson is untouched
    ]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM flashcards WHERE lesson_id = ?').get(mineSecret).n, 0, 'its cards went with it');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lesson_events WHERE participant_id = ?').get(p01).n, 0, 'their upload events are gone with them');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lesson_events WHERE participant_id = ?').get(p02).n, 1);
    db.close();
    // the private lesson's text is not left readable in the file
    assert.ok(!fs.readFileSync(dbPath).includes(Buffer.from('P01 Private Secret Title')));
  });

  describe('by email', () => {
    const EMAIL = 'maria.santos.withdraw@example.test';
    const sessionCount = (db, email) => db.prepare('SELECT COUNT(*) n FROM auth_sessions WHERE account_id IN (SELECT id FROM accounts WHERE email = ?)').get(email).n;

    beforeEach(() => {
      const db = openDb(dbPath);
      db.prepare("UPDATE accounts SET email = ? WHERE participant_id = (SELECT id FROM participants WHERE code = 'P01')").run(EMAIL);
      db.close();
    });

    it('shows the email, deletes the account and its sessions, and the email is gone from the file', async () => {
      let db = openDb(dbPath);
      assert.equal(sessionCount(db, EMAIL), 1);
      db.close();
      assert.ok(fs.readFileSync(dbPath).includes(Buffer.from(EMAIL)), 'the scan can see the email before (so the check below means something)');

      const p02 = counts('P02');
      const res = await run(dbPath, ['  Maria.Santos.Withdraw@Example.test '], 'P01\n');
      assert.equal(res.code, 0, res.out);
      assert.match(res.out, /1 +account \(email and password\)/);
      assert.match(res.out, /1 +sign-in sessions/);
      assert.ok(res.out.includes(`P01 (${EMAIL})`), 'the email is shown when asking to confirm');
      assert.match(res.out, /Deleted P01/);
      assert.equal(counts('P01').participant, 0);
      assert.deepEqual(counts('P02'), p02);

      db = openDb(dbPath);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM accounts').get().n, 1, 'only the other participant keeps an account');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM auth_sessions').get().n, 1);
      db.close();
      for (const suffix of ['', '-wal']) {
        if (fs.existsSync(dbPath + suffix)) assert.ok(!fs.readFileSync(dbPath + suffix).includes(Buffer.from(EMAIL)), `email left in ${suffix || 'db file'}`);
      }
    });

    it('deleting by study ID removes the account too', async () => {
      assert.equal((await run(dbPath, ['P01', '--yes'])).code, 0);
      const db = openDb(dbPath);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM accounts WHERE email = ?').get(EMAIL).n, 0);
      db.close();
      assert.ok(!fs.readFileSync(dbPath).includes(Buffer.from(EMAIL)));
    });

    it('cancelling by email deletes nothing; an unknown email is an error', async () => {
      const cancelled = await run(dbPath, [EMAIL], 'no\n');
      assert.equal(cancelled.code, 1);
      assert.match(cancelled.out, /Cancelled/);
      assert.equal(counts('P01').participant, 1);
      const unknown = await run(dbPath, ['nobody@example.test', '--yes']);
      assert.equal(unknown.code, 1);
      assert.match(unknown.out, /not an account/);
      assert.equal(counts('P01').participant, 1);
      assert.equal(counts('P02').participant, 1);
    });
  });

  it('--yes skips the question; an unknown or bad code is an error', async () => {
    assert.equal((await run(dbPath, ['P02', '--yes'])).code, 0);
    assert.equal(counts('P02').participant, 0);
    assert.equal((await run(dbPath, ['P09', '--yes'])).code, 1);
    assert.equal((await run(dbPath, ['Maria'])).code, 2);
  });
});
