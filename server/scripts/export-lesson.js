// Starts or continues writing a lesson outside the app (Claude Code instead of the Default AI), through the same
// pipeline and checks.
//
//   npm run lesson:export -- <lesson id> <folder>
//
// The first run writes the lesson (lesson.json, raw_text.txt, blocks.json), INSTRUCTIONS.md and the prompts that can be
// asked now (prompts/*.md with the JSON shape each reply must have). Write one JSON file per prompt into replies/, then
// run it again: the replies go through the real pipeline (schemas, evidence quotes, leak rules...) and the prompts that
// depended on them appear, until it says COMPLETE. Then `npm run lesson:import -- <folder> [--as-new]`.
// Safe beside a running server: the database is only read, and only the first run reads it.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config.js';
import { describe, ExchangeRefused, exportRound, lessonMeta, loadExchange } from '../src/services/claude-exchange.js';
import { resolveAiConfig } from '../src/services/settings.js';

function main(args) {
  const [given, where] = args.filter((a) => !a.startsWith('--'));
  const id = Number(given);
  if (!given || !where || !Number.isInteger(id) || id <= 0) {
    console.error('Usage: npm run lesson:export -- <lesson id> <folder>');
    return Promise.resolve(2);
  }
  // a relative folder is from where you typed the command (npm runs scripts from server/)
  const folder = path.resolve(process.env.INIT_CWD ?? process.cwd(), where);
  return (async () => {
    try {
      let meta;
      if (fs.existsSync(path.join(folder, 'lesson.json'))) {
        meta = loadExchange(folder).meta;
        if (meta.lesson_id !== id) throw new ExchangeRefused(`${folder} is the export of lesson ${meta.lesson_id}, not lesson ${id}.`);
      } else {
        const config = loadConfig();
        if (config.dbPath === ':memory:') throw new ExchangeRefused('DB_PATH is :memory:, so there is no database to export a lesson from.');
        const db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
        try {
          const provider = resolveAiConfig(db, config.ai);
          meta = lessonMeta(db, id, { chunkTokens: provider.chunkTokens, keyTermsMax: provider.keyTermsMax });
        } finally {
          db.close();
        }
      }
      const result = await exportRound({ folder, meta });
      console.log(`Lesson ${id}: ${meta.title}\nFolder: ${folder}\n`);
      console.log(describe(result, folder));
      return result.status === 'failed' ? 1 : 0;
    } catch (err) {
      if (!(err instanceof ExchangeRefused)) throw err;
      console.error(err.message);
      return 1;
    }
  })();
}

process.exitCode = await main(process.argv.slice(2));
