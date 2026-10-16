import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/errors.js';
import { requireParticipant } from '../middleware/participant.js';
import { assertSignature, createUpload, fileExtension } from '../middleware/upload.js';
import { extractText } from '../services/extract.js';
import { getJobStatus, queueJob } from '../pipeline/jobs.js';
import { cardsNeedingDistractors } from '../quiz/distractors.js';
import { CARD_LEAK_RULES, cardLeaks } from '../quiz/leaks.js';
import { PREPARE_FAILED_MESSAGE, ownerRecords, safeError } from '../services/lesson-access.js';
import { hasRecords, participantRecords } from '../services/lesson-records.js';
import { logAdminEvent } from '../services/backup.js';
import { missingVersions, versionCounts } from '../services/prepare-versions.js';
import { parseFilipino, parseSimple } from '../services/section-versions.js';
import { getBoolSetting, uploadsPerDay } from '../services/settings.js';
import { assertCanUpload, assertQueueRoom, assertUploadsOn, createUploadGuard, logLessonEvent, uploadStatus, uploadsUsedToday } from '../services/student-upload.js';

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

// The multipart envelope (boundaries, the title field, headers) around the file; a request whose Content-Length is more
// than the file limit plus this is refused before anything is read.
const MULTIPART_OVERHEAD = 64 * 1024;

const SUMMARY_COLUMNS = 'l.id, l.title, l.filename, l.word_count, l.status, l.error, l.created_at, l.origin, l.owner_participant_id, l.shared_at, l.error_kind';
const OWNER_CODE = '(SELECT code FROM participants WHERE id = l.owner_participant_id) AS owner_code';

// The upload problems worth a lesson_upload_failed event, by the code the upload checks put on their error
const UPLOAD_FAILURES = ['too_large', 'wrong_type', 'bad_signature', 'wrong_content', 'unreadable', 'no_text'];
const uploadFailure = (err) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return 'too_large';
  if (err instanceof HttpError) return UPLOAD_FAILURES.includes(err.extra?.code) ? err.extra.code : err.status === 422 ? 'unreadable' : null;
  return null;
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// multer decodes multipart filenames as latin1; recover UTF-8 names (e.g. "Aralin 1 Ñ.docx").
const fixFilename = (name) => Buffer.from(name, 'latin1').toString('utf8');

// Lessons are shared by every participant; uploading, retrying and deleting are admin only. Review progress (where a
// student stopped) is per participant.
export function lessonsRouter(db, { maxUploadBytes }, runner, requireAdmin, { access, clock = () => new Date() }) {
  const router = Router();
  const upload = createUpload(maxUploadBytes);
  const uploadGuard = createUploadGuard({ clock });

  // The lesson starts as 'processing' with a queued job; text extraction is already done at this point.
  const insertLesson = db.prepare(
    `INSERT INTO lessons (title, filename, raw_text, word_count, status, source_kind, source_numbers, source_total, origin, owner_participant_id)
     VALUES (?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?)`,
  );
  // `owner` ({ id }) makes it a student's upload: counted against today's uploads (checked again here, inside the
  // transaction, so two uploads can't both pass) and logged as lesson_uploaded.
  const createLesson = db.transaction((title, filename, text, wordCount, source, owner = null) => {
    const now = clock();
    if (owner && uploadsUsedToday(db, owner.id, now) >= uploadsPerDay(db)) {
      throw new HttpError(429, 'You’ve used today’s uploads. You can upload again tomorrow.', { code: 'upload_quota' });
    }
    if (owner) assertQueueRoom(db);
    const numbers = source.numbers ? JSON.stringify(source.numbers) : null;
    const id = Number(
      insertLesson.run(title, filename, text, wordCount, source.kind, numbers, source.total, owner ? 'student' : 'admin', owner?.id ?? null).lastInsertRowid,
    );
    queueJob(db, id);
    if (owner) logLessonEvent(db, { participantId: owner.id, type: 'lesson_uploaded', lessonId: id, title, detail: filename, now });
    return id;
  });

  // A lesson row as the caller may see it. Students get `mine` and `shared`, never the owner's code or id, and never the
  // file name (the title may come from it, but they chose that file themselves); admin gets the owner's code and the
  // file name. A student's own upload that failed for a reason other than its file shows a plain message.
  const shape = (row, viewer) => {
    const { owner_participant_id: ownerId, owner_code: ownerCode, error_kind: errorKind, ...rest } = row;
    const mine = Boolean(viewer.participant) && ownerId === viewer.participant.id;
    const out = { ...rest, error: safeError(row.error, { origin: row.origin, error_kind: errorKind }, viewer), mine, shared: row.shared_at !== null };
    if (viewer.admin) out.owner_code = ownerCode ?? null;
    else delete out.filename;
    if (mine && !viewer.admin) {
      const records = ownerRecords(db, row.id, viewer.participant.id);
      out.can_delete = row.origin === 'student' && row.shared_at === null && !hasRecords(records);
      out.can_retry = row.status === 'failed';
    }
    return out;
  };

  const readProgress = (lessonId, participant) => {
    if (!participant) return null;
    const row = db
      .prepare('SELECT last_section, completed_sections, updated_at FROM review_progress WHERE participant_id = ? AND lesson_id = ?')
      .get(participant.id, lessonId);
    return row ? { ...row, completed_sections: JSON.parse(row.completed_sections) } : null;
  };

  const lessonRow = (id) => db.prepare('SELECT id, title, status, origin, owner_participant_id, shared_at, error_kind FROM lessons WHERE id = ?').get(id);
  const parseId = (req) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) throw new HttpError(400, 'Lesson id must be a positive number.');
    return parsed.data.id;
  };

  // Admin (with the PIN) uploads a teacher's lesson. Without it, a participant uploads their own, when admin allows it:
  // the switch, a burst limit, today's quota and the queue are checked before the file is read, then the file is checked
  // by its content (signature, and the part that makes it a real .docx / .pptx) and read. The lesson is private to its
  // owner until admin shares it. Students' uploads that fail are logged as lesson_upload_failed.
  router.post('/', (req, res, next) => {
    let viewer;
    let student = null;
    let release = null;
    const logFailure = (participant, detail) => {
      try {
        logLessonEvent(db, { participantId: participant.id, type: 'lesson_upload_failed', detail, now: clock() });
      } catch (inner) {
        console.error('Could not log the failed upload:', inner.message);
      }
    };
    try {
      viewer = access.viewerOf(req);
      if (!viewer.admin) {
        student = requireParticipant(db, req);
        assertUploadsOn(db);
      }
      // A body that says it is far bigger than the limit is refused before multer reads any of it. The connection is
      // closed after the answer, so the rest of the body is not read either.
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxUploadBytes + MULTIPART_OVERHEAD) {
        res.set('Connection', 'close');
        if (student) logFailure(student, 'too_large');
        const mb = Math.round(maxUploadBytes / 1024 / 1024);
        throw new HttpError(413, `That file is larger than ${mb} MB. Upload a smaller file.`, { code: 'too_large' });
      }
      if (student) {
        uploadGuard.hit(student.id);
        assertCanUpload(db, student, clock());
        release = uploadGuard.start(student.id);
        // also when the connection goes away before the upload callback runs (an aborted request)
        res.on('close', release);
      }
    } catch (e) {
      return next(e);
    }
    return upload(req, res, async (err) => {
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
        // an admin upload with no text fails in the pipeline (Retry); a student's is refused now, without using a try
        if (student && wordCount === 0) {
          throw new HttpError(422, "This file has no readable text, so there's nothing to study. Try a text-based version of the lesson.", { code: 'no_text' });
        }

        const title = body.data.title || filename.slice(0, -ext.length).trim().slice(0, 200) || 'Untitled lesson';
        const id = createLesson(title, filename, text, wordCount, source, student);
        const lesson = shape(db.prepare(`SELECT ${SUMMARY_COLUMNS}, ${OWNER_CODE} FROM lessons l WHERE l.id = ?`).get(id), viewer);
        runner.enqueue(id);
        res.status(201).json({
          lesson,
          warning: lessonWarning(ext, wordCount, pageCount),
          ...(student && { uploads: uploadStatus(db, student, clock(), maxUploadBytes) }),
        });
      } catch (e) {
        const detail = student && uploadFailure(e);
        if (detail) logFailure(student, detail);
        next(e);
      } finally {
        release?.();
      }
    });
  });

  // `quiz_options`: concept cards still without AI wrong answers (`missing`), those whose saved ones give the answer
  // away (`weak`, see quiz/leaks.js; the quiz asks them as Yes/No or leaves them out until remade) and, when the last
  // job was making them, its `status` (queued | running | done | failed) and `error`. Admin uses it to show progress
  // and a retry button. `leaks.cards`: flashcards that give their answer away (rules g-k), listed by
  // GET /api/admin/lessons/:id/leaks. Both run the leak checks over every card, so they are only sent to admin's list
  // (`?counts=1`, behind the PIN), not to the students' list. `section_versions`: the shared Explain simpler /
  // Filipino-Taglish versions still missing (`missing` of `total`, two per section) and, when the last job was making
  // them ("Prepare"), its `status`, `error` and `progress`. `flashcards` (admin's list only): how many cards the lesson
  // has and, when the last job was making them, its `status` and `error` (the "Make cards" button, which used to be on
  // the Flashcard tab: admin keeps the PIN only on the admin screens).
  const quizOptionCounts = (lessonId) => {
    const missing = cardsNeedingDistractors(db, lessonId).length;
    return { missing, weak: cardsNeedingDistractors(db, lessonId, { includeFailing: true }).length - missing };
  };
  const leakyCards = (lessonId) => {
    const cards = db.prepare('SELECT id, kind, front, back FROM flashcards WHERE lesson_id = ?').all(lessonId);
    return cards.filter((c) => cardLeaks(c, cards).some((p) => CARD_LEAK_RULES.includes(p.rule))).length;
  };
  const listLessons = (res, counts, viewer) => {
    const versions = versionCounts(db);
    const cardTotals = counts ? new Map(db.prepare('SELECT lesson_id, COUNT(*) AS n FROM flashcards GROUP BY lesson_id').all().map((r) => [r.lesson_id, r.n])) : null;
    const lessons = db
      .prepare(`SELECT ${SUMMARY_COLUMNS}, ${OWNER_CODE} FROM lessons l WHERE ${access.visibleSql(viewer)} ORDER BY l.created_at DESC, l.id DESC`)
      .all();
    res.json({
      lessons: lessons.map((lesson) => {
        const { job } = getJobStatus(db, lesson.id);
        const own = job?.stage === 'quiz_options';
        const preparing = job?.stage === 'section_versions';
        const making = job?.stage === 'flashcards';
        const row = shape(lesson, viewer);
        return {
          ...row,
          // where a lesson that is still being prepared has got to (a student's own upload shows it in the library)
          ...(lesson.status === 'processing' && (viewer.admin || row.mine) && job && { processing: { stage: job.stage, status: job.status } }),
          ...(counts && {
            quiz_options: { ...quizOptionCounts(lesson.id), status: own ? job.status : null, error: own ? job.error : null },
            leaks: { cards: leakyCards(lesson.id) },
            flashcards: { total: cardTotals.get(lesson.id) ?? 0, status: making ? job.status : null, error: making ? job.error : null },
          }),
          section_versions: {
            ...(versions.get(lesson.id) ?? { missing: 0, total: 0 }),
            status: preparing ? job.status : null,
            error: preparing && job.error ? (viewer.admin ? job.error : PREPARE_FAILED_MESSAGE) : null,
            progress: preparing ? job.progress : null,
          },
        };
      }),
    });
  };
  // ?counts=1 (admin's list) goes through the PIN check, lockout included
  router.get('/', (req, res, next) => {
    if (req.query.counts !== '1') return listLessons(res, false, access.viewerOf(req));
    return requireAdmin(req, res, (err) => (err ? next(err) : listLessons(res, true, { admin: true, participant: null })));
  });

  // review_progress is the participant's own, or null when no participant is sent (the admin's lesson list). A student's
  // private upload is a 404 to every other student.
  router.get('/:id', (req, res) => {
    const viewer = access.viewerOf(req);
    const row = access.visibleLesson(viewer, parseId(req), `l.*, ${OWNER_CODE}`);
    const { source_kind, source_numbers, source_total, raw_text: rawText, ...rest } = row;
    const lesson = { ...shape({ ...rest, raw_text: rawText }, viewer) };
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
      review_progress: readProgress(lesson.id, viewer.participant),
    });
  });

  router.get('/:id/review-progress', (req, res) => {
    const viewer = access.viewerOf(req);
    const participant = requireParticipant(db, req);
    const id = parseId(req);
    access.visibleLesson(viewer, id);
    res.json({ review_progress: readProgress(id, participant) });
  });

  // Saves where the student is in the review so it reopens there. Indices must point at real sections.
  router.put('/:id/review-progress', (req, res) => {
    const viewer = access.viewerOf(req);
    const participant = requireParticipant(db, req);
    const id = parseId(req);
    access.visibleLesson(viewer, id);
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
    const viewer = access.viewerOf(req);
    const id = parseId(req);
    access.visibleLesson(viewer, id);
    const status = getJobStatus(db, id);
    const row = lessonRow(id);
    // a student's own upload that failed for a reason other than its file: a plain message, never the provider's
    status.lesson.error = safeError(status.lesson.error, row, viewer);
    if (status.job) status.job.error = safeError(status.job.error, row, viewer);
    res.json({ ...status, can_retry: row.status === 'failed' && (viewer.admin || (row.owner_participant_id !== null && row.owner_participant_id === viewer.participant?.id)) });
  });

  // Re-runs processing for a lesson that failed (e.g. the AI provider was down); finished stages are kept. Admin can
  // retry any lesson; a student only their own failed upload, and a retry doesn't use up an upload.
  router.post('/:id/retry', (req, res) => {
    const viewer = access.viewerOf(req);
    const id = parseId(req);
    const lesson = access.visibleLesson(viewer, id, 'l.id, l.status, l.owner_participant_id');
    if (!viewer.admin) {
      const me = requireParticipant(db, req);
      if (lesson.owner_participant_id !== me.id) throw new HttpError(404, 'Lesson not found.');
    }
    if (lesson.status !== 'failed') throw new HttpError(409, 'Only a lesson whose processing failed can be retried.');
    db.transaction(() => {
      // a student's retry counts against the queue like a new upload (admin's does not)
      if (!viewer.admin) assertQueueRoom(db);
      queueJob(db, id);
    })();
    runner.enqueue(id);
    res.status(202).json(getJobStatus(db, id));
  });

  // Makes the AI wrong answers for the quiz: the retry for a failed quiz_options stage, and the way to fill them in
  // for a lesson made before that stage existed, and the way to remake saved ones that give the answer away. The
  // lesson stays readable while it runs.
  router.post('/:id/quiz-options', requireAdmin, (req, res) => {
    const id = parseId(req);
    const lesson = db.prepare('SELECT status FROM lessons WHERE id = ?').get(id);
    if (!lesson) throw new HttpError(404, 'Lesson not found.');
    if (lesson.status === 'processing') throw new HttpError(409, 'This lesson is still being prepared; its quiz answer options are made at the end.');
    if (lesson.status === 'failed') throw new HttpError(409, 'Retry this lesson first; its quiz answer options are made when it finishes.');
    const { job } = getJobStatus(db, id);
    if (job && ['queued', 'running'].includes(job.status)) throw new HttpError(409, 'This lesson is already being worked on.');
    if (!cardsNeedingDistractors(db, id, { includeFailing: true }).length) throw new HttpError(409, 'This lesson has no flashcards that still need quiz answer options.');
    db.transaction(() => queueJob(db, id, { stage: 'quiz_options', keepLesson: true }))();
    runner.enqueue(id);
    res.status(202).json(getJobStatus(db, id));
  });

  // "Prepare simpler and Taglish versions": makes the shared rewrite of every section that has none yet, with the admin
  // Default, so students' taps need no live AI call. The lesson stays readable while it runs; taps meanwhile are served
  // as usual (a version made by a tap is kept and skipped here).
  router.post('/:id/section-versions', requireAdmin, (req, res) => {
    const id = parseId(req);
    const lesson = db.prepare('SELECT status FROM lessons WHERE id = ?').get(id);
    if (!lesson) throw new HttpError(404, 'Lesson not found.');
    if (lesson.status !== 'ready') throw new HttpError(409, 'Prepare works on a lesson that has finished processing.');
    const { job } = getJobStatus(db, id);
    if (job && ['queued', 'running'].includes(job.status)) throw new HttpError(409, 'This lesson is already being worked on.');
    if (!missingVersions(db, id).length) throw new HttpError(409, 'Every section already has its simpler and Taglish versions.');
    db.transaction(() => queueJob(db, id, { stage: 'section_versions', keepLesson: true }))();
    runner.enqueue(id);
    res.status(202).json(getJobStatus(db, id));
  });

  // Admin: a lesson that participants have studied can't be deleted: it would take their answers and quiz attempts with
  // it and cut their sessions off from the lesson, which the research export needs.
  // A student: only their own private upload, and only before they have studied it (a flashcard answer, a quiz attempt
  // or a reading session with active time). Once it is shared, or studied, there is no delete. Anyone else's lesson is a 404.
  const deleteAsAdmin = (id) => {
    const records = participantRecords(db, id);
    if (hasRecords(records)) {
      const removed = [
        records.flashcard_answers && plural(records.flashcard_answers, 'flashcard answer'),
        records.quiz_attempts && `${plural(records.quiz_attempts, 'quiz attempt')} (${plural(records.quiz_answers, 'quiz answer')})`,
      ].filter(Boolean);
      const unlinked = [records.sessions && plural(records.sessions, 'study session'), records.events && plural(records.events, 'event')].filter(Boolean);
      const effects = [
        removed.length && `remove ${removed.join(' and ')}`,
        unlinked.length && `cut ${unlinked.join(' and ')} off from the lesson`,
      ].filter(Boolean);
      throw new HttpError(409, `This lesson can’t be deleted: participants have studied it. Deleting it would ${effects.join(' and ')}. Export the research data first if you need a copy.`, {
        code: 'lesson_has_records',
        records,
      });
    }
    db.prepare('DELETE FROM lessons WHERE id = ?').run(id);
  };
  const deleteAsOwner = (lesson, me) => {
    if (lesson.origin !== 'student' || lesson.owner_participant_id !== me.id) throw new HttpError(404, 'Lesson not found.');
    if (lesson.shared_at) throw new HttpError(409, 'This lesson was shared with everyone, so it can’t be deleted.', { code: 'lesson_shared' });
    if (hasRecords(ownerRecords(db, lesson.id, me.id))) {
      throw new HttpError(409, 'You’ve started studying this lesson, so it can’t be deleted any more.', { code: 'lesson_studied' });
    }
    db.transaction(() => {
      logLessonEvent(db, { participantId: me.id, type: 'lesson_deleted_by_student', lessonId: lesson.id, title: lesson.title, now: clock() });
      // What the owner left on the lesson without studying it (a simpler / Taglish tap, a reading session opened with no
      // time, a quiz or the flashcards opened) goes with it. Left behind, those rows would lose their lesson (lesson_id
      // NULL) and be counted in the main measures, which count the teacher's lessons and the All lessons deck (NULL).
      // Attempts with no answer are removed with the lesson (cascade). The deleted-lesson event above stays.
      db.prepare('DELETE FROM events WHERE participant_id = ? AND lesson_id = ?').run(me.id, lesson.id);
      db.prepare('DELETE FROM study_sessions WHERE participant_id = ? AND lesson_id = ?').run(me.id, lesson.id);
      db.prepare('DELETE FROM lessons WHERE id = ?').run(lesson.id);
    })();
  };
  router.delete('/:id', (req, res) => {
    const viewer = access.viewerOf(req);
    const id = parseId(req);
    if (viewer.admin) {
      if (!lessonRow(id)) throw new HttpError(404, 'Lesson not found.');
      deleteAsAdmin(id);
    } else {
      const me = requireParticipant(db, req);
      access.visibleLesson(viewer, id);
      deleteAsOwner(lessonRow(id), me);
    }
    res.status(204).end();
  });

  // "Share with everyone" (admin): a student's finished upload becomes visible to every participant. One way: there is
  // no unshare. Logged in lesson_events (for the owner) and admin_events.
  router.post('/:id/share', requireAdmin, (req, res) => {
    const id = parseId(req);
    const lesson = lessonRow(id);
    if (!lesson) throw new HttpError(404, 'Lesson not found.');
    if (lesson.origin !== 'student') throw new HttpError(409, 'Only a lesson a student uploaded can be shared. This one is already everyone’s.');
    if (lesson.shared_at) throw new HttpError(409, 'This lesson is already shared with everyone.');
    if (lesson.status !== 'ready') throw new HttpError(409, 'Share a lesson once it has finished processing.');
    const now = clock();
    db.transaction(() => {
      db.prepare('UPDATE lessons SET shared_at = ? WHERE id = ?').run(now.toISOString(), id);
      if (lesson.owner_participant_id !== null) {
        logLessonEvent(db, { participantId: lesson.owner_participant_id, type: 'lesson_shared', lessonId: id, title: lesson.title, actor: 'admin', now });
      }
      const owner = lesson.owner_participant_id !== null ? db.prepare('SELECT code FROM participants WHERE id = ?').get(lesson.owner_participant_id)?.code : null;
      logAdminEvent(db, 'lesson_shared', `lesson ${id}${owner ? ` from ${owner}` : ''}`, now);
    })();
    res.json({ lesson: shape({ ...db.prepare(`SELECT ${SUMMARY_COLUMNS}, ${OWNER_CODE} FROM lessons l WHERE l.id = ?`).get(id) }, { admin: true, participant: null }) });
  });

  return router;
}
