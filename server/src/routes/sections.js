import { Router } from 'express';
import { z } from 'zod';
import { loadSchedulerConfig } from '../flashcards/config.js';
import { HttpError } from '../middleware/errors.js';
import { requireParticipant } from '../middleware/participant.js';
import { liveRewrite } from '../services/live-rewrite.js';
import { parseFilipino, parseSimple } from '../services/section-versions.js';
import { taglishShown } from '../services/settings.js';
import { readStudentKey, studentKeysAllowed } from '../services/student-ai.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
export const taglishOff = () => new HttpError(403, 'Filipino/Taglish is turned off right now.', { code: 'taglish_off' });

// On-demand rewrites of one section (Explain simpler, Filipino/Taglish). The shared version, made by the admin Default
// (on a first tap, or ahead of time by admin's "Prepare"), is cached in the sections row and served without an AI
// call. A student with their own key (when admin allows it) gets a fresh one from that key instead, which is not
// cached. Each live AI request goes through the fallback chain (services/live-rewrite.js) and is logged in ai_calls.
//
// Answer: { section_id, kind ('simple' | 'filipino'), version, cached, shared, answered_by, fallback }
//   cached       served from the shared version without an AI call
//   shared       the version is the shared one (everyone sees the same)
//   answered_by  { source: student | default | gemma, provider, model } for a live answer; null when cached
//   fallback     { steps, note } when a fallback answered (note: the line shown under the answer); else null
export function sectionsRouter({ ai, db, access, config = {}, clock = () => new Date() }) {
  const router = Router();
  const envAi = config.ai ?? {};

  const loadSection = (req, viewer) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) throw new HttpError(400, 'Section id must be a positive number.');
    const section = db
      .prepare(
        `SELECT s.id, s.lesson_id, s.position, s.title, s.content, s.simple_version, s.filipino_version, s.simple_made_by, s.filipino_made_by,
           s.check_questions, (SELECT COUNT(*) FROM sections o WHERE o.lesson_id = s.lesson_id AND (o.position < s.position OR (o.position = s.position AND o.id < s.id))) AS idx
         FROM sections s WHERE s.id = ?`,
      )
      .get(parsed.data.id);
    if (!section) throw new HttpError(404, 'Section not found.');
    // a section of a lesson the caller may not see is not found either
    if (!access.canSee(viewer, section.lesson_id)) throw new HttpError(404, 'Section not found.');
    return { ...section, index: section.idx, check_questions: JSON.parse(section.check_questions) };
  };

  const rewrite = (kind, apiKind, parse, column) => async (req, res, next) => {
    try {
      const viewer = access.viewerOf(req);
      const section = loadSection(req, viewer);
      const participant = requireParticipant(db, req); // no code, no AI call
      // admin's "Show Filipino/Taglish to students" is off: no student gets a version (Prepare still makes them)
      if (kind === 'translate' && !viewer.admin && !taglishShown(db)) throw taglishOff();
      const shared = parse(section[column]);
      const ownKey = participant && studentKeysAllowed(db) && readStudentKey(db, participant.id);
      if (shared && !ownKey) {
        return res.json({ section_id: section.id, kind: apiKind, version: shared, cached: true, shared: true, answered_by: null, fallback: null });
      }
      const made = await liveRewrite({ db, ai, envAi, section, kind, participant, shared, clock, schedulerConfig: loadSchedulerConfig(db) });
      res.json({ section_id: section.id, kind: apiKind, cached: false, ...made });
    } catch (e) {
      next(e);
    }
  };

  router.post('/:id/simplify', rewrite('simplify', 'simple', parseSimple, 'simple_version'));
  router.post('/:id/translate', rewrite('translate', 'filipino', parseFilipino, 'filipino_version'));

  return router;
}
