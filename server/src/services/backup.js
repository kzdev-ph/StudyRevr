import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

// "Download backup" (admin) and `npm run restore`. A backup is a copy of the whole SQLite database made with SQLite's
// online backup API (safe while the app runs), with every secret removed: the admin's saved API keys
// (settings ai_api_key:*) and the students' own keys (participant_ai_keys). The admin PIN lives only in .env and is
// never in the database. After deleting, the copy is rewritten (secure_delete + VACUUM) so the keys can't be read back
// from free pages, and it is left as one self-contained file (no -wal).

export const SECRET_SETTINGS = "key LIKE 'ai\\_api\\_key:%' ESCAPE '\\'";

// "studyrevr-backup-2026-10-06-1430.db", in Manila time (the study's time zone).
export function backupFileName(now = new Date(), timeZone = 'Asia/Manila') {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `studyrevr-backup-${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}.db`;
}

// Removes every secret from a database file in place and compacts it.
export function stripSecrets(file) {
  const copy = new Database(file);
  try {
    copy.pragma('journal_mode = DELETE'); // one file, and no write-ahead log that could keep a deleted key
    copy.pragma('secure_delete = ON');
    copy.prepare(`DELETE FROM settings WHERE ${SECRET_SETTINGS}`).run();
    const hasKeys = copy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'participant_ai_keys'").get();
    if (hasKeys) copy.prepare('DELETE FROM participant_ai_keys').run();
    copy.exec('VACUUM');
  } finally {
    copy.close();
  }
}

// The temporary copy lives next to the database (the app's git-ignored data folder), never in the system temp folder:
// until stripSecrets has run it still holds every key. Its name ends in .db so .gitignore covers it.
const TEMP_PREFIX = 'backup-tmp-';
const tempDirFor = (db) => (db.memory || !db.name ? os.tmpdir() : path.dirname(path.resolve(db.name))); // memory: tests only

// Deletes temporary backups a crash left behind (and their -journal / -wal files). Run when the server starts.
export function removeLeftoverBackups(dbPath) {
  if (!dbPath || dbPath === ':memory:') return 0;
  const dir = path.dirname(path.resolve(dbPath));
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(TEMP_PREFIX) && /\.db(-journal|-wal|-shm)?$/.test(name)) {
        fs.rmSync(path.join(dir, name), { force: true });
        removed += 1;
      }
    }
  } catch {
    // no data folder yet
  }
  return removed;
}

// Makes a sanitised backup of `db` in a temporary file. -> { file (temp path; the caller deletes it), name }
export async function makeBackup(db, { now = new Date(), dir = tempDirFor(db) } = {}) {
  const file = path.join(dir, `${TEMP_PREFIX}${randomUUID()}.db`);
  try {
    await db.backup(file);
    stripSecrets(file);
  } catch (err) {
    removeTemp(file);
    throw err;
  }
  return { file, name: backupFileName(now) };
}

// The temp file and anything SQLite may have left beside it.
export const removeTemp = (file) => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
};

export function logAdminEvent(db, type, detail, now = new Date()) {
  db.prepare('INSERT INTO admin_events (type, detail, created_at) VALUES (?, ?, ?)').run(type, detail ?? null, now.toISOString());
}

export function lastBackup(db) {
  return db.prepare("SELECT detail AS file, created_at FROM admin_events WHERE type = 'backup' ORDER BY id DESC LIMIT 1").get() ?? null;
}
