import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createFileAi, promptHash } from '../ai/file-ai.js';
import { DEFAULT_CHUNK_TOKENS } from '../ai/chunk.js';
import { openDb, runMigrations } from '../db/index.js';
import { queueJob } from '../pipeline/jobs.js';
import { runPipeline } from '../pipeline/run.js';
import { checkRebuild, resetLesson } from './rebuild-lesson.js';
import { DEFAULT_KEY_TERMS_MAX } from './settings.js';

// A lesson written offline (Claude Code, Haiku agents) instead of by the Default AI, through exactly the same pipeline.
//
//   npm run lesson:export -- <id> <folder>     writes the lesson and the prompts that are waiting for an answer
//   (replies/<name>.json are written)          one JSON object per prompt, the shape in its prompt file
//   npm run lesson:export -- <id> <folder>     again: the replies are run through the real pipeline, and the prompts
//                                              that depend on them (key points need the sections, ...) appear
//   npm run lesson:import -- <folder> [--as-new]   when nothing is waiting: the same run on the real database
//
// Every round is the real `runPipeline` with a file-backed `ai` (ai/file-ai.js): the zod schemas, evidence quotes,
// leak rules, sibling shapes, rewording and objective checks, related terms and blank-option checks all apply, and a
// check that drops an item (or asks for a second try) shows up as a prompt or a line in the report. Nothing is
// written to the database until a run has every reply.

export const MADE_BY_CLAUDE = 'claude-haiku';
export const CLAUDE_MADE_BY = { provider: 'claude', model: 'haiku' };
const MANY = 64; // all of a stage's calls are issued at once, so every prompt a stage needs is seen in one round
const FORMAT = 1;

export class ExchangeRefused extends Error {}

const metaSchema = z.object({
  format: z.literal(FORMAT),
  lesson_id: z.number().int().positive(),
  title: z.string().min(1),
  filename: z.string().nullable(),
  raw_text: z.string().min(1),
  word_count: z.number().int().nonnegative(),
  source_kind: z.string().nullable(),
  source_numbers: z.string().nullable(),
  source_total: z.number().int().nullable(),
  summary_length: z.enum(['short', 'detailed']),
  flashcards_max: z.number().int().positive().nullable(),
  chunk_tokens: z.number().int().positive(),
  key_terms_max: z.number().int().positive(),
});

const paths = (folder) => ({
  meta: path.join(folder, 'lesson.json'),
  manifest: path.join(folder, 'manifest.json'),
  prompts: path.join(folder, 'prompts'),
  replies: path.join(folder, 'replies'),
  stale: path.join(folder, 'stale'),
});

// The lesson as the exchange folder keeps it, with what the prompts depend on (summary length, card cap, chunk size),
// so a later import makes the same prompts whatever the settings are by then.
export function lessonMeta(db, id, { chunkTokens = DEFAULT_CHUNK_TOKENS, keyTermsMax = DEFAULT_KEY_TERMS_MAX } = {}) {
  const l = db.prepare('SELECT id, title, filename, raw_text, word_count, source_kind, source_numbers, source_total FROM lessons WHERE id = ?').get(id);
  if (!l) throw new ExchangeRefused(`There is no lesson ${id}.`);
  const setting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value?.trim();
  const max = Math.floor(Number(setting('flashcards_max')));
  return {
    format: FORMAT,
    lesson_id: l.id,
    title: l.title,
    filename: l.filename,
    raw_text: l.raw_text,
    word_count: l.word_count,
    source_kind: l.source_kind,
    source_numbers: l.source_numbers,
    source_total: l.source_total,
    summary_length: setting('summary_length') === 'short' ? 'short' : 'detailed',
    flashcards_max: Number.isFinite(max) && max > 0 ? max : null,
    chunk_tokens: chunkTokens,
    key_terms_max: keyTermsMax,
  };
}

// What a folder holds: the lesson, the hash of every prompt that was exported, and a way to read replies.
export function loadExchange(folder) {
  const p = paths(folder);
  if (!fs.existsSync(p.meta)) throw new ExchangeRefused(`${folder} has no lesson.json. Run \`npm run lesson:export -- <lesson id> ${folder}\` first.`);
  let meta;
  try {
    meta = metaSchema.parse(JSON.parse(fs.readFileSync(p.meta, 'utf8')));
  } catch (err) {
    throw new ExchangeRefused(`${p.meta} is not a lesson export (${err.message}).`);
  }
  let hashes = {};
  try {
    hashes = JSON.parse(fs.readFileSync(p.manifest, 'utf8'));
  } catch {
    // no prompt was exported yet
  }
  const read = (name) => {
    try {
      return fs.readFileSync(path.join(p.replies, `${name}.json`), 'utf8');
    } catch {
      return null;
    }
  };
  return { meta, replies: { read, hashes }, paths: p };
}

// A throwaway database holding only this lesson, to run the pipeline on without touching the real one.
function scratchLesson(meta) {
  const db = openDb(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO lessons (id, title, filename, raw_text, word_count, status, source_kind, source_numbers, source_total, origin)
     VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, ?, 'admin')`,
  ).run(meta.lesson_id, meta.title, meta.filename, meta.raw_text, meta.word_count, meta.source_kind, meta.source_numbers, meta.source_total);
  applySettings(db, meta);
  queueJob(db, meta.lesson_id);
  return db;
}

// The two settings the pipeline reads for a lesson's prompts and card count come from the export, not the database.
function applySettings(db, meta) {
  const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  put.run('summary_length', meta.summary_length);
  if (meta.flashcards_max) put.run('flashcards_max', String(meta.flashcards_max));
}

// Runs the pipeline on `db`'s lesson with the replies in the folder. -> { status, ... }:
//   'complete'  every stage ran and the lesson is ready (the job is done)
//   'waiting'   some prompts have no usable reply: `pending` (missing or stale) and `invalid` (fails its schema)
//   'failed'    the pipeline stopped with an error of its own (`error`, `stage`)
// `log` lines are what the code checks dropped or changed on the way.
export async function runExchange({ db, meta, replies, lessonId = meta.lesson_id, log = [] }) {
  const ai = createFileAi({ replies });
  const lines = (line) => log.push(String(line));
  const logger = { info: lines, warn: lines, error: (...a) => lines(a.map(String).join(' ')) };
  const run = runPipeline({
    db,
    ai,
    lessonId,
    chunkTokens: meta.chunk_tokens,
    concurrency: MANY,
    keyTermsMax: meta.key_terms_max,
    madeBy: CLAUDE_MADE_BY,
    thinkingSupported: false,
    log: logger,
  }).then(() => 'done');
  const outcome = await Promise.race([run, ai.stalled]);
  ai.cancel();
  const report = ai.report();
  if (outcome === 'stalled') return { status: 'waiting', ...report, log, calls: ai.stats.calls };
  const lesson = db.prepare('SELECT status, error FROM lessons WHERE id = ?').get(lessonId);
  const job = db.prepare('SELECT stage, status, error FROM jobs WHERE lesson_id = ? ORDER BY id DESC LIMIT 1').get(lessonId);
  if (lesson?.status === 'ready' && job?.status === 'done') return { status: 'complete', ...report, log, calls: ai.stats.calls };
  return { status: 'failed', ...report, log, calls: ai.stats.calls, stage: job?.stage, error: job?.error ?? lesson?.error ?? 'The pipeline stopped.' };
}

// ---- export ---------------------------------------------------------------------------------------------------

const stringify = (value) => `${JSON.stringify(value, null, 2)}\n`;

// The JSON shape a prompt expects: the provider-side JSON Schema the pipeline already has, else one derived from the zod schema.
export function expectedShape(request) {
  if (request.responseSchema?.schema) return request.responseSchema.schema;
  try {
    return z.toJSONSchema(request.schema, { io: 'input', unrepresentable: 'any' });
  } catch {
    return null;
  }
}

const promptDoc = (r, shape) =>
  `# ${r.label}\n\nWrite your reply to: replies/${r.name}.json\n\n` +
  `Reply with ONE JSON object and nothing else (no prose, no code fence). Use only the lesson text in the user message.\n\n` +
  `## Expected shape (JSON Schema)\n\n\`\`\`json\n${shape ? JSON.stringify(shape, null, 2) : '(see the instructions in the prompt)'}\n\`\`\`\n\n` +
  `## System message\n\n${r.system}\n\n## User message\n\n${r.user}\n`;

const blocksOf = (meta) => {
  const numbers = (() => {
    try {
      const n = JSON.parse(meta.source_numbers ?? 'null');
      return Array.isArray(n) ? n : null;
    } catch {
      return null;
    }
  })();
  return meta.raw_text.split(/\n{2,}/).map((text, i) => ({ block: i + 1, [meta.source_kind ?? 'number']: numbers?.[i] ?? null, text }));
};

const INSTRUCTIONS = `# Lesson exchange

This folder is a lesson being written by someone other than the app's AI. The app checks everything you write with the
same schemas and code checks it uses for its own AI, so write to the lesson, not to the checks.

1. prompts/*.md are the prompts waiting for an answer, in the order of NEXT.txt. Each says where its reply goes
   (replies/<name>.json) and the JSON shape. Answer every one; an answer is one JSON object, nothing around it.
2. Run \`npm run lesson:export -- <lesson id> <this folder>\` again. It checks your replies like processing does and writes
   the prompts that were waiting on them (key points need the sections, flashcards need the key terms, the quiz options
   need the cards, and so on) or lists what was wrong with a reply (NEXT.txt).
3. Repeat until it says COMPLETE, then \`npm run lesson:import -- <this folder> --as-new\`.

Rules: the lesson text in raw_text.txt / blocks.json is the only source. An evidence quote must be copied word for word
from it. Replies are tied to the prompt they answer: when a reply you already wrote changes what a later prompt says,
the later reply moves to stale/ and is asked for again. Never edit lesson.json, manifest.json or the prompts.
`;

// One export round: runs the replies already in the folder, then writes every prompt that is waiting. -> the run result.
export async function exportRound({ folder, meta }) {
  const p = paths(folder);
  fs.mkdirSync(p.prompts, { recursive: true });
  fs.mkdirSync(p.replies, { recursive: true });
  if (!fs.existsSync(p.meta)) fs.writeFileSync(p.meta, stringify(meta));
  fs.writeFileSync(path.join(folder, 'raw_text.txt'), meta.raw_text);
  fs.writeFileSync(path.join(folder, 'blocks.json'), stringify(blocksOf(meta)));
  fs.writeFileSync(path.join(folder, 'INSTRUCTIONS.md'), INSTRUCTIONS);

  const { replies } = loadExchange(folder);
  const db = scratchLesson(meta);
  let result;
  try {
    result = await runExchange({ db, meta, replies });
  } finally {
    db.close();
  }
  for (const f of fs.readdirSync(p.prompts)) fs.rmSync(path.join(p.prompts, f));
  const hashes = { ...replies.hashes };
  result.pending.forEach((r, i) => {
    if (r.stale) {
      // a reply written for a prompt that changed: keep it for reference, out of the way
      fs.mkdirSync(p.stale, { recursive: true });
      fs.renameSync(path.join(p.replies, `${r.name}.json`), path.join(p.stale, `${r.name}.json`));
    }
    hashes[r.name] = r.hash;
    const shape = expectedShape(r);
    const file = `${String(i + 1).padStart(2, '0')}-${r.name}`;
    fs.writeFileSync(path.join(p.prompts, `${file}.md`), promptDoc(r, shape));
    fs.writeFileSync(path.join(p.prompts, `${file}.json`), stringify({ name: r.name, label: r.label, hash: r.hash, reply_file: `replies/${r.name}.json`, expects: shape, system: r.system, user: r.user }));
  });
  fs.writeFileSync(p.manifest, stringify(hashes));
  fs.writeFileSync(path.join(folder, 'NEXT.txt'), describe(result, folder));
  return result;
}

// The plain-words state of a run, for NEXT.txt and the command's output.
export function describe(result, folder = '<folder>') {
  const out = [];
  if (result.status === 'complete') {
    out.push('COMPLETE: every prompt has a reply and the lesson passes its checks.', `Next: npm run lesson:import -- ${folder} --as-new`);
  } else if (result.status === 'failed') {
    out.push(`STOPPED in ${result.stage ?? 'a stage'}: ${result.error}`);
  } else {
    if (result.invalid.length) {
      out.push('Fix these replies (they exist but are not usable):');
      for (const r of result.invalid) out.push(`  replies/${r.name}.json  (${r.label}): ${r.problem}`);
    }
    if (result.pending.length) {
      out.push(`Waiting for ${result.pending.length} ${result.pending.length === 1 ? 'reply' : 'replies'} (prompts/ has each prompt and the JSON shape):`);
      result.pending.forEach((r, i) => out.push(`  ${String(i + 1).padStart(2, '0')}  replies/${r.name}.json  (${r.label})${r.stale ? '  [asked again: the old reply was for an older prompt, moved to stale/]' : ''}`));
    }
  }
  if (result.log.length) {
    out.push('', 'What the checks did on the way (items dropped or asked for again):', ...result.log.map((l) => `  ${l}`));
  }
  return `${out.join('\n')}\n`;
}

// ---- import ---------------------------------------------------------------------------------------------------

// The lesson row an import makes with --as-new: the same text and source numbers, a teacher's lesson (origin admin).
function insertCopy(db, meta) {
  const id = Number(
    db
      .prepare(
        `INSERT INTO lessons (title, filename, raw_text, word_count, status, source_kind, source_numbers, source_total, origin)
         VALUES (?, ?, ?, ?, 'processing', ?, ?, ?, 'admin')`,
      )
      .run(`${meta.title} (Claude)`, meta.filename, meta.raw_text, meta.word_count, meta.source_kind, meta.source_numbers, meta.source_total).lastInsertRowid,
  );
  queueJob(db, id);
  return id;
}

// Writes the lesson from the folder. First a full run in a scratch database (nothing waiting, nothing failing), then the
// same run on `db` inside one transaction that is rolled back unless the lesson comes out ready, so a refused import
// leaves the database as it was. `asNew` makes a separate lesson (title + " (Claude)"); otherwise the lesson with the
// exchange's id is replaced under the same rules as `lesson:rebuild` (no participant other than P00 has records on it).
// -> { lessonId, asNew, calls, log }
export async function importExchange({ db, folder, asNew = false }) {
  const { meta, replies } = loadExchange(folder);
  const scratch = scratchLesson(meta);
  let dry;
  try {
    dry = await runExchange({ db: scratch, meta, replies });
  } finally {
    scratch.close();
  }
  if (dry.status !== 'complete') throw new ExchangeRefused(`The folder is not ready to import.\n${describe(dry, folder)}`);

  if (!asNew) {
    const lesson = checkRebuild(db, meta.lesson_id);
    if (db.prepare('SELECT raw_text FROM lessons WHERE id = ?').get(lesson.id).raw_text !== meta.raw_text) {
      throw new ExchangeRefused(`Lesson ${meta.lesson_id} has different text than the export was made from, so the replies don't belong to it. Export it again, or import with --as-new.`);
    }
  }
  const log = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    let lessonId;
    if (asNew) lessonId = insertCopy(db, meta);
    else {
      resetLesson(db, meta.lesson_id);
      queueJob(db, meta.lesson_id);
      lessonId = meta.lesson_id;
    }
    // the pipeline reads these two settings from the database: use the export's for the run, then put the real ones back
    const before = db.prepare("SELECT key, value FROM settings WHERE key IN ('summary_length', 'flashcards_max')").all();
    applySettings(db, meta);
    const result = await runExchange({ db, meta, replies, lessonId, log });
    db.prepare("DELETE FROM settings WHERE key IN ('summary_length', 'flashcards_max')").run();
    for (const row of before) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(row.key, row.value);
    if (result.status !== 'complete') throw new ExchangeRefused(`The import stopped, nothing was written.\n${describe(result, folder)}`);
    // not prepared with any thinking level: the author is what the lesson records
    db.prepare('UPDATE lessons SET made_by = ?, thinking_level = NULL WHERE id = ?').run(MADE_BY_CLAUDE, lessonId);
    db.exec('COMMIT');
    return { lessonId, asNew, calls: result.calls, log };
  } catch (err) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

export const hashOf = promptHash;
