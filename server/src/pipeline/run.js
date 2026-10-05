import { chunkLesson, DEFAULT_CHUNK_TOKENS } from '../ai/chunk.js';
import { HttpError } from '../middleware/errors.js';
import { getSetting } from '../services/settings.js';
import { generateKeyPoints, generateKeyTerms, generateSections } from './generate.js';
import { STAGES } from './jobs.js';

class LessonGone extends Error {}

const NO_TEXT = "This file has no readable text, so there's nothing to summarize. Try a text-based version of the lesson.";

const parseNumbers = (json) => {
  try {
    const numbers = JSON.parse(json);
    return Array.isArray(numbers) ? numbers : null;
  } catch {
    return null;
  }
};

const count = (db, table, lessonId) => db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE lesson_id = ?`).get(lessonId).c;

// Generates sections, key points and key terms for a lesson and saves them. A stage whose output is already saved
// is skipped, so retrying a failed lesson continues where it stopped. Never throws: the outcome is written to the
// job and lesson rows. `ai` is { generateJSON }.
// `concurrency` parallel AI calls within a stage; `keyTermsMax` caps the key terms kept per lesson.
export async function runPipeline({ db, ai, lessonId, chunkTokens = DEFAULT_CHUNK_TOKENS, concurrency = 1, keyTermsMax = 12, log = console }) {
  const lesson = db.prepare('SELECT id, raw_text, source_kind, source_numbers, source_total FROM lessons WHERE id = ?').get(lessonId);
  if (!lesson) return;
  const jobId = db.prepare('SELECT id FROM jobs WHERE lesson_id = ? ORDER BY id DESC LIMIT 1').get(lessonId)?.id;
  if (!jobId) return;

  // A deleted lesson cascades away its job row; stop quietly instead of writing to nothing.
  const updateJob = (fields) => {
    const cols = Object.keys(fields);
    const sql = `UPDATE jobs SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = @id`;
    if (!db.prepare(sql).run({ ...fields, id: jobId }).changes) throw new LessonGone();
  };
  const progress = ({ done, total }) => updateJob({ progress_done: done, progress_total: total });
  const begin = (stage) => updateJob({ stage, status: 'running', progress_done: 0, progress_total: 0 });

  const stages = {
    sections: {
      saved: () => count(db, 'sections', lessonId) > 0,
      async run(chunks) {
        const summaryLength = getSetting(db, 'summary_length') === 'short' ? 'short' : 'detailed';
        const onDrop = ({ title, dropped }) =>
          log.info?.(`[pipeline] lesson ${lessonId}: section "${title}" named sources that don't exist or weren't in its text; ignored: ${dropped.join(', ')}`);
        const sections = await generateSections({
          ai,
          chunks,
          sourceKind: lesson.source_kind ?? undefined,
          sourceTotal: lesson.source_total ?? undefined,
          summaryLength,
          concurrency,
          onProgress: progress,
          onDrop,
        });
        const insert = db.prepare(
          'INSERT INTO sections (lesson_id, position, title, content, check_questions, sources) VALUES (?, ?, ?, ?, ?, ?)',
        );
        db.transaction(() => {
          sections.forEach((s, i) =>
            insert.run(lessonId, i + 1, s.title, s.content, JSON.stringify(s.check_questions), s.sources ? JSON.stringify(s.sources) : null),
          );
        })();
      },
    },
    key_points: {
      saved: () => count(db, 'key_points', lessonId) > 0,
      async run() {
        const sections = db.prepare('SELECT title, content FROM sections WHERE lesson_id = ? ORDER BY position').all(lessonId);
        const points = await generateKeyPoints({ ai, sections, chunkTokens, concurrency, onProgress: progress });
        const insert = db.prepare('INSERT INTO key_points (lesson_id, position, text) VALUES (?, ?, ?)');
        db.transaction(() => points.forEach((p, i) => insert.run(lessonId, i + 1, p)))();
      },
    },
    key_terms: {
      // A lesson may legitimately define no terms; that stage re-runs on retry, which is cheap.
      saved: () => count(db, 'key_terms', lessonId) > 0,
      async run(chunks) {
        const onDrop = ({ term, reason }) => log.info?.(`[pipeline] lesson ${lessonId}: dropped key term "${term}" (${reason})`);
        const onMerge = ({ before, after, fallback }) =>
          log.info?.(
            `[pipeline] lesson ${lessonId}: key terms before the merge (${before.length}): ${before.join('; ')}\n` +
              `[pipeline] lesson ${lessonId}: key terms after the merge (${after.length}${fallback ? ', merge reply unusable so all candidates kept' : ''}): ${after.join('; ')}`,
          );
        const terms = await generateKeyTerms({ ai, chunks, maxTerms: keyTermsMax, concurrency, onProgress: progress, onDrop, onMerge });
        const insert = db.prepare('INSERT INTO key_terms (lesson_id, term, definition, evidence) VALUES (?, ?, ?, ?)');
        db.transaction(() => terms.forEach((t) => insert.run(lessonId, t.term, t.definition, t.evidence)))();
      },
    },
  };

  let stage = STAGES[0];
  try {
    // Numbers are only used when there is one per block; otherwise the lesson is chunked without source labels.
    const numbers = parseNumbers(lesson.source_numbers);
    const chunks = chunkLesson(lesson.raw_text, { maxTokens: chunkTokens, numbers: numbers ?? undefined });
    if (!chunks.length) throw new HttpError(422, NO_TEXT);
    for (stage of STAGES) {
      if (stages[stage].saved()) continue;
      begin(stage);
      await stages[stage].run(chunks);
    }
    updateJob({ stage: 'done', status: 'done' });
    db.prepare(`UPDATE lessons SET status = 'ready', error = NULL, error_hint = NULL WHERE id = ?`).run(lessonId);
  } catch (err) {
    if (err instanceof LessonGone) return;
    // Our own errors (AiError, HttpError) carry a message meant for the user; anything else is a bug: log it, hide it.
    const message = err instanceof HttpError ? err.message : 'Something went wrong while processing this lesson. Retry, and report it if it keeps happening.';
    const hint = (err instanceof HttpError && err.extra?.hint) || null;
    if (!(err instanceof HttpError)) log.error(`[pipeline] lesson ${lessonId} failed in ${stage}:`, err);
    try {
      updateJob({ stage, status: 'failed', error: message, error_hint: hint });
      db.prepare(`UPDATE lessons SET status = 'failed', error = ?, error_hint = ? WHERE id = ?`).run(message, hint, lessonId);
    } catch (inner) {
      if (!(inner instanceof LessonGone)) throw inner;
    }
  }
}
