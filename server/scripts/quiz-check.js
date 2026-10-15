// Checks a study database for flashcards and quiz questions that give their answer away (src/quiz/leaks.js), with
// the same code the quiz uses, and prints per lesson what the quiz skips and how many clean questions it can ask.
// No AI call, no key; the database is opened read-only, so it is safe beside a running server.
//   npm run quiz:check                              every lesson in the study database (DB_PATH in .env)
//   npm run quiz:check -- --lesson 3                one lesson
//   npm run quiz:check -- --db D:\copy\studyrevr.db another database (a relative path is from where you typed it)
// Before the study, check the line "Clean questions available: 10 of 10" for the study lesson.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config.js';
import { formatReport, lessonLeakReport } from '../src/quiz/check.js';

const USAGE = 'Usage: npm run quiz:check -- [--db <database file>] [--lesson <lesson id>]';

// -> { code, out, err }: the exit code and what to print
export function quizCheck(args, { cwd = process.cwd(), dbPath: fallback } = {}) {
  const value = (flag) => {
    const i = args.indexOf(flag);
    return i < 0 ? undefined : args[i + 1];
  };
  const unknown = args.filter((a, i) => a.startsWith('--') ? !['--db', '--lesson'].includes(a) : !['--db', '--lesson'].includes(args[i - 1]));
  const lessonArg = value('--lesson');
  if (unknown.length || (args.includes('--db') && !value('--db')) || (args.includes('--lesson') && !/^\d+$/.test(lessonArg ?? ''))) return { code: 2, err: USAGE };

  const given = value('--db');
  const file = given ? path.resolve(cwd, given) : fallback;
  if (!file || file === ':memory:') return { code: 2, err: `No database file to check. ${USAGE}` };
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
  } catch (e) {
    return { code: 1, err: `Couldn't open ${file}: ${e.message}` };
  }
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
    if (!['lessons', 'flashcards', 'key_terms', 'quiz_distractors'].every((t) => tables.has(t)))
      return { code: 1, err: `${file} isn't a StudyRevr database, or is from before the Mock Quiz (start the app once to update it).` };
    const ids = lessonArg ? [Number(lessonArg)] : db.prepare('SELECT id FROM lessons ORDER BY created_at, id').all().map((l) => l.id);
    if (!ids.length) return { code: 0, out: `${file}: no lessons yet.` };
    const reports = ids.map((id) => lessonLeakReport(db, id));
    if (reports.some((r) => !r)) return { code: 1, err: `Lesson ${lessonArg} isn't in ${file}.` };
    return { code: 0, out: [`Quiz and flashcard check of ${file}`, '', ...reports.map((r) => `${formatReport(r)}\n`)].join('\n') };
  } finally {
    db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  // npm runs this inside server/; a relative path means where you typed the command
  const { code, out, err } = quizCheck(process.argv.slice(2), { cwd: process.env.INIT_CWD ?? process.cwd(), dbPath: loadConfig().dbPath });
  if (out) console.log(out);
  if (err) console.error(err);
  process.exitCode = code;
}
