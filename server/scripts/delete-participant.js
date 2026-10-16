// Withdrawal: deletes every record of one participant (flashcard schedule and answers, quiz attempts and answers,
// review progress, sessions, events, live AI requests and their own saved AI key) and the code itself. Shared lessons and cards stay.
//   npm run participant:delete -- P07          asks you to type the code again to confirm
//   npm run participant:delete -- P07 --yes    no question (scripts)
// Stop the server first if you can; it is safe either way (SQLite locks the file while writing).
import readline from 'node:readline/promises';
import { loadConfig } from '../src/config.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { findParticipant, normalizeCode } from '../src/participants/codes.js';

const TABLES = [
  ['flashcard_progress', 'flashcard schedules'],
  ['flashcard_reviews', 'flashcard answers'],
  ['quiz_attempts', 'quiz attempts'],
  ['review_progress', 'review positions'],
  ['study_sessions', 'study sessions'],
  ['events', 'events'],
  ['setting_events', 'setting changes'],
  ['ai_calls', 'live AI requests'],
  ['participant_ai_keys', 'saved own AI key'],
];

async function main(args) {
  const yes = args.includes('--yes');
  const raw = args.find((a) => !a.startsWith('--'));
  const code = normalizeCode(raw);
  if (!code) {
    console.error('Usage: npm run participant:delete -- P07');
    return 2;
  }
  const config = loadConfig();
  const db = openDb(config.dbPath);
  try {
    runMigrations(db);
    const participant = findParticipant(db, code);
    if (!participant) {
      console.error(`${code} is not a participant in ${config.dbPath}. Nothing was deleted.`);
      return 1;
    }
    const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE participant_id = ?`).get(participant.id).n;
    const answers = db.prepare('SELECT COUNT(*) AS n FROM quiz_answers WHERE attempt_id IN (SELECT id FROM quiz_attempts WHERE participant_id = ?)').get(participant.id).n;
    console.log(`This permanently deletes everything recorded for ${code} (database: ${config.dbPath}):`);
    for (const [table, label] of TABLES) console.log(`  ${String(count(table)).padStart(6)}  ${label}`);
    console.log(`  ${String(answers).padStart(6)}  quiz answers`);
    console.log('Lessons and flashcards are shared and stay.');
    if (code === 'P00') console.log('Note: P00 is your own test data.');

    if (!yes) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const typed = await rl.question(`Type ${code} to delete, or anything else to cancel: `);
      rl.close();
      if (normalizeCode(typed) !== code) {
        console.log('Cancelled. Nothing was deleted.');
        return 1;
      }
    }
    // the participant row cascades to every table above (migration 008); secure_delete overwrites the freed space,
    // VACUUM rewrites the file and the checkpoint empties the write-ahead log, so nothing can be read back
    db.pragma('secure_delete = ON');
    db.prepare('DELETE FROM participants WHERE id = ?').run(participant.id);
    db.exec('VACUUM');
    db.pragma('wal_checkpoint(TRUNCATE)');
    console.log(`Deleted ${code}.`);
    return 0;
  } finally {
    db.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
