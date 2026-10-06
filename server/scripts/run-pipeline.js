// Runs the lesson pipeline (extract -> sections -> key points -> key terms -> flashcards) on one file against your real AI provider
// and prints what it generated, so you can judge quality. Uses a throw-away in-memory database.
//
//   npm run pipeline -- <file> [--summary=short|detailed] [--chunk-tokens=N] [--concurrency=N]
//
// <file> is a path, or a (partial, case-insensitive) name of a file in test-lessons/. With no file it lists them.
// The provider comes from .env: AI_PROVIDER (default google) plus its key (GOOGLE_API_KEY, NVIDIA_API_KEY,
// OPENROUTER_API_KEY), and optionally AI_MODEL, AI_CONCURRENCY, AI_CHUNK_TOKENS, AI_EXTRA_BODY. The key is never printed.
import fs from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createAiClient, describeAttempt } from '../src/ai/client.js';
import { chunkLesson } from '../src/ai/chunk.js';
import { installNetLog } from '../src/ai/netlog.js';
import { loadConfig, ROOT_DIR } from '../src/config.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { assertSignature, fileExtension } from '../src/middleware/upload.js';
import { getJobStatus, queueJob } from '../src/pipeline/jobs.js';
import { runPipeline } from '../src/pipeline/run.js';
import { extractText } from '../src/services/extract.js';
import { resolveAiConfig } from '../src/services/settings.js';

const LESSONS_DIR = path.join(ROOT_DIR, 'test-lessons');
const SUPPORTED = new Set(['.docx', '.pptx', '.pdf']);
const USAGE = 'Usage: npm run pipeline -- <file> [--summary=short|detailed] [--chunk-tokens=N] [--concurrency=N]';

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
  fail(`${USAGE}\n\nFiles in test-lessons/:\n${files.map((f) => `  ${f}`).join('\n') || '  (none)'}`);
}

const file = findFile(target);
const ext = fileExtension(file);
if (!SUPPORTED.has(ext)) fail(`Unsupported file type "${ext}". Use .docx, .pptx or .pdf.`);

const config = loadConfig();
const db = openDb(':memory:');
runMigrations(db);
const provider = resolveAiConfig(db, config.ai);
if (provider.needsKey && !provider.apiKey) fail(`No API key for ${provider.label}. Add ${provider.keyEnv} to .env first.`);
if (!provider.baseUrl || !provider.model) fail('Set AI_PROVIDER (and AI_BASE_URL / AI_MODEL for a custom provider) in .env first.');
const chunkTokens = Number(flag('chunk-tokens')) || provider.chunkTokens;
const concurrency = Number(flag('concurrency')) || provider.concurrency;
if (flag('summary')) db.prepare("UPDATE settings SET value = ? WHERE key = 'summary_length'").run(flag('summary') === 'short' ? 'short' : 'detailed');

const buffer = fs.readFileSync(file);
assertSignature(buffer, ext);
const { text, wordCount, pageCount } = await extractText(buffer, ext);
const chunks = chunkLesson(text, { maxTokens: chunkTokens });

console.log(`# ${path.basename(file)}`);
console.log(`Provider: ${provider.label} (${provider.baseUrl})  Model: ${provider.model}  Concurrency: ${concurrency}  Temperature: ${provider.temperature}`);
console.log(`Request timeout: ${provider.timeoutMs / 1000}s  Request limit: ${provider.requestsPerMinute ? `${provider.requestsPerMinute}/min` : 'none'}`);
console.log(`Extracted ${wordCount} words${pageCount ? ` from ${pageCount} pages` : ''}; ${chunks.length} chunk(s) of ~${chunks.map((c) => c.tokens).join(', ')} tokens (budget ${chunkTokens}).`);

const lessonId = Number(
  db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status) VALUES (?, ?, ?, ?, 'processing')").run(path.basename(file, ext), path.basename(file), text, wordCount).lastInsertRowid,
);
queueJob(db, lessonId);

const started = Date.now();
const secondsSince = (t) => ((Date.now() - t) / 1000).toFixed(1);
const stamp = (line) => console.error(`  [+${secondsSince(started)}s] ${line}`);

// Every HTTP request the process makes, from any code, not only the AI client's (installed before the client is made,
// since the client keeps the fetch it was created with). The totals are compared with the client's own count below.
const net = installNetLog({ log: stamp });

// Work that blocks the event loop (a slow regex, a huge loop) delays everything without any request. Report stalls.
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
let lastTick = Date.now();
setInterval(() => {
  const late = Date.now() - lastTick - 1000;
  if (late > 2000) stamp(`[loop] the event loop was blocked for ${(late / 1000).toFixed(1)}s`);
  lastTick = Date.now();
}, 1000).unref();

const client = createAiClient({
  getConfig: () => resolveAiConfig(db, config.ai),
  // every HTTP attempt, as it happens: a hung request shows as a "start" with no end until its timeout
  onAttempt: (e) => stamp(describeAttempt(e)),
});
const callTimes = [];
const timed = {
  async generateJSON(request) {
    const callStart = Date.now();
    const jsonRetriesBefore = client.stats.jsonRetries;
    const startedAt = `started +${((callStart - started) / 1000).toFixed(1)}s`;
    const tag = () => `${startedAt}${client.stats.jsonRetries > jsonRetriesBefore ? ', JSON retry' : ''}`;
    try {
      const out = await client.generateJSON(request);
      callTimes.push(Date.now() - callStart);
      console.error(`  ok   ${request.label} (${secondsSince(callStart)}s; ${tag()})`);
      return out;
    } catch (err) {
      console.error(`  FAIL ${request.label} (${secondsSince(callStart)}s; ${tag()}): ${err.message}`);
      throw err;
    }
  },
};

console.error('Running pipeline...');
const onStage = ({ stage, event }) => console.error(`[${event === 'start' ? 'start' : 'end  '} +${secondsSince(started)}s] ${stage}`);
const log = { info: stamp, warn: stamp, error: (...args) => console.error(...args) };
await runPipeline({ db, ai: timed, lessonId, chunkTokens, concurrency, keyTermsMax: provider.keyTermsMax, onStage, log });
loopDelay.disable();
const seconds = secondsSince(started);

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

const terms = db.prepare('SELECT term, definition, evidence FROM key_terms WHERE lesson_id = ? ORDER BY id').all(lessonId);
console.log(`\n## Key terms (${terms.length})`);
for (const t of terms) console.log(`- ${t.term}: ${t.definition}\n    evidence: "${t.evidence}"`);

const cards = db.prepare('SELECT kind, front, back, evidence FROM flashcards WHERE lesson_id = ? ORDER BY position').all(lessonId);
console.log(`\n## Flashcards (${cards.length})`);
for (const c of cards) console.log(`- [${c.kind}] ${c.front}\n    -> ${c.back}\n    evidence: "${c.evidence}"`);

// Per-call times add up to more than the wall-clock time when calls overlap; the wall-clock time is what you wait.
const { calls, promptTokens, completionTokens, jsonRetries, httpRetries, truncated, schemaSent, schemaRejected, attempts, failedAttempts, retries, throttledMs } = client.stats;
const byReason = (counts) => Object.entries(counts).map(([reason, n]) => `${n} ${reason}`).join(', ') || 'none';
const avg = callTimes.length ? (callTimes.reduce((a, b) => a + b, 0) / callTimes.length / 1000).toFixed(1) : '0.0';
console.log(`\nDone in ${seconds}s: ${calls} AI call(s) (avg ${avg}s each), ${promptTokens} prompt + ${completionTokens} completion tokens.`);
console.log(`HTTP attempts: ${attempts}; failed: ${byReason(failedAttempts)}; retried: ${byReason(retries)} (${httpRetries} in all).`);
console.log(`Retries: ${jsonRetries} invalid-JSON, ${httpRetries} timeout/rate-limit/server/network, ${truncated} cut-off replies.`);
console.log(`Waited ${(throttledMs / 1000).toFixed(1)}s in all for the client-side request limit.`);
const hosts = Object.entries(net.stats.byHost).map(([host, n]) => `${n} to ${host}`).join(', ') || 'none';
console.log(`HTTP requests made by this process (any code): ${net.stats.requests} (${hosts}), ${net.stats.failed} without a reply.`);
if (net.stats.requests !== attempts) console.log(`  MISMATCH: the AI client counted ${attempts} attempt(s); some requests bypassed it.`);
console.log(`Event loop: longest stall ${(loopDelay.max / 1e9).toFixed(2)}s.`);
console.log(`Structured output (response_format json_schema): sent on ${schemaSent} request(s), rejected by the provider on ${schemaRejected}.`);
