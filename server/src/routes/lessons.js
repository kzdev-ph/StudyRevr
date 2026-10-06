import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/errors.js';
import { participantOf, requireParticipant } from '../middleware/participant.js';
import { assertSignature, createUpload, fileExtension } from '../middleware/upload.js';
import { extractText } from '../services/extract.js';
import { getJobStatus, queueJob } from '../pipeline/jobs.js';
import { parseFilipino, parseSimple } from '../services/section-versions.js';
import { getBoolSetting } from '../services/settings.js';

const SHORT_TEXT_WORDS = 150;
const SHORT_TEXT_WARNING =
  "Very little text was found in this file. Image-heavy slides can't be read, so the review may be thin. Try a text-based version.";

const SCANNED_PDF_WARNING = "This PDF looks scanned or image-only; text can't be extracted.";
const SCANNED_PDF_WORDS_PER_PAGE = 15;

function lessonWarning(ext, wordCount, pageCount) {
  if (ext === '.pdf' && (wordCount === 0 || wordCount / pageCount < SCANNED_PDF_WORDS_PER_PAGE)) return SCANNED_PDF_WARNING;
  return wordCount < SHORT_TEXT_WORDS ? SHORT_TEXT_WARNING : null;
}

const idParam = z.object({ id: z.coerce.number().int().positive() });
const createBody = z.object({ title: z.string().trim().min(1).max(200).optional() });

// last_section: index (0-based) of the section the student is on; completed_sections: indices they have finished.
const progressBody = z.object({
  last_section: z.number().int().min(0),
  completed_sections: z.array(z.number().int().min(0)).max(500).optional(),
});

const SUMMARY_COLUMNS = 'id, title, filename, word_count, status, error, created_at';

// multer decodes multipart filenames as latin1; recover UTF-8 names (e.g. "Aralin 1 Ñ.docx").
const fixFilename = (name) => Buffer.from(name, 'latin1').toString('utf8');

// Lessons are shared by every participant; uploading, retrying and deleting are admin only. Review progress (where a
// student stopped) is per participant.
export function lessonsRouter(db, { maxUploadBytes }, runner, requireAdmin) {
  const router = Router();
  const upload = createUpload(maxUploadBytes);

  // The lesson starts as 'processing' with a queued job; text extraction is already done at this point.
  const insertLesson = db.prepare(
    `INSERT INTO lessons (title, filename, raw_text, word_count, status, source_kind, source_numbers, source_total)
     VALUES (?, ?, ?, ?, 'processing', ?, ?, ?)`,
  );
  const createLesson = db.transaction((title, filename, text, wordCount, source) => {
    const numbers = source.numbers ? JSON.stringify(source.numbers) : null;
    const id = Number(insertLesson.run(title, filename, text, wordCount, source.kind, numbers, source.total).lastInsertRowid);
    queueJob(db, id);
    return id;
  });

  const readProgress = (lessonId, participant) => {
    if (!participant) return null;
    const row = db
      .prepare('SELECT last_section, completed_sections, updated_at FROM review_progress WHERE participant_id = ? AND lesson_id = ?')
      .get(participant.id, lessonId);
    return row ? { ...row, completed_sections: JSON.parse(row.completed_sections) } : null;
  };

  const parseId = (req) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) throw new HttpError(400, 'Lesson id must be a positive number.');
    return parsed.data.id;
  };

  router.post('/', requireAdmin, (req, res, next) => {
    upload(req, res, async (err) => {
      try {
        if (err) throw err;
        if (!req.file) throw new HttpError(400, 'Choose a .docx, .pptx or .pdf file to upload.');
        const body = createBody.safeParse(req.body ?? {});
        if (!body.success) throw new HttpError(400, 'Title must be 1-200 characters.');

        const filename = fixFilename(req.file.originalname);
        const ext = fileExtension(filename);
        assertSignature(req.file.buffer, ext);
        const includeNotes = getBoolSetting(db, 'include_speaker_notes', true);
        const { text, wordCount, pageCount, source } = await extractText(req.file.buffer, ext, { includeNotes });

        const title = body.data.title || filename.slice(0, -ext.length).trim() || 'Untitled lesson';
        const id = createLesson(title, filename, text, wordCount, source);
        const lesson = db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM lessons WHERE id = ?`).get(id);
        runner.enqueue(id);
        res.status(201).json({ lesson, warning: lessonWarning(ext, wordCount, pageCount) });
      } catch (e) {
        next(e);
      }
    });
  });

  router.get('/', (_req, res) => {
    res.json({ lessons: db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM lessons ORDER BY created_at DESC, id DESC`).all() });
  });

  // review_progress is the participant's own, or null when no participant is sent (the admin's lesson list)
  router.get('/:id', (req, res) => {
    const participant = participantOf(db, req);
    const { source_kind, source_numbers, source_total, ...lesson } = db.prepare('SELECT * FROM lessons WHERE id = ?').get(parseId(req)) ?? {};
    if (!lesson.id) throw new HttpError(404, 'Lesson not found.');
    const byLesson = (sql) => db.prepare(sql).all(lesson.id);
    const sections = byLesson('SELECT id, position, title, content, simple_version, filipino_version, check_questions, sources FROM sections WHERE lesson_id = ? ORDER BY position');
    res.json({
      // where raw_text's blocks came from: numbers[k] is the slide / page / paragraph number of the k-th block.
      // null for a lesson made before section sources were recorded.
      lesson: { ...lesson, source: source_numbers ? { kind: source_kind, total: source_total, numbers: JSON.parse(source_numbers) } : null },
      sections: sections.map((s) => ({
        ...s,
        simple_version: parseSimple(s.simple_version),
        filipino_version: parseFilipino(s.filipino_version),
        check_questions: JSON.parse(s.check_questions),
        sources: s.sources ? JSON.parse(s.sources) : null,
      })),
      key_points: byLesson('SELECT id, position, text FROM key_points WHERE lesson_id = ? ORDER BY position'),
      key_terms: byLesson('SELECT id, term, definition, evidence FROM key_terms WHERE lesson_id = ? ORDER BY id'),
      review_progress: readProgress(lesson.id, participant),
    });
  });

  router.get('/:id/review-progress', (req, res) => {
    const participant = requireParticipant(db, req);
    const id = parseId(req);
    if (!db.prepare('SELECT 1 FROM lessons WHERE id = ?').get(id)) throw new HttpError(404, 'Lesson not found.');
    res.json({ review_progress: readProgress(id, participant) });
  });

  // Saves where the student is in the review so it reopens there. Indices must point at real sections.
  router.put('/:id/review-progress', (req, res) => {
    const participant = requireParticipant(db, req);
    const id = parseId(req);
    if (!db.prepare('SELECT 1 FROM lessons WHERE id = ?').get(id)) throw new HttpError(404, 'Lesson not found.');
    const body = progressBody.safeParse(req.body ?? {});
    if (!body.success) throw new HttpError(400, 'Send last_section (a whole number from 0) and completed_sections (a list of whole numbers).');
    const { count } = db.prepare('SELECT COUNT(*) AS count FROM sections WHERE lesson_id = ?').get(id);
    if (!count) throw new HttpError(409, 'This lesson has no sections to review yet.');
    const completed = [...new Set(body.data.completed_sections ?? readProgress(id, participant)?.completed_sections ?? [])].sort((a, b) => a - b);
    if (body.data.last_section >= count || completed.some((n) => n >= count)) {
      throw new HttpError(400, `This lesson has ${count} sections, numbered from 0.`);
    }
    db.prepare(
      `INSERT INTO review_progress (participant_id, lesson_id, last_section, completed_sections, updated_at)
       VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(participant_id, lesson_id) DO UPDATE SET last_section = excluded.last_section,
         completed_sections = excluded.completed_sections, updated_at = excluded.updated_at`,
    ).run(participant.id, id, body.data.last_section, JSON.stringify(completed));
    res.json({ review_progress: readProgress(id, participant) });
  });

  router.get('/:id/status', (req, res) => {
    const status = getJobStatus(db, parseId(req));
    if (!status) throw new HttpError(404, 'Lesson not found.');
    res.json(status);
  });

  // Re-runs processing for a lesson that failed (e.g. the AI provider was down); finished stages are kept.
  router.post('/:id/retry', requireAdmin, (req, res) => {
    const id = parseId(req);
    const lesson = db.prepare('SELECT status FROM lessons WHERE id = ?').get(id);
    if (!lesson) throw new HttpError(404, 'Lesson not found.');
    if (lesson.status !== 'failed') throw new HttpError(409, 'Only a lesson whose processing failed can be retried.');
    db.transaction(() => queueJob(db, id))();
    runner.enqueue(id);
    res.status(202).json(getJobStatus(db, id));
  });

  router.delete('/:id', requireAdmin, (req, res) => {
    const { changes } = db.prepare('DELETE FROM lessons WHERE id = ?').run(parseId(req));
    if (!changes) throw new HttpError(404, 'Lesson not found.');
    res.status(204).end();
  });

  return router;
}
