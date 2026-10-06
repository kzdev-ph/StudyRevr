// Restores a backup made with admin's "Download backup" over the app's database.
//   npm run restore -- studyrevr-backup-2026-10-06-1430.db
// Stop the server first: this refuses while it runs. It checks the file, asks you to type RESTORE, saves a copy of the
// current database next to it (pre-restore-<time>.db), then puts the backup in its place and brings it up to date.
// A backup holds no API keys (yours or the students') and no PIN, so enter the API key again in Admin afterwards.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { pidFile, runningServerPid } from '../src/server-pid.js';
import { SECRET_SETTINGS } from '../src/services/backup.js';

const MIGRATIONS = fs.readdirSync(new URL('../src/db/migrations/', import.meta.url)).filter((f) => /^\d+_.+\.sql$/.test(f));
const CONFIRM = 'RESTORE';

const stamp = (d = new Date()) => d.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

// A StudyRevr server answering on the configured port (a server started from another folder has no pid file here).
async function serverAnswers(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

// The backup's contents, or a reason it can't be restored.
function inspect(file) {
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const check = db.pragma('integrity_check', { simple: true });
    if (check !== 'ok') return { problem: `The file is damaged (integrity check: ${check}).` };
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
    if (!['lessons', 'settings', 'schema_migrations'].every((t) => tables.has(t))) return { problem: 'This is not a StudyRevr database.' };
    const versions = db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version);
    const unknown = versions.filter((v) => !MIGRATIONS.includes(v));
    if (unknown.length) return { problem: `This backup was made by a newer StudyRevr (${unknown.join(', ')}). Update the app first.` };
    const count = (t) => (tables.has(t) ? db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n : 0);
    const secrets = db.prepare(`SELECT COUNT(*) AS n FROM settings WHERE ${SECRET_SETTINGS}`).get().n + count('participant_ai_keys');
    return { lessons: count('lessons'), participants: count('participants'), reviews: count('flashcard_reviews'), sessions: count('study_sessions'), secrets };
  } catch (err) {
    return { problem: `The file can't be opened as a database (${err.code ?? err.message}).` };
  } finally {
    db?.close();
  }
}

async function main(args, { input = process.stdin, output = process.stdout } = {}) {
  const given = args.find((a) => !a.startsWith('--'));
  if (!given) {
    console.error('Usage: npm run restore -- <backup file>.db');
    return 2;
  }
  // npm runs this inside server/; a relative path means where you typed the command
  const file = path.resolve(process.env.INIT_CWD ?? process.cwd(), given);
  const config = loadConfig();
  const target = config.dbPath;
  if (target === ':memory:') {
    console.error('DB_PATH is :memory:, so there is no database file to restore into.');
    return 1;
  }
  if (!fs.existsSync(file)) {
    console.error(`No file at ${file}.`);
    return 1;
  }
  if (path.resolve(file) === path.resolve(target)) {
    console.error('That file is the database itself. Pick a backup file.');
    return 1;
  }

  const pid = runningServerPid(target);
  if (pid || (await serverAnswers(config.port))) {
    console.error(`The StudyRevr server is running${pid ? ` (process ${pid})` : ` on port ${config.port}`}. Stop it first (Ctrl+C in its window), then run this again.`);
    if (pid) console.error(`If no server is running (it was closed without stopping, or the number belongs to another program), delete ${pidFile(target)} and run this again.`);
    return 1;
  }

  const found = inspect(file);
  if (found.problem) {
    console.error(`Not restored: ${found.problem}`);
    return 1;
  }
  console.log(`Backup: ${file}`);
  console.log(`  ${found.lessons} lessons, ${found.participants} participant codes, ${found.reviews} flashcard answers, ${found.sessions} study sessions`);
  if (found.secrets) console.log('  Note: this file still holds API keys (it was not made with "Download backup").');
  console.log(`This replaces the database at ${target}.`);
  console.log('Everything recorded since the backup was made will be gone from the app (a copy of the current database is kept).');

  const rl = readline.createInterface({ input, output });
  const typed = await rl.question(`Type ${CONFIRM} to continue, or anything else to cancel: `);
  rl.close();
  if (typed.trim() !== CONFIRM) {
    console.log('Cancelled. Nothing was changed.');
    return 1;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    const keep = path.join(path.dirname(target), `pre-restore-${stamp()}.db`);
    const current = new Database(target, { fileMustExist: true });
    try {
      await current.backup(keep);
    } finally {
      current.close();
    }
    console.log(`Saved the current database as ${keep}`);
    console.log('  That copy still holds the API keys (yours and the students’). Delete it once you have checked that the restore works.');
  }

  // copy next to the target, then swap, so a failed copy never leaves half a database in place
  const incoming = `${target}.restoring`;
  fs.copyFileSync(file, incoming);
  for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(`${target}${suffix}`, { force: true });
  fs.renameSync(incoming, target);

  const db = openDb(target);
  try {
    const applied = runMigrations(db);
    if (applied.length) console.log(`Brought the backup up to date: ${applied.join(', ')}`);
  } finally {
    db.close();
  }

  console.log('Restored.');
  console.log('Before students use the app:');
  console.log('  - Enter the AI API key again in Admin > AI and study settings (backups hold no keys), or keep it in .env.');
  console.log('  - Check that ADMIN_PIN is set in .env (the PIN is never in a backup).');
  console.log('  - Students who used their own AI key need to add it again in Settings.');
  console.log('  - Delete the pre-restore-*.db copy next to the database once everything checks out: it holds API keys.');
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
