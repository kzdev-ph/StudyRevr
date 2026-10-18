// Makes a lesson again from its stored text with the current prompts and checks, keeping the lesson itself (same id,
// title, origin, owner, sharing and source numbers). Its sections, key points, key terms, flashcards, quiz answers and
// reviews are deleted and generated anew with the admin Default AI, together with P00's test records on it.
//
//   npm run lesson:rebuild -- <lesson id>
//
// Refuses while the server runs, when a participant other than P00 has recorded anything on the lesson, and unless you
// type the lesson's id. The original file is not stored, so the text it is made from is the lesson's `raw_text`.
import readline from 'node:readline/promises';
import { createAiClient, describeAttempt } from '../src/ai/client.js';
import { loadConfig } from '../src/config.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { getJobStatus, queueJob } from '../src/pipeline/jobs.js';
import { runPipeline } from '../src/pipeline/run.js';
import { pidFile, runningServerPid } from '../src/server-pid.js';
import { checkRebuild, confirmed, RebuildRefused, resetLesson } from '../src/services/rebuild-lesson.js';
import { resolveAiConfig } from '../src/services/settings.js';

// A StudyRevr server answering on the configured port (a server started from another folder has no pid file here).
async function serverAnswers(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main(args, { input = process.stdin, output = process.stdout } = {}) {
  const given = args.find((a) => !a.startsWith('--'));
  const id = Number(given);
  if (!given || !Number.isInteger(id) || id <= 0) {
    console.error('Usage: npm run lesson:rebuild -- <lesson id>');
    return 2;
  }
  const config = loadConfig();
  if (config.dbPath === ':memory:') {
    console.error('DB_PATH is :memory:, so there is no database file to rebuild a lesson in.');
    return 1;
  }
  const pid = runningServerPid(config.dbPath);
  if (pid || (await serverAnswers(config.port))) {
    console.error(`The StudyRevr server is running${pid ? ` (process ${pid})` : ` on port ${config.port}`}. Stop it first (Ctrl+C in its window), then run this again.`);
    if (pid) console.error(`If no server is running (it was closed without stopping, or the number belongs to another program), delete ${pidFile(config.dbPath)} and run this again.`);
    return 1;
  }

  const db = openDb(config.dbPath);
  runMigrations(db);
  try {
    const lesson = checkRebuild(db, id);
    const provider = resolveAiConfig(db, config.ai);
    if (provider.needsKey && !provider.apiKey) throw new RebuildRefused(`No API key for ${provider.label}. Add ${provider.keyEnv} to .env (or save one in Settings) first.`);
    if (!provider.baseUrl || !provider.model) throw new RebuildRefused('The Default AI has no model. Set it in Settings (or AI_PROVIDER / AI_MODEL in .env) first.');

    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM sections WHERE lesson_id = @id) AS sections, (SELECT COUNT(*) FROM flashcards WHERE lesson_id = @id) AS cards,
                (SELECT COUNT(*) FROM quiz_attempts WHERE lesson_id = @id) AS attempts`,
      )
      .get({ id });
    console.log(`Lesson ${lesson.id}: ${lesson.title} (${lesson.origin})`);
    console.log(`  Deletes ${counts.sections} sections, ${counts.cards} flashcards and ${counts.attempts} quiz attempts (P00's), then makes them again with ${provider.label} / ${provider.model}.`);
    console.log('  Title, owner, sharing and source numbers are kept. About 10-20 AI calls.');
    const rl = readline.createInterface({ input, output });
    const typed = await rl.question(`Type the lesson id (${id}) to continue, or anything else to cancel: `);
    rl.close();
    if (!confirmed(typed, id)) {
      console.log('Cancelled. Nothing was changed.');
      return 1;
    }

    resetLesson(db, id);
    queueJob(db, id);
    const started = Date.now();
    const stamp = (line) => console.error(`  [+${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`);
    const ai = createAiClient({ getConfig: () => resolveAiConfig(db, config.ai), onAttempt: (e) => stamp(describeAttempt(e)) });
    const onStage = ({ stage, event }) => console.error(`[${event === 'start' ? 'start' : 'end  '} +${((Date.now() - started) / 1000).toFixed(1)}s] ${stage}`);
    const log = { info: stamp, warn: stamp, error: (...a) => console.error(...a) };
    await runPipeline({
      db,
      ai,
      lessonId: id,
      chunkTokens: provider.chunkTokens,
      concurrency: provider.concurrency,
      keyTermsMax: provider.keyTermsMax,
      madeBy: { provider: provider.provider, model: provider.model },
      thinkingSupported: provider.reasoningEffort,
      onStage,
      log,
    });
    const { lesson: after, job } = getJobStatus(db, id);
    const cards = db.prepare('SELECT COUNT(*) AS n FROM flashcards WHERE lesson_id = ?').get(id).n;
    if (after.status !== 'ready') {
      console.error(`\nLesson ${id} failed in stage "${job.stage}": ${after.error}\nRun \`npm run lesson:rebuild -- ${id}\` again, or retry it from admin once the server runs.`);
      return 1;
    }
    const stageProblem = job.status === 'failed' ? ` (a late stage failed: ${job.stage}: ${job.error})` : '';
    console.log(`\nLesson ${id} is ready again: ${cards} flashcards, ${ai.stats.calls} AI calls${stageProblem}.`);
    return 0;
  } catch (err) {
    if (!(err instanceof RebuildRefused)) throw err;
    console.error(err.message);
    return 1;
  } finally {
    db.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
