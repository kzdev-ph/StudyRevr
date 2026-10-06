import { Router } from 'express';
import { z } from 'zod';
import { loadSchedulerConfig } from '../flashcards/config.js';
import { deckCards, doneToday, recordAnswer, studyState, undoAnswer } from '../flashcards/study.js';
import { buildQueue, studyDay } from '../flashcards/scheduler.js';
import { HttpError } from '../middleware/errors.js';
import { requireParticipant } from '../middleware/participant.js';
import { getJobStatus, queueJob } from '../pipeline/jobs.js';

const id = z.coerce.number().int().positive();
// `deck`: the lesson being studied, or null for "All lessons". It decides which card comes next after an answer.
const reviewBody = z.object({
  rating: z.number().int().min(1).max(4),
  time_ms: z.number().min(0).optional(),
  deck: id.nullable().optional(),
});
const undoBody = z.object({ deck: id.nullable().optional() });

const parseId = (value, what) => {
  const parsed = id.safeParse(value);
  if (!parsed.success) throw new HttpError(400, `${what} id must be a positive number.`);
  return parsed.data;
};

// Flashcards: decks, studying (one card at a time, chosen by the scheduler), undo, and making cards for a lesson
// that has none. Mounted at /api. Studying is per participant (X-Participant); making cards is admin only.
// `clock()` is the current time (tests pass a fake one).
export function flashcardsRouter({ db, runner, clock = () => new Date(), requireAdmin }) {
  const router = Router();
  const config = () => loadSchedulerConfig(db);

  const lessonOr404 = (lessonId) => {
    const lesson = db.prepare('SELECT id, title, status FROM lessons WHERE id = ?').get(lessonId);
    if (!lesson) throw new HttpError(404, 'Lesson not found.');
    return lesson;
  };

  // Every lesson with its counts, plus the "All lessons" deck. `job` is set while cards are being made for a lesson,
  // or when making them failed (status 'failed', with the message to show).
  router.get('/flashcards/decks', (req, res) => {
    const { id: participantId } = requireParticipant(db, req);
    const now = clock();
    const cfg = config();
    const done = doneToday(db, studyDay(now, cfg).start, participantId);
    const all = deckCards(db, null, participantId);
    const byLesson = Map.groupBy(all, (c) => c.lesson_id);
    // counts, and when nothing is left today, when the next card becomes available
    const summary = (cards) => {
      const q = buildQueue(cards, { now, config: cfg, doneToday: done });
      return { counts: q.counts, next_due_at: q.card ? null : q.nextDueAt?.toISOString() ?? null };
    };
    const lessons = db.prepare('SELECT id, title, status, created_at FROM lessons ORDER BY created_at DESC, id DESC').all();
    const decks = lessons.map((lesson) => {
      const cards = byLesson.get(lesson.id) ?? [];
      const { job } = getJobStatus(db, lesson.id);
      const making = job?.stage === 'flashcards' && job.status !== 'done' ? { status: job.status, error: job.error, progress: job.progress } : null;
      return { lesson_id: lesson.id, title: lesson.title, status: lesson.status, total: cards.length, ...summary(cards), job: making };
    });
    res.json({
      all: { total: all.length, ...summary(all) },
      decks,
      limits: { new_per_day: cfg.newPerDay, reviews_per_day: cfg.reviewsPerDay, new_done: done.newCards, reviews_done: done.reviews },
    });
  });

  router.get('/flashcards/due', (req, res) => {
    const { id: participantId } = requireParticipant(db, req);
    res.json({ deck: { lesson_id: null, title: 'All lessons' }, ...studyState(db, { participantId, now: clock(), config: config() }) });
  });

  router.get('/lessons/:id/flashcards/due', (req, res) => {
    const { id: participantId } = requireParticipant(db, req);
    const lesson = lessonOr404(parseId(req.params.id, 'Lesson'));
    res.json({ deck: { lesson_id: lesson.id, title: lesson.title }, ...studyState(db, { participantId, lessonId: lesson.id, now: clock(), config: config() }) });
  });

  // Saves one answer (and its review-log row) and returns the deck's next card.
  router.post('/flashcards/:id/review', (req, res) => {
    const { id: participantId } = requireParticipant(db, req);
    const cardId = parseId(req.params.id, 'Flashcard');
    const body = reviewBody.safeParse(req.body ?? {});
    if (!body.success) throw new HttpError(400, 'Send rating (1 Again, 2 Hard, 3 Good, 4 Easy), and optionally time_ms and deck.');
    const now = clock();
    const cfg = config();
    const { review_id: reviewId, card } = recordAnswer(db, { participantId, cardId, rating: body.data.rating, timeMs: body.data.time_ms, now, config: cfg });
    const lessonId = body.data.deck ?? null;
    res.json({
      review_id: reviewId,
      answered: { id: card.id, state: card.state, interval: card.interval, due_at: card.due_at, ease: card.ease },
      ...studyState(db, { participantId, lessonId, now, config: cfg }),
    });
  });

  // Undoes an answer; the card comes back up next, front side first.
  router.post('/flashcards/reviews/:id/undo', (req, res) => {
    const { id: participantId } = requireParticipant(db, req);
    const reviewId = parseId(req.params.id, 'Review');
    const body = undoBody.safeParse(req.body ?? {});
    if (!body.success) throw new HttpError(400, 'deck must be a lesson id or null.');
    const cardId = undoAnswer(db, reviewId, participantId);
    res.json({ undone: reviewId, ...studyState(db, { participantId, lessonId: body.data.deck ?? null, now: clock(), config: config(), showFirst: cardId }) });
  });

  // Makes the cards for a lesson that has none (lessons uploaded before flashcards existed, or a run that made none).
  // The lesson stays readable while it runs; poll GET /flashcards/decks or the lesson status.
  router.post('/lessons/:id/flashcards/generate', requireAdmin, (req, res) => {
    const lesson = lessonOr404(parseId(req.params.id, 'Lesson'));
    if (lesson.status === 'processing') throw new HttpError(409, 'This lesson is still being prepared; its flashcards are made at the end.');
    if (lesson.status === 'failed') throw new HttpError(409, 'Retry this lesson first; its flashcards are made when it finishes.');
    const { job } = getJobStatus(db, lesson.id);
    if (job && ['queued', 'running'].includes(job.status)) throw new HttpError(409, 'Flashcards for this lesson are already being made.');
    if (db.prepare('SELECT 1 FROM flashcards WHERE lesson_id = ?').get(lesson.id)) throw new HttpError(409, 'This lesson already has flashcards.');
    db.transaction(() => queueJob(db, lesson.id, { stage: 'flashcards', keepLesson: true }))();
    runner.enqueue(lesson.id);
    res.status(202).json(getJobStatus(db, lesson.id));
  });

  return router;
}
