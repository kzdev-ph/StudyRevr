import { Router } from 'express';
import { z } from 'zod';
import { logEvent } from '../events/log.js';
import { loadSchedulerConfig } from '../flashcards/config.js';
import { HttpError } from '../middleware/errors.js';
import { requireParticipant } from '../middleware/participant.js';
import { getJobStatus } from '../pipeline/jobs.js';
import { answerQuestion, attemptQuestions, findOpenAttempt, finishAttempt, getAttempt, lessonQuizStats, publicQuestion, questionsOf, startAttempt } from '../quiz/attempts.js';
import { buildQuiz, QUIZ_LENGTH, reshuffle, usableCount } from '../quiz/build.js';
import { ensureDistractors } from '../quiz/distractors.js';
import { quizBuildOptions } from '../quiz/options.js';
import { markMixedIfClaude } from '../services/lesson-author.js';

const id = z.coerce.number().int().positive();
const startBody = z.object({ retake_of: id.nullable().optional() });
const answerBody = z.object({ position: z.number().int().min(0), choice: z.number().int().min(0), time_ms: z.number().min(0).optional() });
const finishBody = z.object({ total_ms: z.number().min(0).optional() });

const NEEDS_TWO = 'This lesson needs at least 2 different flashcards for a quiz.';

const parseId = (value, what) => {
  const parsed = id.safeParse(value);
  if (!parsed.success) throw new HttpError(400, `${what} id must be a positive number.`);
  return parsed.data;
};

const lessonCards = (db, lessonId) =>
  db.prepare('SELECT id, kind, front, back, evidence FROM flashcards WHERE lesson_id = ? ORDER BY position, id').all(lessonId);
// What the quiz builder needs besides the cards: saved wrong answers, other key terms, the lesson text (for the leak
// checks that skip questions giving their answer away; see quiz/leaks.js), the AI review's flags and term families.
const buildOptions = quizBuildOptions;

// Mock quiz: questions built from the lesson's flashcards, graded and logged one answer at a time. Mounted at /api.
// Attempts are per participant (the signed-in account): each sees and answers only their own.
// `clock()` is the current time and `random` the shuffle source (tests pass fixed ones); `tuning()` gives the AI
// concurrency for the wrong-answers batches.
export function quizRouter({ db, ai, access, clock = () => new Date(), random = Math.random, tuning = () => ({ concurrency: 1 }), log = console }) {
  const router = Router();
  // The lesson, when the caller may see it (another student's private upload is a 404)
  const lessonOr404 = (viewer, lessonId) => access.visibleLesson(viewer, lessonId, 'l.id, l.title, l.status');
  // An attempt is its participant's own; its lesson must still be one they may see
  const attemptOr404 = (viewer, attemptId, participantId) => {
    const attempt = getAttempt(db, attemptId, participantId);
    if (!access.canSee(viewer, attempt.lesson_id)) throw new HttpError(404, 'Quiz attempt not found.');
    return attempt;
  };

  // Normally made when the lesson was processed; this fills in whatever is still missing (older lessons, a failed
  // stage). Two quick starts, or a start during an admin retry, share one AI call.
  // It writes into the lesson, so a Claude-written lesson that needed it is no longer all Claude's (made_by 'mixed').
  const distractorsFor = async (lessonId) => {
    const result = await ensureDistractors({ db, ai, lessonId, concurrency: tuning().concurrency ?? 1, now: clock, log });
    if (result.made > 0) markMixedIfClaude(db, lessonId);
    return result;
  };

  // One row per lesson for the Mock Quiz tab: how many questions it supports and the best finished score.
  router.get('/quiz', (req, res) => {
    const viewer = access.viewerOf(req);
    const { id: participantId } = requireParticipant(db, req);
    const stats = lessonQuizStats(db, participantId);
    const lessons = db.prepare(`SELECT l.id, l.title, l.status, l.created_at FROM lessons l WHERE ${access.visibleSql(viewer)} ORDER BY l.created_at DESC, l.id DESC`).all();
    res.json({
      quiz_length: QUIZ_LENGTH,
      lessons: lessons.map((lesson) => {
        const cards = lessonCards(db, lesson.id);
        const { job } = getJobStatus(db, lesson.id);
        const s = stats.get(lesson.id);
        return {
          lesson_id: lesson.id,
          title: lesson.title,
          status: lesson.status,
          cards: cards.length,
          making_cards: job?.stage === 'flashcards' && ['queued', 'running'].includes(job.status),
          questions: Math.min(QUIZ_LENGTH, usableCount(cards, buildOptions(db, lesson.id))),
          attempts: s?.attempts ?? 0,
          best: s?.best ?? null,
          last_taken_at: s?.last_taken_at ?? null,
        };
      }),
    });
  });

  // The quiz screen's answer for an attempt that is still open: its questions (no answers) and where to pick up.
  const resumed = ({ attempt, next_position, elapsed_ms }) => {
    const questions = attemptQuestions(db, attempt.id);
    const where = next_position === null ? null : next_position + 1;
    return {
      attempt,
      questions: questions.map(publicQuestion),
      notice: where ? `Picking up where you left off, at question ${where} of ${questions.length}.` : null,
      resumed: true,
      next_position,
      elapsed_ms,
    };
  };

  // Starts a quiz. Unless { retake_of } is given, an unfinished attempt on this lesson that started less than 2 hours
  // ago is returned instead (resume at its first unanswered question), so a reload never makes a second attempt.
  // A fresh one picks up to QUIZ_LENGTH cards at random (making any missing wrong answers first);
  // { retake_of } asks the same questions as that attempt, in a new order. The right answers stay on the server.
  router.post('/lessons/:id/quiz/attempts', async (req, res, next) => {
    try {
      const viewer = access.viewerOf(req);
      const { id: participantId } = requireParticipant(db, req);
      const lesson = lessonOr404(viewer, parseId(req.params.id, 'Lesson'));
      const body = startBody.safeParse(req.body ?? {});
      if (!body.success) throw new HttpError(400, 'retake_of must be the id of an earlier attempt, or left out.');
      const retakeOf = body.data.retake_of ?? null;
      let questions;
      let notice = null;

      if (!retakeOf) {
        const open = findOpenAttempt(db, lesson.id, clock(), participantId);
        if (open) return res.json(resumed(open));
      }

      if (retakeOf) {
        const source = getAttempt(db, retakeOf, participantId);
        if (source.lesson_id !== lesson.id) throw new HttpError(400, 'That attempt belongs to another lesson.');
        questions = reshuffle(questionsOf(db, retakeOf), random);
      } else {
        if (lesson.status === 'processing') throw new HttpError(409, 'This lesson is still being prepared. Its quiz is ready once its flashcards are made.');
        const cards = lessonCards(db, lesson.id);
        if (!cards.length) throw new HttpError(409, 'This lesson has no flashcards yet, and the quiz is made from them. Your teacher can make them.');
        if (cards.length < 2) throw new HttpError(409, NEEDS_TWO);
        const made = await distractorsFor(lesson.id);
        // another start may have finished while the wrong answers were being made
        const raced = findOpenAttempt(db, lesson.id, clock(), participantId);
        if (raced) return res.json(resumed(raced));
        questions = buildQuiz({ cards, ...buildOptions(db, lesson.id), random });
        if (!questions.length) throw new HttpError(409, NEEDS_TWO);
        const notes = [];
        if (questions.length < QUIZ_LENGTH) notes.push(`This lesson supports ${questions.length} ${questions.length === 1 ? 'question' : 'questions'}.`);
        if (made.error) notes.push('Answer options for some questions couldn’t be made, so they are true or false this time.');
        notice = notes.join(' ') || null;
      }

      const now = clock();
      const attemptId = startAttempt(db, { participantId, lessonId: lesson.id, questions, now, retakeOf });
      if (retakeOf) logEvent(db, { participantId, type: 'quiz_retake', lessonId: lesson.id, attemptId, now, config: loadSchedulerConfig(db) });
      const attempt = getAttempt(db, attemptId);
      res.status(201).json({ attempt, questions: attemptQuestions(db, attemptId).map(publicQuestion), notice, resumed: false, next_position: 0, elapsed_ms: 0 });
    } catch (e) {
      next(e);
    }
  });

  // Grades and saves one answer. -> whether it was right, the right option, and the card's evidence quote.
  router.post('/quiz/attempts/:id/answers', (req, res) => {
    const viewer = access.viewerOf(req);
    const { id: participantId } = requireParticipant(db, req);
    const attemptId = parseId(req.params.id, 'Attempt');
    attemptOr404(viewer, attemptId, participantId);
    const body = answerBody.safeParse(req.body ?? {});
    if (!body.success) throw new HttpError(400, 'Send position (the question number, from 0), choice (the option number, from 0) and optionally time_ms.');
    const { position, choice, time_ms: timeMs } = body.data;
    res.json(answerQuestion(db, { participantId, attemptId, position, choice, timeMs, now: clock() }));
  });

  // Closes the attempt (every question must be answered) and returns the results.
  router.post('/quiz/attempts/:id/finish', (req, res) => {
    const viewer = access.viewerOf(req);
    const { id: participantId } = requireParticipant(db, req);
    const attemptId = parseId(req.params.id, 'Attempt');
    attemptOr404(viewer, attemptId, participantId);
    const body = finishBody.safeParse(req.body ?? {});
    if (!body.success) throw new HttpError(400, 'total_ms must be a number of milliseconds.');
    res.json(finishAttempt(db, { participantId, attemptId, durationMs: body.data.total_ms, now: clock() }));
  });

  return router;
}
