// Writes a lesson made outside the app (see lesson:export) into the database, through the same pipeline and checks.
//
//   npm run lesson:import -- <folder> [--as-new] [--yes]
//
// --as-new makes a separate lesson (a teacher's lesson, titled "<title> (Claude)") next to the original. Without it the
// exported lesson is made again in place under the rules of `lesson:rebuild`: refused when a participant other than P00
// has records on it, and you type the lesson id to go on (--yes skips that). Refuses while the server runs, and when any
// reply is missing, stale or unusable. Nothing is written unless the whole lesson passes (one transaction).
import path from 'node:path';
import readline from 'node:readline/promises';
import { loadConfig } from '../src/config.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { ExchangeRefused, importExchange, loadExchange } from '../src/services/claude-exchange.js';
import { confirmed, RebuildRefused } from '../src/services/rebuild-lesson.js';
import { serverBlock } from '../src/services/server-check.js';

async function main(args) {
  const where = args.find((a) => !a.startsWith('--'));
  const asNew = args.includes('--as-new');
  if (!where) {
    console.error('Usage: npm run lesson:import -- <folder> [--as-new] [--yes]');
    return 2;
  }
  const folder = path.resolve(process.env.INIT_CWD ?? process.cwd(), where);
  const config = loadConfig();
  if (config.dbPath === ':memory:') {
    console.error('DB_PATH is :memory:, so there is no database file to import a lesson into.');
    return 1;
  }
  const blocked = await serverBlock(config);
  if (blocked) {
    console.error(blocked);
    return 1;
  }
  const db = openDb(config.dbPath);
  runMigrations(db);
  try {
    const { meta } = loadExchange(folder);
    if (!asNew && !args.includes('--yes')) {
      console.log(`Replaces lesson ${meta.lesson_id} (${meta.title}): its sections, key points, key terms, flashcards, quiz answers and P00's test records are deleted and written from ${folder}.`);
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const typed = await rl.question(`Type the lesson id (${meta.lesson_id}) to continue, or anything else to cancel: `);
      rl.close();
      if (!confirmed(typed, meta.lesson_id)) {
        console.log('Cancelled. Nothing was changed.');
        return 1;
      }
    }
    const done = await importExchange({ db, folder, asNew });
    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM sections WHERE lesson_id = @id) AS sections, (SELECT COUNT(*) FROM key_points WHERE lesson_id = @id) AS key_points,
                (SELECT COUNT(*) FROM key_terms WHERE lesson_id = @id) AS key_terms, (SELECT COUNT(*) FROM flashcards WHERE lesson_id = @id) AS cards`,
      )
      .get({ id: done.lessonId });
    if (done.log.length) console.log(`What the checks did (items dropped or asked for again):\n${done.log.map((l) => `  ${l}`).join('\n')}\n`);
    console.log(
      `Lesson ${done.lessonId} ${done.asNew ? 'made' : 'replaced'}: ${counts.sections} sections, ${counts.key_points} key points, ${counts.key_terms} key terms, ${counts.cards} flashcards (${done.calls} replies used, written by Claude, made_by claude-haiku).`,
    );
    return 0;
  } catch (err) {
    if (!(err instanceof ExchangeRefused || err instanceof RebuildRefused)) throw err;
    console.error(err.message);
    return 1;
  } finally {
    db.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
