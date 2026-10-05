// Runs the lesson pipeline (extract -> sections -> key points -> key terms) on one file against your real AI provider
// and prints what it generated, so you can judge quality. Uses a throw-away in-memory database.
//
//   npm run pipeline -- <file> [--summary=short|detailed] [--chunk-tokens=N]
//
// <file> is a path, or a (partial, case-insensitive) name of a file in test-lessons/. With no file it lists them.
// Provider settings come from .env (AI_BASE_URL, AI_API_KEY, AI_MODEL); the key is never printed.
import fs from 'node:fs';
import path from 'node:path';
import { createAiClient } from '../src/ai/client.js';
import { chunkLesson, DEFAULT_CHUNK_TOKENS } from '../src/ai/chunk.js';
import { loadConfig, ROOT_DIR } from '../src/config.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { assertSignature, fileExtension } from '../src/middleware/upload.js';
import { getJobStatus, queueJob } from '../src/pipeline/jobs.js';
import { runPipeline } from '../src/pipeline/run.js';
import { extractText } from '../src/services/extract.js';
import { resolveAiConfig } from '../src/services/settings.js';

const LESSONS_DIR = path.join(ROOT_DIR, 'test-lessons');
const SUPPORTED = new Set(['.docx', '.pptx', '.pdf']);

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const target = args.find((a) => !a.startsWith('--'));

const available = () => (fs.existsSync(LESSONS_DIR) ? fs.readdirSync(LESSONS_DIR).filter((f) => SUPPORTED.has(path.extname(f).toLowerCase())) : []);

function findFile(name) {
  if (fs.existsSync(name) && fs.statSync(name).isFile()) return path.resolve(name);
  const exact = path.join(LESSONS_DIR, name);
  if (fs.existsSync(exact)) return exact;
  const matches = available().filter((f) => f.toLowerCase().includes(name.toLowerCase()));
  if (matches.length === 1) return path.join(LESSONS_DIR, matches[0]);
  if (matches.length > 1) fail(`"${name}" matches more than one file:\n  ${matches.join('\n  ')}`);
  return fail(`No file "${name}" (looked in ${LESSONS_DIR}).`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!target) {
  const files = available();
  fail(`Usage: npm run pipeline -- <file> [--summary=short|detailed] [--chunk-tokens=N]\n\nFiles in test-lessons/:\n${files.map((f) => `  ${f}`).join('\n') || '  (none)'}`);
}

const file = findFile(target);
const ext = fileExtension(file);
if (!SUPPORTED.has(ext)) fail(`Unsupported file type "${ext}". Use .docx, .pptx or .pdf.`);

const config = loadConfig();
const chunkTokens = Number(flag('chunk-tokens')) || config.ai.chunkTokens || DEFAULT_CHUNK_TOKENS;
if (!config.ai.baseUrl || !config.ai.model) fail('Set AI_BASE_URL, AI_API_KEY and AI_MODEL in .env first.');

const db = openDb(':memory:');
runMigrations(db);
if (flag('summary')) db.prepare("UPDATE settings SET value = ? WHERE key = 'summary_length'").run(flag('summary') === 'short' ? 'short' : 'detailed');

const buffer = fs.readFileSync(file);
assertSignature(buffer, ext);
const { text, wordCount, pageCount } = await extractText(buffer, ext);
const chunks = chunkLesson(text, { maxTokens: chunkTokens });

console.log(`# ${path.basename(file)}`);
console.log(`Provider: ${config.ai.baseUrl}  Model: ${config.ai.model}`);
console.log(`Extracted ${wordCount} words${pageCount ? ` from ${pageCount} pages` : ''}; ${chunks.length} chunk(s) of ~${chunks.map((c) => c.tokens).join(', ')} tokens (budget ${chunkTokens}).`);

const lessonId = Number(
  db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status) VALUES (?, ?, ?, ?, 'processing')").run(path.basename(file, ext), path.basename(file), text, wordCount).lastInsertRowid,
);
queueJob(db, lessonId);

const client = createAiClient({ getConfig: () => resolveAiConfig(db, config.ai), timeoutMs: config.ai.timeoutMs });
const timed = {
  async generateJSON(request) {
    const started = Date.now();
    try {
      const out = await client.generateJSON(request);
      console.error(`  ok   ${request.label} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      return out;
    } catch (err) {
      console.error(`  FAIL ${request.label} (${((Date.now() - started) / 1000).toFixed(1)}s): ${err.message}`);
      throw err;
    }
  },
};

const started = Date.now();
console.error('Running pipeline...');
await runPipeline({ db, ai: timed, lessonId, chunkTokens });
const seconds = ((Date.now() - started) / 1000).toFixed(1);

const { lesson, job } = getJobStatus(db, lessonId);
if (lesson.status !== 'ready') {
  console.log(`\nPipeline FAILED in stage "${job.stage}": ${lesson.error}`);
  process.exit(1);
}

const sections = db.prepare('SELECT * FROM sections WHERE lesson_id = ? ORDER BY position').all(lessonId);
console.log(`\n## Sections (${sections.length})`);
for (const s of sections) {
  console.log(`\n### ${s.position}. ${s.title}\n${s.content}`);
  for (const q of JSON.parse(s.check_questions)) console.log(`  ? ${q.question}\n    -> ${q.answer}`);
}

const points = db.prepare('SELECT text FROM key_points WHERE lesson_id = ? ORDER BY position').all(lessonId);
console.log(`\n## Key points (${points.length})`);
for (const p of points) console.log(`- ${p.text}`);

const terms = db.prepare('SELECT term, definition FROM key_terms WHERE lesson_id = ? ORDER BY id').all(lessonId);
console.log(`\n## Key terms (${terms.length})`);
for (const t of terms) console.log(`- ${t.term}: ${t.definition}`);

const { calls, promptTokens, completionTokens } = client.stats;
console.log(`\nDone in ${seconds}s: ${calls} AI call(s), ${promptTokens} prompt + ${completionTokens} completion tokens.`);
