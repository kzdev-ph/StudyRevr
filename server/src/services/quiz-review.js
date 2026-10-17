import { z } from 'zod';
import { mapLimit } from '../ai/pool.js';
import { quizReviewPrompt, regenerateCardsPrompt } from '../ai/prompts.js';
import { comparable } from '../pipeline/evidence.js';
import { termKey } from '../pipeline/terms.js';
import { quizCandidates } from '../quiz/build.js';
import { usableFamilies } from '../quiz/related.js';
import { ensureDistractors, loadDistractors, remakeFlagged } from '../quiz/distractors.js';
import { listGroups, siblingItems } from '../quiz/list-items.js';
import { CARD_FLAGS, cardHash, itemHash, OPTION_FLAGS, readReview, SET_FLAGS, TRUE_FLAGS } from '../quiz/review-flags.js';
import { checkNewCard } from './regenerate-card.js';
import { hasRecords, participantRecords } from './lesson-records.js';

// The AI exam reviewer: the pipeline's `quiz_review` stage (after quiz_options) and admin's "Review again". The code
// checks (quiz/leaks.js) catch words that give an answer away; this catches meaning: a wrong option that is also right
// by the lesson, a caricature, a vague question, an answer that adds words the lesson doesn't use. Every card the quiz
// can ask is shown with all the forms it can be asked in (its multiple-choice options and Yes/No statements), in
// batches of BATCH_SIZE cards, one call each, with the admin Default (the pipeline's client, never a student key).
//
// What is flagged is made again ONCE: flagged wrong options of a concept card in one call per batch (remakeFlagged),
// flagged cards in one call per batch (regenerateCardsPrompt; not once participants other than P00 have records on
// the lesson). The parts made again are reviewed once more (round 2), and whatever is still flagged then is simply left
// out of the quiz (quiz/build.js). A term card's flagged options (other key terms) and a giveaway true statement have
// nothing to make again: they are left out at once.
//
// Results are saved per card in quiz_reviews (migration 013) with a hash of everything the reviewer saw, so a card is
// reviewed again only when what the quiz would show changes. The first batch also groups the key terms into families
// (lessons.term_families), which the quiz never uses as wrong options for each other (quiz/related.js).

export const BATCH_SIZE = 12;
const CONTEXT_CHARS = 16000;
const MAX_WHY = 200;
const REVIEW_LABEL = 'the quiz review';
const ROUND2_LABEL = 'the quiz review (after fixes)';
const CARDS_LABEL = 'the flashcards the quiz review flagged';

const flagSchema = z.object({ flag: z.string(), why: z.string().catch('') });
const flagList = z.array(z.unknown()).catch([]);
const replySchema = z.object({
  items: z.array(
    z.object({
      n: z.coerce.number().int(),
      card: flagList,
      set: flagList,
      true_statement: flagList,
      options: flagList,
    }),
  ),
  families: z.array(z.array(z.string()).catch([])).catch([]),
});
const str = { type: 'string' };
const flagJson = { type: 'array', items: { type: 'object', properties: { flag: str, why: str }, required: ['flag', 'why'] } };
const responseSchema = (withFamilies) => ({
  name: 'quiz_review',
  schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            n: { type: 'integer' },
            card: flagJson,
            set: flagJson,
            true_statement: flagJson,
            options: { type: 'array', items: { type: 'object', properties: { o: { type: 'integer' }, flag: str, why: str }, required: ['o', 'flag', 'why'] } },
          },
          required: ['n', 'card', 'set', 'true_statement', 'options'],
        },
      },
      ...(withFamilies ? { families: { type: 'array', items: { type: 'array', items: str } } } : {}),
    },
    required: withFamilies ? ['items', 'families'] : ['items'],
  },
});

const cardsReply = z.object({
  cards: z.array(
    z.object({
      n: z.coerce.number().int(),
      question: z.string().optional().catch(undefined),
      answer: z.string().optional().catch(undefined),
      evidence: z.string().catch(''),
      definition: z.string().optional().catch(undefined),
    }),
  ),
});

// Only the flags each part can have, each with a short reason; anything else the model says is ignored.
function cleanFlags(list, allowed) {
  const out = [];
  for (const raw of list) {
    const parsed = flagSchema.safeParse(raw);
    if (!parsed.success || !allowed.includes(parsed.data.flag)) continue;
    if (out.some((f) => f.flag === parsed.data.flag)) continue;
    out.push({ flag: parsed.data.flag, why: parsed.data.why.trim().slice(0, MAX_WHY) });
  }
  return out;
}

// The lesson for one call: all of it when short, else the blocks around the batch's quotes (one on each side).
export function contextForBatch(rawText, evidences) {
  const text = String(rawText ?? '');
  if (text.length <= CONTEXT_CHARS) return text;
  const blocks = text.split(/\n\s*\n/);
  const keys = blocks.map(comparable);
  const keep = new Set();
  for (const evidence of evidences) {
    const key = comparable(evidence ?? '');
    const at = key ? keys.findIndex((b) => b.includes(key)) : -1;
    if (at >= 0) for (const i of [at - 1, at, at + 1]) if (i >= 0 && i < blocks.length) keep.add(i);
  }
  if (!keep.size) return text.slice(0, CONTEXT_CHARS);
  return [...keep]
    .sort((a, b) => a - b)
    .map((i) => blocks[i])
    .join('\n\n')
    .slice(0, CONTEXT_CHARS * 2);
}

const lessonCards = (db, lessonId) => db.prepare('SELECT id, kind, front, back, evidence FROM flashcards WHERE lesson_id = ? ORDER BY position, id').all(lessonId);
const keyTermNames = (db, lessonId) => db.prepare('SELECT term FROM key_terms WHERE lesson_id = ? ORDER BY id').all(lessonId).map((t) => t.term);
const rawTextOf = (db, lessonId) => db.prepare('SELECT raw_text FROM lessons WHERE id = ?').get(lessonId)?.raw_text ?? '';

// What the reviewer is shown for one candidate (quizCandidates without families or reviews, so it doesn't change with
// the review's own result). A term card is asked by its definition: the question is the definition, the answer the term.
function itemFor(p) {
  const term = p.card.kind === 'term';
  const mc = new Set(p.mcCode);
  const tf = new Set(p.falseClean);
  const options = p.reviewable.map((text) => ({ text, use: mc.has(text) && tf.has(text) ? 'both' : mc.has(text) ? 'mc' : 'yes_no' }));
  return {
    kind: p.card.kind,
    question: term ? p.shown : p.card.front,
    answer: term ? p.card.front : p.card.back,
    true_statement: p.shown,
    evidence: p.card.evidence ?? '',
    options,
  };
}

// Every card the quiz can ask, with what the reviewer would be shown. -> [{ card, item, hash, saved (readReview or null) }]
export function reviewItems(db, lessonId) {
  const cards = lessonCards(db, lessonId);
  const candidates = quizCandidates(cards, { distractors: loadDistractors(db, lessonId), extraTerms: keyTermNames(db, lessonId), lessonText: rawTextOf(db, lessonId) });
  const rows = new Map(db.prepare('SELECT * FROM quiz_reviews WHERE lesson_id = ?').all(lessonId).map((r) => [r.flashcard_id, r]));
  return candidates
    .filter((p) => p.reviewable.length && !p.problems.some((x) => ['a', 'k', 'd'].includes(x.rule)))
    .map((p) => {
      const item = itemFor(p);
      const hash = itemHash({ ...item, options: item.options.map((o) => o.text) });
      const row = rows.get(p.card.id);
      const fresh = row && row.card_hash === cardHash(p.card) && row.item_hash === hash;
      return { card: p.card, item, hash, saved: fresh ? readReview(row) : null };
    });
}

// The cards whose review is missing or out of date (what the stage has left to do).
export const itemsToReview = (db, lessonId) => reviewItems(db, lessonId).filter((x) => !x.saved);

// Admin's "Review again": every card of the lesson is reviewed again, with one more fix round.
export function resetReviews(db, lessonId) {
  return db.prepare("UPDATE quiz_reviews SET item_hash = '' WHERE lesson_id = ?").run(lessonId).changes;
}

// For admin's lesson list: { reviewed, flagged, pending } (flagged = reviewed cards with any flag still in force).
export function reviewSummary(db, lessonId) {
  const items = reviewItems(db, lessonId);
  const saved = items.filter((x) => x.saved);
  const flagged = saved.filter(({ saved: r }) => r.card.length || r.set.length || r.trueStatement.length || r.options.size).length;
  return { reviewed: saved.length, flagged, pending: items.length - saved.length };
}

// One review call for `batch` ([{ card, item, hash }]); `terms` only for the first batch. Saves a row per card answered
// (a card written again meanwhile is skipped) and the families. -> [{ card, item, flags }] for the cards saved
async function reviewBatch({ db, ai, lessonId, batch, terms, round, madeBy, rawText, now, label }) {
  const items = batch.map((x, i) => ({ n: i + 1, ...x.item, options: x.item.options.map((o, j) => ({ o: j + 1, ...o })) }));
  const { system, user } = quizReviewPrompt({ items, terms, text: contextForBatch(rawText, batch.map((x) => x.card.evidence)) });
  const reply = await ai.generateJSON({ system, user, schema: replySchema, responseSchema: responseSchema(terms.length > 0), maxTokens: 4000, label });
  const byN = new Map(reply.items.map((it) => [it.n, it]));

  const results = [];
  for (const [i, x] of batch.entries()) {
    const it = byN.get(i + 1);
    if (!it) continue; // left out of the reply: reviewed again next time
    const options = {};
    for (const raw of it.options) {
      const o = z.object({ o: z.coerce.number().int() }).safeParse(raw);
      const text = o.success ? x.item.options[o.data.o - 1]?.text : null;
      const flags = text ? cleanFlags([raw], OPTION_FLAGS) : [];
      if (flags.length) options[text] = [...(options[text] ?? []), ...flags.filter((f) => !(options[text] ?? []).some((g) => g.flag === f.flag))];
    }
    results.push({ ...x, flags: { card: cleanFlags(it.card, CARD_FLAGS), set: cleanFlags(it.set, SET_FLAGS), trueStatement: cleanFlags(it.true_statement, TRUE_FLAGS), options } });
  }

  const save = db.prepare(
    `INSERT OR REPLACE INTO quiz_reviews (flashcard_id, lesson_id, card_hash, item_hash, card_flags, set_flags, true_flags, option_flags, round, made_by, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const saved = [];
  db.transaction(() => {
    for (const r of results) {
      const current = db.prepare('SELECT front, back FROM flashcards WHERE id = ?').get(r.card.id);
      if (current?.front !== r.card.front || current.back !== r.card.back) continue;
      save.run(r.card.id, lessonId, cardHash(r.card), r.hash, JSON.stringify(r.flags.card), JSON.stringify(r.flags.set), JSON.stringify(r.flags.trueStatement), JSON.stringify(r.flags.options), round, madeBy, now().toISOString());
      saved.push(r);
    }
    if (terms.length) {
      // only the lesson's own terms, in groups of two or more different terms, and not a term with its kinds or two
      // kinds of one thing (usableFamilies)
      const byKey = new Map(terms.map((t) => [termKey(t), t]));
      const raw = reply.families
        .map((group) => [...new Map(group.map((t) => [termKey(t), byKey.get(termKey(t))]).filter(([k, t]) => k && t)).values()])
        .filter((group) => group.length >= 2);
      db.prepare('UPDATE lessons SET term_families = ? WHERE id = ?').run(JSON.stringify(usableFamilies(raw)), lessonId);
    }
  })();
  return saved;
}

const hasFlags = (f) => f.card.length || f.set.length || f.trueStatement.length || Object.keys(f.options).length;

// The flagged cards written again: one call per batch, each new card checked like admin's Regenerate (checkNewCard)
// and saved in place (same id; its saved wrong answers deleted). Nothing is saved once participants other than P00
// have records on the lesson. -> ids of the cards written again
async function regenerateFlagged({ db, ai, lessonId, fixes, rawText, concurrency, log }) {
  const all = db.prepare('SELECT id, kind, front, back FROM flashcards WHERE lesson_id = ?').all(lessonId);
  const batches = [];
  for (let i = 0; i < fixes.length; i += BATCH_SIZE) batches.push(fixes.slice(i, i + BATCH_SIZE));
  const changed = [];
  let error = null;
  await mapLimit(batches, concurrency, async (batch) => {
    try {
      const ids = new Set(batch.map((f) => f.card.id));
      const others = all.filter((c) => !ids.has(c.id) && c.kind !== 'term').map((c) => c.back);
      const cards = batch.map((f, i) => ({ n: i + 1, ...f.card, problems: f.problems }));
      const { system, user } = regenerateCardsPrompt({ cards, text: contextForBatch(rawText, batch.map((f) => f.card.evidence)), others });
      const reply = await ai.generateJSON({ system, user, schema: cardsReply, maxTokens: 4000, label: CARDS_LABEL });
      const byN = new Map(reply.cards.map((c) => [c.n, c]));
      const next = [];
      for (const [i, f] of batch.entries()) {
        const r = byN.get(i + 1);
        const term = f.card.kind === 'term';
        if (!r || (term ? !r.definition?.trim() : !r.question?.trim() || !r.answer?.trim())) continue;
        try {
          // checked against every other card as it is now, the ones written again in this run included
          const rest = all.filter((c) => c.id !== f.card.id);
          next.push(checkNewCard({ card: f.card, reply: term ? { definition: r.definition } : r, rawText, others: rest }));
          Object.assign(all.find((c) => c.id === f.card.id), next.at(-1));
        } catch (err) {
          log.info?.(`[quiz-review] lesson ${lessonId}: card ${f.card.id} not written again (${err.message})`);
        }
      }
      db.transaction(() => {
        // checked where it is saved: a participant may have started during the call
        if (hasRecords(participantRecords(db, lessonId))) return;
        for (const card of next) {
          const old = batch.find((f) => f.card.id === card.id).card;
          const current = db.prepare('SELECT front, back FROM flashcards WHERE id = ?').get(card.id);
          if (current?.front !== old.front || current.back !== old.back) continue;
          db.prepare('UPDATE flashcards SET front = ?, back = ?, evidence = ? WHERE id = ?').run(card.front, card.back, card.evidence, card.id);
          db.prepare('DELETE FROM quiz_distractors WHERE flashcard_id = ?').run(card.id);
          changed.push(card.id);
          log.info?.(`[quiz-review] lesson ${lessonId}: card ${card.id} written again ("${old.front}" -> "${card.front}")`);
        }
      })();
    } catch (err) {
      error ??= err.message;
      log.warn(`[quiz-review] lesson ${lessonId}: writing ${batch.length} flagged card(s) again failed: ${err.message}`);
    }
  });
  return { changed, error };
}

const reason = (flags) => flags.map((f) => (f.why ? `${f.flag}: ${f.why}` : f.flag));

// Reviews every card whose review is missing or out of date, makes the flagged parts again once and reviews those
// again. `madeBy` ({ provider, model }, the admin Default) is saved with each review. Batches that worked are saved, so
// a retry only reviews the rest. -> { reviewed, flagged, regenerated, remade, error }
export async function reviewQuiz({ db, ai, lessonId, concurrency = 1, madeBy = null, log = console, onProgress, now = () => new Date() }) {
  const rawText = rawTextOf(db, lessonId);
  const made = madeBy?.model ? `${madeBy.provider}/${madeBy.model}` : null;
  const terms = keyTermNames(db, lessonId);
  const groups = listGroups(rawText);
  let error = null;
  let done = 0;
  let total = 0;

  const run = async (pending, round, label) => {
    const batches = [];
    for (let i = 0; i < pending.length; i += BATCH_SIZE) batches.push(pending.slice(i, i + BATCH_SIZE));
    total += batches.length;
    onProgress?.({ done, total });
    const results = [];
    await mapLimit(batches, concurrency, async (batch, i) => {
      try {
        const withTerms = round === 1 && i === 0 && terms.length >= 2 ? terms : [];
        results.push(...(await reviewBatch({ db, ai, lessonId, batch, terms: withTerms, round, madeBy: made, rawText, now, label })));
      } catch (err) {
        error ??= err.message;
        log.warn(`[quiz-review] lesson ${lessonId}: reviewing ${batch.length} card(s) failed: ${err.message}`);
      }
      onProgress?.({ done: ++done, total });
    });
    return results;
  };

  const first = await run(itemsToReview(db, lessonId), 1, REVIEW_LABEL);
  const flagged = first.filter((r) => hasFlags(r.flags));
  for (const r of flagged) log.info?.(`[quiz-review] lesson ${lessonId}, card ${r.card.id} flagged: ${JSON.stringify(r.flags)}`);

  // the one fix round
  const studied = hasRecords(participantRecords(db, lessonId));
  const cardFixes = [];
  const optionFixes = [];
  for (const r of flagged) {
    const answerWrong = r.flags.trueStatement.filter((f) => f.flag === 'not_in_lesson');
    if (r.flags.card.length || answerWrong.length) {
      if (!studied) cardFixes.push({ card: r.card, problems: reason([...r.flags.card, ...answerWrong]) });
      continue;
    }
    // a term card's options are other key terms, a list item's the other items of its list: nothing to make again
    if (r.card.kind === 'term' || siblingItems(groups, r.card.back)) continue;
    const saved = loadDistractors(db, lessonId).get(r.card.id) ?? [];
    const mcOptions = r.item.options.filter((o) => o.use !== 'yes_no').map((o) => o.text);
    const rejected = [];
    if (r.flags.set.length) rejected.push(...mcOptions.map((text) => ({ text, why: reason(r.flags.set).join('; ') })));
    for (const [text, flags] of Object.entries(r.flags.options)) if (saved.includes(text) && !rejected.some((x) => x.text === text)) rejected.push({ text, why: reason(flags).join('; ') });
    if (!rejected.length) continue;
    const keep = r.flags.set.length ? [] : saved.filter((t) => !rejected.some((x) => x.text === t));
    optionFixes.push({ card: { id: r.card.id, front: r.card.front, back: r.card.back, evidence: r.card.evidence }, keep, rejected });
  }
  if (studied && flagged.some((r) => r.flags.card.length)) log.info?.(`[quiz-review] lesson ${lessonId}: participants have records, so flagged cards are left out instead of written again`);

  const remade = await remakeFlagged({ db, ai, lessonId, fixes: optionFixes, concurrency, log, now });
  error ??= remade.error;
  const regenerated = await regenerateFlagged({ db, ai, lessonId, fixes: cardFixes, rawText, concurrency, log });
  error ??= regenerated.error;
  if (regenerated.changed.some((id) => lessonCards(db, lessonId).find((c) => c.id === id)?.kind !== 'term')) {
    // a concept card written again needs new wrong answers before it is reviewed again
    const filled = await ensureDistractors({ db, ai, lessonId, concurrency, log, now });
    error ??= filled.error;
  }

  // round 2: only what was made again; what is still flagged then stays left out
  const fixed = new Set([...optionFixes.map((f) => f.card.id), ...regenerated.changed]);
  const second = fixed.size ? await run(itemsToReview(db, lessonId).filter((x) => fixed.has(x.card.id)), 2, ROUND2_LABEL) : [];

  const stillFlagged = second.filter((r) => hasFlags(r.flags)).length;
  log.info?.(
    `[quiz-review] lesson ${lessonId}: reviewed ${first.length} card(s), ${flagged.length} flagged; ${regenerated.changed.length} card(s) written again, ` +
      `${optionFixes.length} option set(s) remade; ${second.length} reviewed again, ${stillFlagged} still flagged (left out of the quiz)`,
  );
  return { reviewed: first.length, flagged: flagged.length, regenerated: regenerated.changed.length, remade: remade.made, error };
}
