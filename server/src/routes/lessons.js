import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/errors.js';
import { assertSignature, createUpload, fileExtension } from '../middleware/upload.js';
import { extractText } from '../services/extract.js';
import { getJobStatus, queueJob } from '../pipeline/jobs.js';
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

const SUMMARY_COLUMNS = 'id, title, filename, word_count, status, error, created_at';

// multer decodes multipart filenames as latin1; recover UTF-8 names (e.g. "Aralin 1 Ñ.docx").
const fixFilename = (name) => Buffer.from(name, 'latin1').toString('utf8');

export function lessonsRouter(db, { maxUploadBytes }, runner) {
  const router = Router();
  const upload = createUpload(maxUploadBytes);

  // The lesson starts as 'processing' with a queued job; text extraction is already done at this point.
  const insertLesson = db.prepare(
    `INSERT INTO lessons (title, filename, raw_text, word_count, status) VALUES (?, ?, ?, ?, 'processing')`,
  );
  const createLesson = db.transaction((title, filename, text, wordCount) => {
    const id = Number(insertLesson.run(title, filename, text, wordCount).lastInsertRowid);
    queueJob(db, id);
    return id;
  });

  const parseId = (req) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) throw new HttpError(400, 'Lesson id must be a positive number.');
    return parsed.data.id;
  };

  router.post('/', (req, res, next) => {
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
        const { text, wordCount, pageCount } = await extractText(req.file.buffer, ext, { includeNotes });

        const title = body.data.title || filename.slice(0, -ext.length).trim() || 'Untitled lesson';
        const id = createLesson(title, filename, text, wordCount);
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

  router.get('/:id', (req, res) => {
    const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(parseId(req));
    if (!lesson) throw new HttpError(404, 'Lesson not found.');
    const byLesson = (sql) => db.prepare(sql).all(lesson.id);
    const sections = byLesson('SELECT id, position, title, content, simple_version, filipino_version, check_questions FROM sections WHERE lesson_id = ? ORDER BY position');
    res.json({
      lesson,
      sections: sections.map((s) => ({ ...s, check_questions: JSON.parse(s.check_questions) })),
      key_points: byLesson('SELECT id, position, text FROM key_points WHERE lesson_id = ? ORDER BY position'),
      key_terms: byLesson('SELECT id, term, definition FROM key_terms WHERE lesson_id = ? ORDER BY id'),
    });
  });

  router.get('/:id/status', (req, res) => {
    const status = getJobStatus(db, parseId(req));
    if (!status) throw new HttpError(404, 'Lesson not found.');
    res.json(status);
  });

  // Re-runs processing for a lesson that failed (e.g. the AI provider was down); finished stages are kept.
  router.post('/:id/retry', (req, res) => {
    const id = parseId(req);
    const lesson = db.prepare('SELECT status FROM lessons WHERE id = ?').get(id);
    if (!lesson) throw new HttpError(404, 'Lesson not found.');
    if (lesson.status !== 'failed') throw new HttpError(409, 'Only a lesson whose processing failed can be retried.');
    db.transaction(() => queueJob(db, id))();
    runner.enqueue(id);
    res.status(202).json(getJobStatus(db, id));
  });

  router.delete('/:id', (req, res) => {
    const { changes } = db.prepare('DELETE FROM lessons WHERE id = ?').run(parseId(req));
    if (!changes) throw new HttpError(404, 'Lesson not found.');
    res.status(204).end();
  });

  return router;
}
