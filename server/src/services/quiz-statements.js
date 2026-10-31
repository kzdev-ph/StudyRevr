import { z } from 'zod';
import { mapLimit } from '../ai/pool.js';
import { statementsPrompt } from '../ai/prompts.js';
import { language, lessonWords as lessonWordsOf } from '../quiz/leaks.js';
import { checkPair } from '../quiz/statements.js';
import { cardsNeedingStatements, NOT_IN_REPLY, saveStatements } from '../quiz/statement-store.js';
import { contextForBatch } from './quiz-review.js';

// The AI's True/False statements for a lesson's concept cards: for each card one TRUE sentence that states its answer
// and one FALSE twin (the same sentence with only the answer's part swapped), made as part of the pipeline's
// `quiz_options` stage and saved in quiz_statements (migration 021). Cards are sent in batches of at most BATCH_SIZE
// (about one call per lesson), each with the lesson text around the batch's quotes.
//
// Every reply is paired with its cards by number and checked in code (quiz/statements.js): a pair that passes is saved
// `pending` (the AI review then sets it ok or flagged), a pair that fails, or a card the reply left out, is saved
// `rejected` with its reason. A reply that matches none of the batch's numbers fails the batch: nothing is saved, so
// the cards are asked for again later. The quiz itself never calls this.

export const BATCH_SIZE = 25;
const LABEL = 'the quiz true/false statements';

const replySchema = z.object({
  items: z.array(z.object({ n: z.coerce.number().int(), true_statement: z.string().catch(''), false_statement: z.string().catch('') })),
});
const str = { type: 'string' };
const responseSchema = {
  name: 'quiz_true_false',
  schema: {
    type: 'object',
    properties: {
      items: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, true_statement: str, false_statement: str }, required: ['n', 'true_statement', 'false_statement'] } },
    },
    required: ['items'],
  },
};

// One call for `batch`. -> [{ card, trueText, falseText, status, why }], ready for saveStatements
async function makeBatch({ ai, batch, rawText, lessonWords, answers }) {
  const numbered = batch.map((c, i) => ({ n: i + 1, question: c.front, answer: c.back, evidence: c.evidence, language: language(c.back) }));
  const { system, user } = statementsPrompt({ cards: numbered, text: contextForBatch(rawText, batch.map((c) => c.evidence)) });
  const reply = await ai.generateJSON({ system, user, schema: replySchema, responseSchema, maxTokens: 4000, label: LABEL });
  const byN = new Map();
  for (const item of reply.items) if (!byN.has(item.n)) byN.set(item.n, item);
  if (!batch.some((_, i) => byN.has(i + 1))) throw new Error('the reply matched none of the cards');
  return batch.map((card, i) => {
    const item = byN.get(i + 1);
    if (!item) return { card, status: 'rejected', why: NOT_IN_REPLY };
    const pair = { true_statement: item.true_statement.trim(), false_statement: item.false_statement.trim() };
    const otherAnswers = answers.filter((a) => a.id !== card.id).map((a) => a.back);
    const { ok, problems } = checkPair(card, pair, { lessonWords, otherAnswers });
    if (!ok) return { card, status: 'rejected', why: problems.map((p) => p.detail).join('; ') };
    return { card, trueText: pair.true_statement, falseText: pair.false_statement, status: 'pending' };
  });
}

const running = new WeakMap(); // db -> Map(lesson id -> promise)

// Makes and saves a pair for every concept card of the lesson that has none for its current text. A card deleted or
// written again while the call ran is skipped (saveStatements). While a run for the lesson is in flight, another call
// (the admin button during a pipeline run) waits for it instead of asking the AI again. `onProgress({ done, total })`
// counts finished batches; it is only passed on to the call that starts the run.
// -> { made: pairs saved for review, rejected: rows saved as rejected, error: message of the first failed batch, or null }
export function ensureStatements(options) {
  const { db, lessonId } = options;
  if (!running.has(db)) running.set(db, new Map());
  const byLesson = running.get(db);
  const current = byLesson.get(lessonId);
  if (current) return current;
  const promise = makeStatements(options).finally(() => {
    if (byLesson.get(lessonId) === promise) byLesson.delete(lessonId);
  });
  byLesson.set(lessonId, promise);
  return promise;
}

async function makeStatements({ db, ai, lessonId, concurrency = 1, batchSize = BATCH_SIZE, now = () => new Date(), log = console, onProgress }) {
  const cards = cardsNeedingStatements(db, lessonId);
  if (!cards.length) return { made: 0, rejected: 0, error: null };
  const rawText = db.prepare('SELECT raw_text FROM lessons WHERE id = ?').get(lessonId)?.raw_text ?? '';
  const lessonWords = lessonWordsOf(rawText);
  // the lesson's concept answers: a changed part that is another card's answer is dropped (it answers that question)
  const answers = db.prepare("SELECT id, back FROM flashcards WHERE lesson_id = ? AND kind <> 'term'").all(lessonId);
  const batches = [];
  for (let i = 0; i < cards.length; i += batchSize) batches.push(cards.slice(i, i + batchSize));

  let made = 0;
  let rejected = 0;
  let error = null;
  let done = 0;
  onProgress?.({ done, total: batches.length });
  await mapLimit(batches, concurrency, async (batch) => {
    try {
      const results = await makeBatch({ ai, batch, rawText, lessonWords, answers });
      for (const r of results.filter((x) => x.status === 'rejected')) log.info?.(`[quiz] lesson ${lessonId}, card ${r.card.id}: no True/False pair (${r.why})`);
      // counts only what was saved: a card that changed or went away during the call is skipped
      for (const r of results) {
        if (!saveStatements(db, [r], now)) continue;
        if (r.status === 'pending') made++;
        else rejected++;
      }
    } catch (err) {
      error ??= err.message;
      log.warn(`[quiz] lesson ${lessonId}: True/False statements for ${batch.length} card(s) failed: ${err.message}`);
    }
    onProgress?.({ done: ++done, total: batches.length });
  });
  return { made, rejected, error };
}
