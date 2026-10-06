import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { pidFile } from '../src/server-pid.js';
import { backupFileName, makeBackup, removeLeftoverBackups, removeTemp } from '../src/services/backup.js';
import { addCodes, seedLesson, TEST_PIN } from './helpers.js';

const SCRIPT = fileURLToPath(new URL('../scripts/restore.js', import.meta.url));
const ADMIN_KEY = 'AIza-BACKUP-ADMIN-SECRET-1';
const STUDENT_KEY = 'sk-BACKUP-STUDENT-SECRET-2';

// A port nothing listens on, so the script's "is a server answering?" check finds none.
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// Runs `npm run restore` (the script itself) on `dbPath`, typing `answer`. -> { code, out }
async function restore(file, dbPath, answer) {
  const port = await freePort();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, file], { env: { ...process.env, DB_PATH: dbPath, PORT: String(port), INIT_CWD: path.dirname(dbPath) } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(answer === undefined ? '' : `${answer}\n`);
  });
}

async function startApp(db) {
  const app = createApp(db, { maxUploadBytes: 1024 * 1024, adminPin: TEST_PIN, clientDist: null }, { runner: { enqueue() {} }, clock: () => new Date('2026-10-06T06:30:00.000Z') });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

describe('backup and restore', () => {
  let dir;
  let backupFile;
  let backupName;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyrevr-backup-'));
    // the "study laptop" database: data, the admin's saved key and a student's own key
    const db = openDb(path.join(dir, 'source.db'));
    runMigrations(db);
    addCodes(db, 'P01');
    seedLesson(db, { title: 'Backed up lesson' });
    db.prepare("INSERT INTO settings (key, value) VALUES ('ai_api_key:google', ?), ('ai_model:google', 'gemini-3.5-flash-lite')").run(ADMIN_KEY);
    const p01 = db.prepare("SELECT id FROM participants WHERE code = 'P01'").get().id;
    db.prepare("INSERT INTO participant_ai_keys VALUES (?, 'deepseek', 'deepseek-chat', ?, 'ET-2', 'x', 'x')").run(p01, STUDENT_KEY);

    const app = await startApp(db);
    try {
      const refused = await fetch(`${app.base}/api/admin/backup`);
      assert.equal(refused.status, 401, 'admin only');
      const res = await fetch(`${app.base}/api/admin/backup`, { headers: { 'x-admin-pin': TEST_PIN } });
      assert.equal(res.status, 200);
      backupName = /filename="([^"]+)"/.exec(res.headers.get('content-disposition'))[1];
      backupFile = path.join(dir, backupName);
      fs.writeFileSync(backupFile, Buffer.from(await res.arrayBuffer()));
      const last = await (await fetch(`${app.base}/api/admin/backup/last`, { headers: { 'x-admin-pin': TEST_PIN } })).json();
      assert.deepEqual(last.last, { file: backupName, created_at: '2026-10-06T06:30:00.000Z' });
    } finally {
      await app.close();
      db.close();
    }
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('names the file in Manila time', () => {
    assert.equal(backupName, 'studyrevr-backup-2026-10-06-1430.db');
    assert.equal(backupFileName(new Date('2026-10-05T20:05:00.000Z')), 'studyrevr-backup-2026-10-06-0405.db');
  });

  it('the temporary copy is made next to the database, never in the system temp folder, and is gone afterwards', async () => {
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('backup-tmp-')), [], 'the download left nothing behind');
    const db = openDb(path.join(dir, 'tmpcheck.db'));
    runMigrations(db);
    try {
      const made = await makeBackup(db);
      assert.equal(path.dirname(made.file), dir);
      assert.ok(made.file.endsWith('.db'), 'its name ends in .db so .gitignore covers it');
      removeTemp(made.file);
      assert.ok(!fs.existsSync(made.file));
      // a failed copy removes its file too
      await assert.rejects(makeBackup(db, { dir: path.join(dir, 'no-such-folder') }));
    } finally {
      db.close();
    }
  });

  it('leftover temporary backups (and their journals) are removed at start, other files stay', () => {
    const folder = fs.mkdtempSync(path.join(dir, 'leftover-'));
    for (const name of ['backup-tmp-a.db', 'backup-tmp-a.db-journal', 'backup-tmp-b.db', 'studyrevr.db', 'pre-restore-1.db', 'studyrevr-backup-2026-10-06-1430.db']) {
      fs.writeFileSync(path.join(folder, name), 'x');
    }
    assert.equal(removeLeftoverBackups(path.join(folder, 'studyrevr.db')), 3);
    assert.deepEqual(fs.readdirSync(folder).sort(), ['pre-restore-1.db', 'studyrevr-backup-2026-10-06-1430.db', 'studyrevr.db']);
    assert.equal(removeLeftoverBackups(':memory:'), 0);
  });

  it('the backup holds the data but no API key and no PIN, not even in its free pages', () => {
    const bytes = fs.readFileSync(backupFile).toString('latin1');
    for (const secret of [ADMIN_KEY, STUDENT_KEY, TEST_PIN]) assert.ok(!bytes.includes(secret), secret);
    assert.ok(!fs.existsSync(`${backupFile}-wal`));
    const copy = openDb(backupFile);
    try {
      assert.equal(copy.prepare("SELECT COUNT(*) n FROM settings WHERE key LIKE 'ai_api_key:%'").get().n, 0);
      assert.equal(copy.prepare('SELECT COUNT(*) n FROM participant_ai_keys').get().n, 0);
      assert.equal(copy.prepare("SELECT value FROM settings WHERE key = 'ai_model:google'").get().value, 'gemini-3.5-flash-lite', 'other settings stay');
      assert.equal(copy.prepare('SELECT title FROM lessons').get().title, 'Backed up lesson');
    } finally {
      copy.close();
    }
  });

  it('npm run restore puts the backup in place, keeps a copy of the old database, and the app works on it', async () => {
    const live = path.join(dir, 'live', 'studyrevr.db');
    fs.mkdirSync(path.dirname(live));
    const old = openDb(live);
    runMigrations(old);
    seedLesson(old, { title: 'Lesson made after the backup' });
    old.close();

    const { code, out } = await restore(backupFile, live, 'RESTORE');
    assert.equal(code, 0, out);
    assert.match(out, /Enter the AI API key again/);
    assert.match(out, /ADMIN_PIN/);
    assert.match(out, /pre-restore-.*hold|holds the API keys/s, 'the pre-restore copy holds keys: the message says to delete it');
    const kept = fs.readdirSync(path.dirname(live)).filter((f) => f.startsWith('pre-restore-'));
    assert.equal(kept.length, 1, 'a copy of the database before the restore');

    const db = openDb(live);
    const app = await startApp(db);
    try {
      const { lessons } = await (await fetch(`${app.base}/api/lessons`)).json();
      assert.deepEqual(lessons.map((l) => l.title), ['Backed up lesson']);
      const participant = await fetch(`${app.base}/api/participants/P01`);
      assert.equal(participant.status, 200, 'participant codes came back');
      assert.equal(db.prepare("SELECT COUNT(*) n FROM settings WHERE key LIKE 'ai_api_key:%'").get().n, 0);
    } finally {
      await app.close();
      db.close();
    }
    const keptDb = openDb(path.join(path.dirname(live), kept[0]));
    assert.equal(keptDb.prepare('SELECT title FROM lessons').get().title, 'Lesson made after the backup');
    keptDb.close();
  });

  it('asks for RESTORE and changes nothing otherwise', async () => {
    const live = path.join(dir, 'cancel.db');
    const db = openDb(live);
    runMigrations(db);
    seedLesson(db, { title: 'Keep me' });
    db.close();
    const { code, out } = await restore(backupFile, live, 'yes');
    assert.equal(code, 1);
    assert.match(out, /Cancelled/);
    const after = openDb(live);
    assert.equal(after.prepare('SELECT title FROM lessons').get().title, 'Keep me');
    after.close();
  });

  it('refuses while the server is running on that database', async () => {
    const live = path.join(dir, 'running.db');
    fs.writeFileSync(pidFile(live), `${process.pid}\n`); // this test process stands in for the server
    try {
      const { code, out } = await restore(backupFile, live, 'RESTORE');
      assert.equal(code, 1);
      assert.match(out, /server is running/);
      assert.match(out, /delete .*running\.db\.pid/, 'says how to clear a stale pid file');
      assert.ok(!fs.existsSync(live));
    } finally {
      fs.rmSync(pidFile(live), { force: true });
    }
  });

  it('refuses a file that is not a StudyRevr database', async () => {
    const junk = path.join(dir, 'junk.db');
    fs.writeFileSync(junk, 'not a database at all');
    const { code, out } = await restore(junk, path.join(dir, 'x.db'), 'RESTORE');
    assert.equal(code, 1);
    assert.match(out, /Not restored/);
  });
});
