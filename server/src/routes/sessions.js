import { Router } from 'express';
import { z } from 'zod';
import { EVENT_TYPES, logEvent } from '../events/log.js';
import { logSettingEvent, settingEventBody } from '../events/settings.js';
import { loadSchedulerConfig } from '../flashcards/config.js';
import { HttpError } from '../middleware/errors.js';
import { requireParticipant } from '../middleware/participant.js';
import { ACTIVITIES, END_REASONS, startSession, updateSession } from '../sessions/store.js';

const id = z.coerce.number().int().positive();
const startBody = z.object({ lesson_id: id.nullable(), activity: z.enum(ACTIVITIES) });
const updateBody = z.object({
  active_ms: z.number().min(0).max(24 * 3_600_000),
  end_reason: z.enum(END_REASONS).optional(),
  ended_ago_ms: z.number().min(0).max(24 * 3_600_000).optional(),
});
// quiz_retake is logged by the server when a retake starts, never by the app
const SECTION_EVENTS = ['section_simplify', 'section_translate'];
const eventBody = z
  .object({
    type: z.enum(EVENT_TYPES.filter((t) => t !== 'quiz_retake')),
    lesson_id: id.nullable().optional(),
    attempt_id: id.nullable().optional(),
    section_index: z.number().int().min(0).max(10_000).nullable().optional(),
  })
  .refine((e) => !SECTION_EVENTS.includes(e.type) || (e.lesson_id && e.section_index !== undefined && e.section_index !== null), {
    message: 'section events need lesson_id and section_index',
  });

// Study sessions and self-monitoring events, both for the participant in X-Participant. Mounted at /api.
export function sessionsRouter({ db, clock = () => new Date() }) {
  const router = Router();
  const config = () => loadSchedulerConfig(db);

  router.post('/sessions', (req, res) => {
    const { id: participantId } = requireParticipant(db, req);
    const body = startBody.safeParse(req.body ?? {});
    if (!body.success) throw new HttpError(400, 'Send lesson_id (a lesson id, or null for All lessons) and activity (reading, flashcards or quiz).');
    res.status(201).json({ session: startSession(db, { participantId, lessonId: body.data.lesson_id, activity: body.data.activity, now: clock(), config: config() }) });
  });

  router.post('/sessions/:id', (req, res) => {
    const { id: participantId } = requireParticipant(db, req);
    const sessionId = id.safeParse(req.params.id);
    if (!sessionId.success) throw new HttpError(400, 'Session id must be a positive number.');
    const body = updateBody.safeParse(req.body ?? {});
    if (!body.success) throw new HttpError(400, 'Send active_ms, and to end the session end_reason (left, idle, background or switched).');
    const { active_ms: activeMs, end_reason: endReason, ended_ago_ms: endedAgoMs } = body.data;
    res.json({ session: updateSession(db, { id: sessionId.data, participantId, activeMs, endReason, endedAgoMs, now: clock() }) });
  });

  router.post('/events', (req, res) => {
    const { id: participantId } = requireParticipant(db, req);
    const body = eventBody.safeParse(req.body ?? {});
    if (!body.success) throw new HttpError(400, 'Send type (stats_view, review_flashcards_tap, section_simplify or section_translate); section events also need lesson_id and section_index.');
    const e = body.data;
    if (e.lesson_id && !db.prepare('SELECT 1 FROM lessons WHERE id = ?').get(e.lesson_id)) throw new HttpError(404, 'Lesson not found.');
    const eventId = logEvent(db, {
      participantId,
      type: e.type,
      lessonId: e.lesson_id ?? null,
      attemptId: e.attempt_id ?? null,
      sectionIndex: e.section_index ?? null,
      now: clock(),
      config: config(),
    });
    res.status(201).json({ id: eventId });
  });

  router.post('/setting-events', (req, res) => {
    const { id: participantId } = requireParticipant(db, req);
    const body = settingEventBody.safeParse(req.body ?? {});
    if (!body.success) throw new HttpError(400, 'Send setting (motion) and its value (system, less or full).');
    const id = logSettingEvent(db, { participantId, ...body.data, now: clock(), config: config() });
    res.status(201).json({ id });
  });

  return router;
}
