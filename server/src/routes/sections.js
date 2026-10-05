import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/errors.js';
import { parseFilipino, parseSimple, simplifySection, translateSection } from '../services/section-versions.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

// On-demand rewrites of one section. The first request calls the AI and caches the result in the sections row;
// later requests (and a second tap while the first is still running) reuse it, so one section costs one call per kind.
export function sectionsRouter({ ai, db }) {
  const router = Router();
  const inflight = new Map(); // `${sectionId}:${kind}` -> Promise of the parsed version

  const loadSection = (req) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) throw new HttpError(400, 'Section id must be a positive number.');
    const section = db
      .prepare('SELECT id, lesson_id, title, content, simple_version, filipino_version, check_questions FROM sections WHERE id = ?')
      .get(parsed.data.id);
    if (!section) throw new HttpError(404, 'Section not found.');
    return { ...section, check_questions: JSON.parse(section.check_questions) };
  };

  const dedupe = (key, make) => {
    if (!inflight.has(key)) inflight.set(key, make().finally(() => inflight.delete(key)));
    return inflight.get(key);
  };

  router.post('/:id/simplify', async (req, res, next) => {
    try {
      const section = loadSection(req);
      const cached = parseSimple(section.simple_version);
      if (cached) return res.json({ section_id: section.id, kind: 'simple', version: cached, cached: true });
      const version = await dedupe(`${section.id}:simple`, async () => {
        const made = await simplifySection({ ai, section });
        db.prepare('UPDATE sections SET simple_version = ? WHERE id = ?').run(JSON.stringify(made), section.id);
        return made;
      });
      res.json({ section_id: section.id, kind: 'simple', version, cached: false });
    } catch (e) {
      next(e);
    }
  });

  router.post('/:id/translate', async (req, res, next) => {
    try {
      const section = loadSection(req);
      const cached = parseFilipino(section.filipino_version);
      if (cached) return res.json({ section_id: section.id, kind: 'filipino', version: cached, cached: true });
      const version = await dedupe(`${section.id}:filipino`, async () => {
        const keyTerms = db.prepare('SELECT term FROM key_terms WHERE lesson_id = ? ORDER BY id').all(section.lesson_id).map((t) => t.term);
        const made = await translateSection({ ai, section, keyTerms });
        db.prepare('UPDATE sections SET filipino_version = ? WHERE id = ?').run(JSON.stringify(made), section.id);
        return made;
      });
      res.json({ section_id: section.id, kind: 'filipino', version, cached: false });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
