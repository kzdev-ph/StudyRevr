import { chunkLesson, DEFAULT_CHUNK_TOKENS } from '../ai/chunk.js';
import { HttpError } from '../middleware/errors.js';
import { flashcardsMax } from '../flashcards/config.js';
import { getSetting } from '../services/settings.js';
import { generateFlashcards } from './flashcards.js';
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

// Generates sections, key points, key terms and flashcards for a lesson and saves them, starting at the job's stage.
// A stage whose output is already saved is skipped, so retrying a failed lesson continues where it stopped. Never
// throws: the outcome is written to the job and lesson rows. A lesson that was already ready (flashcards made later
// for an older lesson) stays ready even if this run fails; only its job records the failure. `ai` is { generateJSON }.
// `concurrency` parallel AI calls within a stage; `keyTermsMax` caps the key terms kept per lesson. `onStage({ stage,
// event })` is told when each stage starts and ends ('start' | 'end'), e.g. for a timeline in the pipeline script.
export async function runPipeline({ db, ai, lessonId, chunkTokens = DEFAULT_CHUNK_TOKENS, concurrency = 1, keyTermsMax = 12, log = console, onStage = () => {} }) {
  const lesson = db.prepare('SELECT id, raw_text, word_count, status, source_kind, source_numbers, source_total FROM lessons WHERE id = ?').get(lessonId);
  if (!lesson) return;
  const job = db.prepare('SELECT id, stage FROM jobs WHERE lesson_id = ? ORDER BY id DESC LIMIT 1').get(lessonId);
  if (!job) return;
  const jobId = job.id;
  const wasReady = lesson.status === 'ready';

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
    flashcards: {
      // Like key terms, a lesson can end up with no cards; asking again is then allowed.
      saved: () => count(db, 'flashcards', lessonId) > 0,
      async run(chunks) {
        const keyTerms = db.prepare('SELECT term, definition, evidence FROM key_terms WHERE lesson_id = ? ORDER BY id').all(lessonId);
        const sections = db
          .prepare('SELECT title, content, sources FROM sections WHERE lesson_id = ? ORDER BY position')
          .all(lessonId)
          .map((s) => ({ ...s, sources: s.sources ? JSON.parse(s.sources) : null }));
        const onDrop = ({ front, reason }) => log.info?.(`[pipeline] lesson ${lessonId}: dropped flashcard "${front}" (${reason})`);
        const cards = await generateFlashcards({
          ai,
          chunks,
          lessonText: lesson.raw_text,
          keyTerms,
          sections,
          wordCount: lesson.word_count,
          maxCards: flashcardsMax(db),
          concurrency,
          onProgress: progress,
          onDrop,
        });
        const insert = db.prepare('INSERT INTO flashcards (lesson_id, kind, front, back, evidence, position) VALUES (?, ?, ?, ?, ?, ?)');
        db.transaction(() => cards.forEach((c, i) => insert.run(lessonId, c.kind, c.front, c.back, c.evidence, i + 1)))();
        log.info?.(`[pipeline] lesson ${lessonId}: saved ${cards.length} flashcards`);
      },
    },
  };

  let stage = STAGES[0];
  try {
    // Numbers are only used when there is one per block; otherwise the lesson is chunked without source labels.
    const numbers = parseNumbers(lesson.source_numbers);
    const chunks = chunkLesson(lesson.raw_text, { maxTokens: chunkTokens, numbers: numbers ?? undefined });
    if (!chunks.length) throw new HttpError(422, NO_TEXT);
    for (stage of STAGES.slice(Math.max(0, STAGES.indexOf(job.stage)))) {
      if (stages[stage].saved()) continue;
      begin(stage);
      onStage({ stage, event: 'start' });
      await stages[stage].run(chunks);
      onStage({ stage, event: 'end' });
    }
    updateJob({ stage: 'done', status: 'done' });
    db.prepare(`UPDATE lessons SET status = 'ready', error = NULL WHERE id = ?`).run(lessonId);
  } catch (err) {
    if (err instanceof LessonGone) return;
    // Our own errors (AiError, HttpError) carry a message meant for the user; anything else is a bug: log it, hide it.
    const message = err instanceof HttpError ? err.message : 'Something went wrong while processing this lesson. Retry, and report it if it keeps happening.';
    if (!(err instanceof HttpError)) log.error(`[pipeline] lesson ${lessonId} failed in ${stage}:`, err);
    try {
      updateJob({ stage, status: 'failed', error: message });
      if (!wasReady) db.prepare(`UPDATE lessons SET status = 'failed', error = ? WHERE id = ?`).run(message, lessonId);
    } catch (inner) {
      if (!(inner instanceof LessonGone)) throw inner;
    }
  }
}
