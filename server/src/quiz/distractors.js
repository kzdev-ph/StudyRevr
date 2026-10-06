import { z } from 'zod';
import { mapLimit } from '../ai/pool.js';
import { distractorsPrompt } from '../ai/prompts.js';
import { usableWrong } from './build.js';

// Wrong answer options for a lesson's concept cards: made by the AI the first time the lesson is quizzed, saved in
// quiz_distractors and reused from then on. Cards are sent in batches of at most BATCH_SIZE so each call stays well
// inside the provider's timeout. A batch that fails is not saved, so the next quiz asks again; a batch that worked but
// gave nothing usable for a card saves [] for it (that card is asked as true / false).

export const BATCH_SIZE = 15;
const MAX_WRONG_WORDS = 40; // same cap as a flashcard answer

const replySchema = z.object({
  items: z.array(z.object({ n: z.coerce.number().int(), wrong: z.array(z.string()).catch([]) })),
});
const str = { type: 'string' };
const responseSchema = {
  name: 'quiz_wrong_answers',
  schema: {
    type: 'object',
    properties: { items: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, wrong: { type: 'array', items: str } }, required: ['n', 'wrong'] } } },
    required: ['items'],
  },
};

const wordCount = (s) => (String(s).match(/\S+/g) ?? []).length;

// Concept cards of the lesson that have no saved wrong answers yet.
export function cardsNeedingDistractors(db, lessonId) {
  return db
    .prepare(
      `SELECT f.id, f.front, f.back, f.evidence FROM flashcards f LEFT JOIN quiz_distractors d ON d.flashcard_id = f.id
       WHERE f.lesson_id = ? AND f.kind = 'concept' AND d.flashcard_id IS NULL ORDER BY f.position, f.id`,
    )
    .all(lessonId);
}

// Map card id -> [wrong answer] for every saved row of the lesson.
export function loadDistractors(db, lessonId) {
  const rows = db.prepare('SELECT d.flashcard_id, d.choices FROM quiz_distractors d JOIN flashcards f ON f.id = d.flashcard_id WHERE f.lesson_id = ?').all(lessonId);
  return new Map(rows.map((r) => [r.flashcard_id, JSON.parse(r.choices)]));
}

async function makeBatch({ ai, cards, keyTerms }) {
  const numbered = cards.map((c, i) => ({ n: i + 1, question: c.front, answer: c.back, evidence: c.evidence }));
  const { system, user } = distractorsPrompt({ cards: numbered, keyTerms });
  const reply = await ai.generateJSON({ system, user, schema: replySchema, responseSchema, maxTokens: 4000, label: 'the quiz answer options' });
  const byN = new Map(reply.items.map((item) => [item.n, item.wrong]));
  return cards.map((card, i) => ({
    card,
    wrong: usableWrong((byN.get(i + 1) ?? []).filter((w) => wordCount(w) <= MAX_WRONG_WORDS), card.back),
  }));
}

// Makes and saves wrong answers for every concept card of the lesson that has none.
// -> { made: number of cards saved, error: message of the first failed batch, or null }
export async function ensureDistractors({ db, ai, lessonId, concurrency = 1, batchSize = BATCH_SIZE, now = () => new Date(), log = console }) {
  const cards = cardsNeedingDistractors(db, lessonId);
  if (!cards.length) return { made: 0, error: null };
  const keyTerms = db.prepare('SELECT term FROM key_terms WHERE lesson_id = ? ORDER BY id').all(lessonId).map((t) => t.term);
  const batches = [];
  for (let i = 0; i < cards.length; i += batchSize) batches.push(cards.slice(i, i + batchSize));

  const save = db.prepare('INSERT OR REPLACE INTO quiz_distractors (flashcard_id, choices, made_at) VALUES (?, ?, ?)');
  let made = 0;
  let error = null;
  await mapLimit(batches, concurrency, async (batch) => {
    try {
      const results = await makeBatch({ ai, cards: batch, keyTerms });
      db.transaction(() => {
        // a card deleted while the call ran (lesson deleted, cards remade) is skipped
        for (const { card, wrong } of results) {
          if (db.prepare('SELECT 1 FROM flashcards WHERE id = ?').get(card.id)) made += save.run(card.id, JSON.stringify(wrong), now().toISOString()).changes;
        }
      })();
      const short = results.filter((r) => r.wrong.length < 3).length;
      if (short) log.warn(`[quiz] lesson ${lessonId}: ${short} card(s) got fewer than 3 usable wrong answers; they are asked as true / false`);
    } catch (err) {
      error ??= err.message;
      log.warn(`[quiz] lesson ${lessonId}: wrong answers for ${batch.length} card(s) failed: ${err.message}`);
    }
  });
  return { made, error };
}
