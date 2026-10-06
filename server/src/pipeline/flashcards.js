import { z } from 'zod';
import { estimateTokens } from '../ai/chunk.js';
import { mapLimit } from '../ai/pool.js';
import { flashcardsPrompt } from '../ai/prompts.js';
import { checkEvidence, comparable } from './evidence.js';
import { singular } from './terms.js';

// Flashcards for one lesson: "term -> definition" cards made straight from the (already grounded) key terms, plus
// "question -> answer" concept cards the AI writes per chunk of lesson text. Every card keeps a verbatim evidence
// quote from the lesson, checked in code the same way as key terms; a card that fails is dropped and reported.

export const ANSWER_WORDS = 25; // what the prompt asks for
const MAX_ANSWER_WORDS = 40; // past this a "card" is a paragraph, not something to recall
const MAX_QUESTION_WORDS = 40;
const WORDS_PER_CARD = 50;
const MIN_CARDS = 5;
const EXTRA = 1.25; // ask for a few more concept cards than needed: some are dropped or merged

const wordList = (s) => String(s ?? '').match(/\S+/g) ?? [];

// How many cards a lesson gets: about one per 50 words of lesson text, at least 5, at most `max` (setting).
export const targetCardCount = (wordCount, max) => Math.min(max, Math.max(MIN_CARDS, Math.round(wordCount / WORDS_PER_CARD)));

// A long key-term definition is cut to its first sentence when that sentence can stand alone.
export function shortDefinition(definition) {
  const text = String(definition).trim();
  if (wordList(text).length <= ANSWER_WORDS) return text;
  const first = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/)[0];
  const n = wordList(first).length;
  return n >= 4 && n <= MAX_ANSWER_WORDS ? first : text;
}

// Key terms -> term cards. The term's evidence is checked again against the whole lesson (`sourceKey`).
export function termCards(keyTerms, { sourceKey, onDrop = () => {} }) {
  const cards = [];
  for (const t of keyTerms) {
    const back = shortDefinition(t.definition);
    const check = checkEvidence({ term: t.term, evidence: t.evidence, sourceKey });
    if (!check.ok) onDrop({ front: t.term, reason: check.reason });
    else if (wordList(back).length > MAX_ANSWER_WORDS) onDrop({ front: t.term, reason: 'answer too long to recall' });
    else cards.push({ kind: 'term', front: t.term, back, evidence: check.evidence });
  }
  return cards;
}

// ---- de-duplication ---------------------------------------------------------------------------------------------

const STOP = new Set(
  'a an the of to in on at for and or nor but is are was were be been being it its this that these those what which who whom whose how why when where does do did can could should would will may might define definition meaning mean means term called refer refers referred by with as from into than then there their about give example name list explain describe'.split(
    ' ',
  ),
);
const contentWords = (s) => new Set((String(s).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(singular).filter((w) => !STOP.has(w)));
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
};
const sameSet = (a, b) => a.size === b.size && [...a].every((w) => b.has(w));

// Two cards ask the same thing when they quote the same evidence (case, spacing and punctuation ignored), when their
// fronts have the same content words ("What is a hypothesis?" and the term card "Hypothesis"), when their fronts
// nearly match, or when front and back together mostly overlap.
export function isDuplicate(a, b) {
  if (a.evidence && b.evidence && comparable(a.evidence) === comparable(b.evidence)) return true;
  const fa = contentWords(a.front);
  const fb = contentWords(b.front);
  if (fa.size && sameSet(fa, fb)) return true;
  if (jaccard(fa, fb) >= 0.8) return true;
  return jaccard(contentWords(`${a.front} ${a.back}`), contentWords(`${b.front} ${b.back}`)) >= 0.6;
}

// Keeps one card of each group of duplicates: a term card over a concept card, otherwise the first.
// -> { kept, dropped: [{ card, duplicateOf }] }, each list in input order within its kind (term cards first).
export function dedupeCards(cards) {
  const kept = [];
  const dropped = [];
  const ordered = [...cards.filter((c) => c.kind === 'term'), ...cards.filter((c) => c.kind !== 'term')];
  for (const card of ordered) {
    const twin = kept.find((k) => isDuplicate(k, card));
    if (twin) dropped.push({ card, duplicateOf: twin });
    else kept.push(card);
  }
  return { kept, dropped };
}

// ---- concept cards ----------------------------------------------------------------------------------------------

const cardsSchema = z.preprocess(
  (v) => (Array.isArray(v) ? { cards: v } : v),
  z.object({
    cards: z.array(
      z.object({
        question: z.string().trim().min(1),
        answer: z.string().trim().min(1),
        evidence: z.string().trim().catch(''), // a missing quote drops that card, not the whole reply
      }),
    ),
  }),
);
const str = { type: 'string' };
const responseSchema = {
  name: 'flashcards',
  schema: {
    type: 'object',
    properties: {
      cards: { type: 'array', items: { type: 'object', properties: { question: str, answer: str, evidence: str }, required: ['question', 'answer', 'evidence'] } },
    },
    required: ['cards'],
  },
};

// The review sections written from a chunk, as a guide for its call. A section belongs to a chunk when its sources
// are slides / pages of that chunk; without sources it can only be placed when the lesson is a single chunk. The
// guide is left out when it would be bigger than half the chunk (small local models have little room).
function reviewFor(chunk, sections, single) {
  const mine = sections.filter((s) => (s.sources ? chunk.numbers && s.sources.some((n) => chunk.numbers.includes(n)) : single));
  if (!mine.length) return null;
  const text = mine.map((s) => `${s.title}\n${s.content}`).join('\n\n');
  return estimateTokens(text) <= Math.max(600, chunk.tokens / 2) ? text : mine.map((s) => `- ${s.title}`).join('\n');
}

const partLabel = (i, n) => `the flashcards${n > 1 ? ` (part ${i + 1} of ${n})` : ''}`;

// One AI call per chunk (in parallel, up to `concurrency`), each asked for its share of `target` cards by length.
// -> concept cards in lesson order; each one passed the evidence and length checks against its own chunk.
export async function generateConceptCards({ ai, chunks, sections = [], keyTerms = [], target, concurrency = 1, onProgress = () => {}, onDrop = () => {} }) {
  if (target <= 0 || !chunks.length) {
    onProgress({ done: 0, total: 0 });
    return [];
  }
  const totalTokens = chunks.reduce((n, c) => n + c.tokens, 0) || 1;
  let done = 0;
  onProgress({ done, total: chunks.length });
  const lists = await mapLimit(chunks, concurrency, async (chunk, i, ctx) => {
    const targetCards = Math.max(2, Math.round((target * EXTRA * chunk.tokens) / totalTokens));
    const { system, user } = flashcardsPrompt({
      text: chunk.text,
      review: reviewFor(chunk, sections, chunks.length === 1),
      keyTerms,
      index: chunk.index,
      total: chunks.length,
      targetCards,
    });
    const out = await ai.generateJSON({
      system,
      user,
      schema: cardsSchema,
      responseSchema,
      maxTokens: Math.min(8000, 600 + targetCards * 160),
      label: partLabel(i, chunks.length),
    });
    const sourceKey = comparable(chunk.text);
    const cards = [];
    for (const c of out.cards) {
      const reject = (reason) => onDrop({ front: c.question, reason });
      if (wordList(c.answer).length > MAX_ANSWER_WORDS) reject('answer too long to recall');
      else if (wordList(c.question).length > MAX_QUESTION_WORDS) reject('question too long');
      else {
        const check = checkEvidence({ term: c.question, evidence: c.evidence, sourceKey });
        if (check.ok) cards.push({ kind: 'concept', front: c.question, back: c.answer, evidence: check.evidence });
        else reject(check.reason);
      }
    }
    if (!ctx.stopped()) onProgress({ done: ++done, total: chunks.length });
    return cards;
  });
  return lists.flat();
}

// Spreads the term cards evenly through the concept cards (both lists keep their order), so new cards come in a mix.
export function interleave(terms, concepts) {
  const out = [];
  let t = 0;
  let c = 0;
  while (t < terms.length || c < concepts.length) {
    const termTurn = c >= concepts.length || (t < terms.length && t / terms.length <= c / concepts.length);
    out.push(termTurn ? terms[t++] : concepts[c++]);
  }
  return out;
}

// The whole set for a lesson. -> [{ kind, front, back, evidence }] in introduction order, at most `maxCards`.
// Term cards take at most half the target, so a term-heavy lesson still gets questions about how things work.
export async function generateFlashcards({ ai, chunks, lessonText, keyTerms = [], sections = [], wordCount, maxCards = 30, concurrency = 1, onProgress, onDrop = () => {} }) {
  const target = targetCardCount(wordCount, maxCards);
  const terms = termCards(keyTerms, { sourceKey: comparable(lessonText), onDrop });
  const termShare = Math.min(terms.length, Math.ceil(target / 2));
  const concepts = await generateConceptCards({
    ai,
    chunks,
    sections,
    keyTerms: terms.map((t) => t.front),
    target: target - termShare,
    concurrency,
    onProgress,
    onDrop,
  });

  const { kept, dropped } = dedupeCards([...terms, ...concepts]);
  for (const { card, duplicateOf } of dropped) onDrop({ front: card.front, reason: `duplicate of "${duplicateOf.front}"` });
  const keptTerms = kept.filter((c) => c.kind === 'term');
  const keptConcepts = kept.filter((c) => c.kind === 'concept');
  // fill the target: terms up to their share, concepts next, then more terms if concepts ran short
  const useTerms = Math.min(keptTerms.length, Math.max(termShare, target - keptConcepts.length));
  const useConcepts = Math.min(keptConcepts.length, target - useTerms);
  return interleave(keptTerms.slice(0, useTerms), keptConcepts.slice(0, useConcepts));
}
