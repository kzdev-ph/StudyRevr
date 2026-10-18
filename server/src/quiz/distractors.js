import { z } from 'zod';
import { mapLimit } from '../ai/pool.js';
import { distractorsPrompt } from '../ai/prompts.js';
import { contextForBatch } from '../pipeline/evidence.js';
import { hasText, quizCandidates, usableWrong } from './build.js';
import { listGroups, siblingItems } from './list-items.js';
import { answerInQuestion, cardLeaks, language, lessonWords as lessonWordsOf, optionSetProblems, wrongOptionProblems } from './leaks.js';

// Wrong answer options for a lesson's concept cards: made by the AI as the last step of lesson processing (the
// pipeline's `quiz_options` stage), saved in quiz_distractors and reused from then on. Starting a quiz calls the same
// function as a fallback for any card still without them (an older lesson, or a failed stage). Cards are sent in
// batches of at most BATCH_SIZE so each call stays well inside the provider's timeout. A batch that fails is not
// saved, so the next quiz asks again; a batch that worked but gave nothing usable for a card saves [] for it (that
// card is asked as true / false).
//
// Every reply is checked in code with the quiz's leak rules (leaks.js): a wrong answer that is negative or reversed
// next to a positive right answer, much shorter or longer, in another language or about nothing in the lesson is
// dropped, and a set of 3 where the right answer still stands out (only it echoes the question, the wrong ones all
// open alike, near-duplicates) is not used. Cards left without a clean set get ONE follow-up call that says what was
// wrong; whatever is clean after it is saved, and a set still not clean then is marked settled. The processing stage
// and the admin retry also remake saved sets that fail these checks (`includeFailing`), but not settled ones; a quiz
// start never calls the AI for them: the quiz builder leaves them out.

export const BATCH_SIZE = 15;
const MAX_WRONG_WORDS = 40; // same cap as a flashcard answer
const WRONG_PER_QUESTION = 3;

const replySchema = z.object({
  items: z.array(z.object({ n: z.coerce.number().int(), wrong: z.array(z.string()).catch([]).transform((list) => list.filter(hasText)) })),
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
const lessonTextOf = (db, lessonId) => db.prepare('SELECT raw_text FROM lessons WHERE id = ?').get(lessonId)?.raw_text ?? '';
const cardFields = ({ id, front, back, evidence }) => ({ id, front, back, evidence });

// Concept cards of the lesson that have no saved wrong answers yet, except cards the quiz never asks (the question
// holds the answer, or the answer only restates it: wrong answers would not help them). With { includeFailing }, also
// those whose saved set the quiz can't use for multiple choice (quizCandidates in build.js), except those same cards
// and a settled set: one that still failed after the follow-up call, so asking again would only spend AI calls (see
// migration 010).
export function cardsNeedingDistractors(db, lessonId, { includeFailing = false } = {}) {
  const rows = db
    .prepare(
      `SELECT f.id, f.kind, f.front, f.back, f.evidence, d.flashcard_id IS NOT NULL AS has_saved, d.settled FROM flashcards f
       LEFT JOIN quiz_distractors d ON d.flashcard_id = f.id WHERE f.lesson_id = ? AND f.kind = 'concept' ORDER BY f.position, f.id`,
    )
    .all(lessonId);
  // a card whose question holds its answer (a) or whose answer only restates it (k) is never asked: no wrong answers;
  // nor a list item, whose wrong options are the other items of its list (quiz/list-items.js)
  const lessonText = lessonTextOf(db, lessonId);
  const groups = listGroups(lessonText);
  const askable = (r) => !answerInQuestion(r.front, r.back) && !cardLeaks(r).some((p) => p.rule === 'k' || p.rule === 'l') && !siblingItems(groups, r.back);
  if (!includeFailing) return rows.filter((r) => !r.has_saved && askable(r)).map(cardFields);
  const candidates = quizCandidates(rows, { distractors: loadDistractors(db, lessonId), lessonText });
  const failing = new Set(
    candidates
      .filter((p) => p.card.has_saved && !p.card.settled && p.mcClean.length < WRONG_PER_QUESTION && askable(p.card))
      .map((p) => p.card.id),
  );
  return rows.filter((r) => (!r.has_saved && askable(r)) || failing.has(r.id)).map(cardFields);
}

// Map card id -> [wrong answer] for every saved row of the lesson.
export function loadDistractors(db, lessonId) {
  const rows = db.prepare('SELECT d.flashcard_id, d.choices FROM quiz_distractors d JOIN flashcards f ON f.id = d.flashcard_id WHERE f.lesson_id = ?').all(lessonId);
  return new Map(rows.map((r) => [r.flashcard_id, JSON.parse(r.choices).filter(hasText)]));
}

// The first 3 of `clean` that make a set where the right answer doesn't stand out. -> { wrong, ok, problems }; when
// none does, `wrong` is the first 3 clean ones (still saved, for true / false) and `problems` say why. `lessonWords`
// as for optionSetProblems.
export function pickWrongSet(question, correct, clean, lessonWords = null) {
  let first = [];
  for (let i = 0; i < clean.length; i++)
    for (let j = i + 1; j < clean.length; j++)
      for (let k = j + 1; k < clean.length; k++) {
        const set = [clean[i], clean[j], clean[k]];
        const problems = optionSetProblems(question, correct, set, { lessonWords });
        if (!problems.length) return { wrong: set, ok: true, problems: [] };
        if (!first.length) first = problems;
      }
  return { wrong: clean.slice(0, WRONG_PER_QUESTION), ok: false, problems: first };
}

// One card's wrong answers through the per-option checks. -> { clean: [text], rejected: [{ text, why }] }
export function checkWrong(list, correct, lessonWords = null, otherAnswers = []) {
  const clean = [];
  const rejected = [];
  for (const w of usableWrong(list, correct, Infinity)) {
    const problems = wordCount(w) > MAX_WRONG_WORDS ? [{ detail: `over ${MAX_WRONG_WORDS} words` }] : wrongOptionProblems(w, correct, { lessonWords, otherAnswers });
    if (problems.length) rejected.push({ text: w, why: problems.map((p) => p.detail).join('; ') });
    else clean.push(w);
  }
  return { clean, rejected };
}

// One call for `cards`. `earlier` (card id -> the first try's result) makes it the follow-up: the prompt shows what
// was rejected and why, and the clean answers from the first try are kept behind the new ones. `rawText`: the lesson,
// sent with the cards (contextForBatch) so wrong answers come from what it says about other items of the same kind.
// -> [{ card, wrong, ok, problems, clean, rejected }]
async function makeBatch({ ai, cards, keyTerms, answers, lessonWords, rawText = '', earlier = null, label: callLabel = null }) {
  const numbered = cards.map((c, i) => {
    const before = earlier?.get(c.id);
    return {
      n: i + 1,
      question: c.front,
      answer: c.back,
      evidence: c.evidence,
      words: wordCount(c.back),
      language: language(c.back),
      ...(before ? { keep: before.clean, rejected: before.rejected, problems: before.problems.map((p) => p.detail) } : {}),
    };
  });
  const text = contextForBatch(rawText, cards.map((c) => c.evidence));
  const { system, user } = distractorsPrompt({ cards: numbered, keyTerms, text, wholeLesson: text === String(rawText ?? '') });
  const label = callLabel ?? (earlier ? 'the quiz answer options (second try)' : 'the quiz answer options');
  const reply = await ai.generateJSON({ system, user, schema: replySchema, responseSchema, maxTokens: 4000, label });
  const byN = new Map(reply.items.map((item) => [item.n, item.wrong]));
  return cards.map((card, i) => {
    const { clean, rejected } = checkWrong([...(byN.get(i + 1) ?? []), ...(earlier?.get(card.id)?.clean ?? [])], card.back, lessonWords, answers.filter((a) => a.id !== card.id).map((a) => a.back));
    return { card, clean, rejected, ...pickWrongSet(card.front, card.back, clean, lessonWords) };
  });
}

const running = new WeakMap(); // db -> Map(lesson id -> { promise, includeFailing })

// Makes and saves wrong answers for every concept card of the lesson that has none (with { includeFailing }, also
// remakes saved sets the quiz can't use). While a run for the lesson is in flight, another call (a quiz started
// during a retry, two quick starts) waits for it instead of asking the AI again; a call that includes failing sets
// and finds a run that doesn't waits for it and then runs its own. `onProgress({ done, total })` counts finished
// batches; it is only passed on to the call that starts the run.
// -> { made: number of cards saved, error: message of the first failed batch, or null }
export function ensureDistractors(options) {
  const { db, lessonId, includeFailing = false } = options;
  if (!running.has(db)) running.set(db, new Map());
  const byLesson = running.get(db);
  const current = byLesson.get(lessonId);
  if (current && (current.includeFailing || !includeFailing)) return current.promise;
  const start = current ? current.promise.catch(() => {}).then(() => makeDistractors(options)) : makeDistractors(options);
  const entry = { includeFailing, promise: null };
  entry.promise = start.finally(() => {
    if (byLesson.get(lessonId) === entry) byLesson.delete(lessonId);
  });
  byLesson.set(lessonId, entry);
  return entry.promise;
}

// Saves each card's new wrong answers. A card deleted or written again while the call ran (lesson deleted, cards remade,
// "Regenerate this card") is skipped: these wrong answers were made for its old text. -> how many were saved
function saveResults(db, results, now) {
  const save = db.prepare('INSERT OR REPLACE INTO quiz_distractors (flashcard_id, choices, made_at, settled) VALUES (?, ?, ?, ?)');
  let made = 0;
  db.transaction(() => {
    for (const { card, wrong, settled } of results) {
      const nowCard = db.prepare('SELECT front, back FROM flashcards WHERE id = ?').get(card.id);
      if (nowCard?.front === card.front && nowCard.back === card.back) made += save.run(card.id, JSON.stringify(wrong.filter(hasText)), now().toISOString(), settled ? 1 : 0).changes;
    }
  })();
  return made;
}

// The AI review's one fix for wrong answers it flagged (services/quiz-review.js): ONE call per batch, like the
// follow-up above, with the reviewer's reasons as the rejected answers and the unflagged ones kept. Whatever is
// clean is saved; a set still not clean is settled. `fixes`: [{ card: { id, front, back, evidence }, keep: [text],
// rejected: [{ text, why }] }]. -> { made, error }
export async function remakeFlagged({ db, ai, lessonId, fixes, concurrency = 1, batchSize = BATCH_SIZE, now = () => new Date(), log = console }) {
  if (!fixes.length) return { made: 0, error: null };
  const rawText = lessonTextOf(db, lessonId);
  const lessonWords = lessonWordsOf(rawText);
  const keyTerms = db.prepare('SELECT term FROM key_terms WHERE lesson_id = ? ORDER BY id').all(lessonId).map((t) => t.term);
  const answers = db.prepare("SELECT id, back FROM flashcards WHERE lesson_id = ? AND kind <> 'term'").all(lessonId);
  const batches = [];
  for (let i = 0; i < fixes.length; i += batchSize) batches.push(fixes.slice(i, i + batchSize));
  let made = 0;
  let error = null;
  await mapLimit(batches, concurrency, async (batch) => {
    try {
      const earlier = new Map(batch.map((x) => [x.card.id, { clean: x.keep, rejected: x.rejected, problems: [] }]));
      const results = await makeBatch({ ai, cards: batch.map((x) => x.card), keyTerms, answers, lessonWords, rawText, earlier, label: 'the quiz answer options (after review)' });
      made += saveResults(db, results.map((r) => ({ ...r, settled: !r.ok })), now);
    } catch (err) {
      error ??= err.message;
      log.warn(`[quiz-review] lesson ${lessonId}: remaking ${batch.length} flagged set(s) failed: ${err.message}`);
    }
  });
  return { made, error };
}

async function makeDistractors({ db, ai, lessonId, includeFailing = false, concurrency = 1, batchSize = BATCH_SIZE, now = () => new Date(), log = console, onProgress }) {
  const cards = cardsNeedingDistractors(db, lessonId, { includeFailing });
  if (!cards.length) return { made: 0, error: null };
  const rawText = lessonTextOf(db, lessonId);
  const lessonWords = lessonWordsOf(rawText);
  const keyTerms = db.prepare('SELECT term FROM key_terms WHERE lesson_id = ? ORDER BY id').all(lessonId).map((t) => t.term);
  // the lesson's concept answers: a wrong answer that is another card's answer is dropped (it answers that question)
  const answers = db.prepare("SELECT id, back FROM flashcards WHERE lesson_id = ? AND kind <> 'term'").all(lessonId);
  const batches = [];
  for (let i = 0; i < cards.length; i += batchSize) batches.push(cards.slice(i, i + batchSize));

  let made = 0;
  let error = null;
  let done = 0;
  onProgress?.({ done, total: batches.length });
  await mapLimit(batches, concurrency, async (batch) => {
    try {
      let results = await makeBatch({ ai, cards: batch, keyTerms, answers, lessonWords, rawText });
      const retry = results.filter((r) => !r.ok);
      if (retry.length) {
        for (const r of retry) {
          const why = [...r.rejected.map((x) => `"${x.text}": ${x.why}`), ...r.problems.map((p) => p.detail)].join(' | ') || `${r.clean.length} wrong answer(s)`;
          log.info?.(`[quiz] lesson ${lessonId}, card ${r.card.id}: asking again (${why})`);
        }
        try {
          const again = await makeBatch({ ai, cards: retry.map((r) => r.card), keyTerms, answers, lessonWords, rawText, earlier: new Map(retry.map((r) => [r.card.id, r])) });
          // still not clean after the follow-up: settled, so a later remake or retry doesn't ask for it again
          const byId = new Map(again.map((r) => [r.card.id, { ...r, settled: !r.ok }]));
          results = results.map((r) => byId.get(r.card.id) ?? r);
        } catch (err) {
          // the first try's clean answers are still saved; the card is asked as true / false until a retry
          log.warn(`[quiz] lesson ${lessonId}: the second try for ${retry.length} card(s) failed: ${err.message}`);
        }
      }
      made += saveResults(db, results, now);
      const short = results.filter((r) => !r.ok).length;
      if (short) log.warn(`[quiz] lesson ${lessonId}: ${short} card(s) got no clean set of 3 wrong answers; they are asked as true / false`);
    } catch (err) {
      error ??= err.message;
      log.warn(`[quiz] lesson ${lessonId}: wrong answers for ${batch.length} card(s) failed: ${err.message}`);
    }
    onProgress?.({ done: ++done, total: batches.length });
  });
  return { made, error };
}
