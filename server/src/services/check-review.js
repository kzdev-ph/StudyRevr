// The AI exam reviewer's look at the quick checks under each section (the quiz_review stage, after the cards; admin's
// Review again). Like the card review: one call per 12 sections; a flagged check is written again once (one call for
// the lesson, grounded like a new one by pipeline/quick-checks.js; one that comes back unchanged counts as failed) and
// the sections that changed are reviewed again; what is still flagged then, or could not be written again, is dropped
// from the section. Cached by a hash of the section text and its checks (`sections.check_review`, migration 014), so a
// section is reviewed again only when they change. A section whose checks change loses its cached Filipino/Taglish
// version, which holds translated copies of them.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { mapLimit } from '../ai/pool.js';
import { quickCheckReviewPrompt } from '../ai/prompts.js';
import { askAgain } from '../pipeline/quick-checks.js';
import { contextForBatch } from './quiz-review.js';

export const CHECK_FLAGS = ['not_in_lesson', 'not_answered', 'vague'];
export const CHECK_REVIEW_LABEL = 'the quick check review';
export const CHECK_REWRITE_LABEL = 'the quick checks the review flagged';
export const CHECK_ROUND2_LABEL = 'the quick check review (after fixes)';
const BATCH_SIZE = 12;

const sha = (s) => createHash('sha1').update(s).digest('hex');
const parse = (s, fallback) => {
  try {
    return JSON.parse(s) ?? fallback;
  } catch {
    return fallback;
  }
};
const plainChecks = (checks) => checks.map((c) => ({ question: c.question, answer: c.answer, ...(c.evidence ? { evidence: c.evidence } : {}) }));
export const checksHash = (section, checks) => sha(JSON.stringify([section.content, checks.map((c) => [c.question, c.answer, c.evidence ?? ''])]));

// Every section with quick checks, with its saved review: [{ section, checks, hash, review, saved }]
export function checkItems(db, lessonId) {
  return db
    .prepare('SELECT id, position, title, content, check_questions, check_review FROM sections WHERE lesson_id = ? ORDER BY position')
    .all(lessonId)
    .map((section) => {
      const checks = parse(section.check_questions, []);
      const review = parse(section.check_review, null);
      const hash = checksHash(section, checks);
      return { section, checks, hash, review, saved: review?.hash === hash };
    })
    .filter((x) => Array.isArray(x.checks) && x.checks.length);
}

// The sections whose quick checks have no review of what they show now (what the stage has left to do).
export const checksToReview = (db, lessonId) => checkItems(db, lessonId).filter((x) => !x.saved);

// Admin's "Review again": every section's checks are reviewed again (the checks dropped before stay dropped).
export function resetChecks(db, lessonId) {
  return db.prepare("UPDATE sections SET check_review = json_set(check_review, '$.hash', '') WHERE lesson_id = ? AND check_review IS NOT NULL AND json_valid(check_review)").run(lessonId).changes;
}

// For admin's lesson row, in quick checks: { reviewed, pending, dropped }
export function checkSummary(db, lessonId) {
  const items = checkItems(db, lessonId);
  const dropped = db
    .prepare('SELECT check_review FROM sections WHERE lesson_id = ? AND check_review IS NOT NULL')
    .all(lessonId)
    .reduce((n, r) => n + (parse(r.check_review, {}).dropped?.length ?? 0), 0);
  const count = (list) => list.reduce((n, x) => n + x.checks.length, 0);
  return { reviewed: count(items.filter((x) => x.saved)), pending: count(items.filter((x) => !x.saved)), dropped };
}

const why = z.string().trim().max(300).catch('');
const flagSchema = z.object({ q: z.coerce.number().int(), flag: z.enum(CHECK_FLAGS), why });
const replySchema = z.preprocess(
  (v) => (Array.isArray(v) ? { sections: v } : v),
  z.object({
    sections: z.array(
      z.object({
        n: z.coerce.number().int(),
        checks: z
          .array(z.unknown())
          .catch([])
          .transform((list) => list.map((f) => flagSchema.safeParse(f)).filter((r) => r.success).map((r) => r.data)),
      }),
    ),
  }),
);
const responseSchema = {
  name: 'quick_check_review',
  schema: {
    type: 'object',
    properties: {
      sections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            n: { type: 'integer' },
            checks: { type: 'array', items: { type: 'object', properties: { q: { type: 'integer' }, flag: { type: 'string', enum: CHECK_FLAGS }, why: { type: 'string' } }, required: ['q', 'flag', 'why'] } },
          },
          required: ['n', 'checks'],
        },
      },
    },
    required: ['sections'],
  },
};

// One review call per batch of `items` ([{ section, checks }]). -> Map(section id -> [[{ flag, why }] per check]) for
// the sections answered; a failed batch is left out (and its error returned).
async function review({ ai, items, rawText, concurrency, label, log, lessonId }) {
  const batches = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) batches.push(items.slice(i, i + BATCH_SIZE));
  const out = new Map();
  let error = null;
  await mapLimit(batches, concurrency, async (batch) => {
    try {
      const sections = batch.map((x, i) => ({ n: i + 1, title: x.section.title, content: x.section.content, checks: x.checks.map((c, j) => ({ q: j + 1, ...c })) }));
      const { system, user } = quickCheckReviewPrompt({ sections, text: contextForBatch(rawText, batch.flatMap((x) => x.checks.map((c) => c.evidence ?? ''))) });
      const reply = await ai.generateJSON({ system, user, schema: replySchema, responseSchema, maxTokens: 3000, label });
      for (const [i, x] of batch.entries()) {
        // a section left out of a reply that parsed has nothing flagged (lesson 12: the reviewer listed only the
        // sections with flags, and none had any)
        const answered = reply.sections.find((s) => s.n === i + 1);
        const flags = x.checks.map(() => []);
        for (const f of answered?.checks ?? []) if (flags[f.q - 1] && !flags[f.q - 1].some((g) => g.flag === f.flag)) flags[f.q - 1].push({ flag: f.flag, why: f.why });
        out.set(x.section.id, flags);
      }
    } catch (err) {
      error ??= err.message;
      log.warn(`[check-review] lesson ${lessonId}: reviewing the quick checks of ${batch.length} section(s) failed: ${err.message}`);
    }
  });
  return { flags: out, error };
}

const reasons = (flags) => flags.map((f) => (f.why ? `${f.flag}: ${f.why}` : f.flag)).join('; ');

// Reviews the quick checks of every section whose review is missing or out of date. -> { reviewed, flagged,
// rewritten, dropped, error } (counts in quick checks)
export async function reviewChecks({ db, ai, lessonId, concurrency = 1, madeBy = null, log = console, now = () => new Date() }) {
  const rawText = db.prepare('SELECT raw_text FROM lessons WHERE id = ?').get(lessonId)?.raw_text ?? '';
  const made = madeBy?.model ? `${madeBy.provider}/${madeBy.model}` : null;
  const pending = checksToReview(db, lessonId);
  const result = { reviewed: 0, flagged: 0, rewritten: 0, dropped: 0, error: null };
  if (!pending.length) return result;

  const first = await review({ ai, items: pending, rawText, concurrency, label: CHECK_REVIEW_LABEL, log, lessonId });
  result.error = first.error;
  const answered = pending.filter((x) => first.flags.has(x.section.id));
  result.reviewed = answered.reduce((n, x) => n + x.checks.length, 0);

  // the one fix round: every flagged check written again in one call
  const fixes = [];
  for (const x of answered) {
    first.flags.get(x.section.id).forEach((flags, i) => flags.length && fixes.push({ x, i, section: x.section, check: x.checks[i], why: reasons(flags) }));
  }
  result.flagged = fixes.length;
  const onDrop = ({ section, question, reason }) => log.info?.(`[check-review] lesson ${lessonId}: quick check "${question}" under "${section}" not written again (${reason})`);
  const again = await askAgain({ ai, items: fixes, rawText, label: CHECK_REWRITE_LABEL, onDrop });

  // per section: the checks after the fix round, and what was dropped
  const outcome = new Map(
    answered.map((x) => {
      const dropped = [];
      let rewritten = false;
      const checks = x.checks
        .map((c, i) => {
          const k = fixes.findIndex((f) => f.x === x && f.i === i);
          if (k < 0) return c;
          if (again.checks[k]) return (rewritten = true), again.checks[k];
          dropped.push({ question: c.question, answer: c.answer, why: fixes[k].why });
          return null;
        })
        .filter(Boolean);
      return [x.section.id, { x, checks, dropped, rewritten, flags: fixes.filter((f) => f.x === x).map((f) => ({ question: f.check.question, why: f.why })), round: 1 }];
    }),
  );
  result.rewritten = again.checks.filter(Boolean).length;

  // round 2: the sections with a check written again; what is still flagged is dropped
  const changed = [...outcome.values()].filter((o) => o.rewritten);
  if (changed.length) {
    const second = await review({ ai, items: changed.map((o) => ({ section: o.x.section, checks: o.checks })), rawText, concurrency, label: CHECK_ROUND2_LABEL, log, lessonId });
    result.error ??= second.error;
    for (const o of changed) {
      const flags = second.flags.get(o.x.section.id);
      o.round = 2;
      if (!flags) {
        o.unreviewed = true; // the round-2 call failed: saved, but reviewed again next time
        continue;
      }
      o.flags = [];
      o.checks = o.checks.filter((c, i) => {
        if (!flags[i]?.length) return true;
        o.flags.push({ question: c.question, why: reasons(flags[i]) });
        o.dropped.push({ question: c.question, answer: c.answer, why: reasons(flags[i]) });
        return false;
      });
    }
  }

  // saved per section, only if nothing changed it during the calls
  const at = now().toISOString();
  db.transaction(() => {
    const read = db.prepare('SELECT content, check_questions, check_review FROM sections WHERE id = ?');
    for (const o of outcome.values()) {
      const current = read.get(o.x.section.id);
      if (!current || current.content !== o.x.section.content || current.check_questions !== o.x.section.check_questions) continue;
      const before = parse(current.check_review, {});
      const checks = plainChecks(o.checks);
      const text = JSON.stringify(checks);
      const same = text === JSON.stringify(plainChecks(o.x.checks));
      const reviewRow = {
        hash: o.unreviewed ? '' : checksHash(o.x.section, checks),
        round: o.round,
        flags: o.flags,
        dropped: [...(before.dropped ?? []), ...o.dropped],
        made_by: made,
        reviewed_at: at,
      };
      if (same) db.prepare('UPDATE sections SET check_review = ? WHERE id = ?').run(JSON.stringify(reviewRow), o.x.section.id);
      else db.prepare('UPDATE sections SET check_questions = ?, check_review = ?, filipino_version = NULL, filipino_made_by = NULL WHERE id = ?').run(text, JSON.stringify(reviewRow), o.x.section.id);
      result.dropped += o.dropped.length;
    }
  })();
  log.info?.(
    `[check-review] lesson ${lessonId}: reviewed ${result.reviewed} quick check(s), ${result.flagged} flagged; ${result.rewritten} written again, ${result.dropped} dropped`,
  );
  return result;
}
