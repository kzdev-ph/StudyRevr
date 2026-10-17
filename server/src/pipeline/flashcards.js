import { z } from 'zod';
import { estimateTokens, NOTES_LABEL } from '../ai/chunk.js';
import { mapLimit } from '../ai/pool.js';
import { flashcardsPrompt } from '../ai/prompts.js';
import { cardLeaks, wordStems } from '../quiz/leaks.js';
import { checkEvidence, comparable } from './evidence.js';
import { singular } from './terms.js';

// Flashcards for one lesson: "term -> definition" cards made straight from the (already grounded) key terms, plus
// "question -> answer" concept cards the AI writes per chunk of lesson text. Every card keeps a verbatim evidence
// quote from the lesson, checked in code the same way as key terms; a card that fails is dropped and reported. So is
// a concept card that gives its own answer away (rules g, i, k in quiz/leaks.js: the question holds the answer, a
// yes/no or either/or question, the answer only restates the question) or another card's (rule j).

export const ANSWER_WORDS = 25; // what the prompt asks for
export const MAX_ANSWER_WORDS = 40; // past this a "card" is a paragraph, not something to recall
export const MAX_QUESTION_WORDS = 40;
const WORDS_PER_CARD = 50;
const MIN_CARDS = 5;
const EXTRA = 1.25; // ask for a few more concept cards than needed: some are dropped or merged

const wordList = (s) => String(s ?? '').match(/\S+/g) ?? [];

// How many cards a lesson gets: about one per 50 words of lesson text, at least 5, and at least one per key term and
// per list item the lesson stresses (`terms`, `items`); at most `max` (setting).
export const targetCardCount = (wordCount, max, { terms = 0, items = 0 } = {}) =>
  Math.min(max, Math.max(MIN_CARDS, Math.round(wordCount / WORDS_PER_CARD), terms + items));

const LIST_ITEM = /^(?:-|\d+[.)])\s+(.+)$/;
const MAX_ITEM_WORDS = 20; // a longer "item" is a paragraph set as a bullet, not a list item to recall

// The list items the lesson stresses: bullet and numbered lines on its slides or pages (not in the teacher's spoken
// notes, which only explain them), each once, in lesson order. A Word lesson's lists arrive the same way.
export function listItems(lessonText) {
  const items = [];
  const seen = new Set();
  for (const block of String(lessonText ?? '').split(/\n{2,}/)) {
    for (const line of block.split('\n')) {
      if (line.trim() === NOTES_LABEL) break;
      const text = LIST_ITEM.exec(line.trim())?.[1]?.trim();
      if (!text || wordList(text).length > MAX_ITEM_WORDS) continue;
      const key = comparable(text);
      if (key && !seen.has(key)) {
        seen.add(key);
        items.push(text);
      }
    }
  }
  return items;
}

const COVERED = 0.6; // share of an item's content words a card must hold to count as asking about it

// The items no card asks about: an item is covered by a card that quotes it as evidence or holds most of its words.
export function uncoveredItems(items, cards) {
  const keys = cards.map((c) => ({ evidence: comparable(c.evidence ?? ''), words: wordStems(`${c.front} ${c.back} ${c.evidence ?? ''}`) }));
  return items.filter((item) => {
    const key = comparable(item);
    const own = wordStems(item);
    return !keys.some((k) => {
      if (key && k.evidence.includes(key)) return true;
      if (!own.length) return false;
      const held = own.filter((forms) => k.words.some((w) => forms.some((f) => w.includes(f)))).length;
      return held / own.length >= COVERED;
    });
  });
}

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

// The first of rules g, i, k (gives its answer away) and l (asks by place in the list) a concept card breaks, or undefined.
const givesAnswerAway = (card) => cardLeaks({ kind: 'concept', ...card }).find((p) => ['g', 'i', 'k', 'l'].includes(p.rule));

const partLabel = (i, n) => `the flashcards${n > 1 ? ` (part ${i + 1} of ${n})` : ''}`;

// One AI call per chunk (in parallel, up to `concurrency`), each asked for its share of `target` cards by length.
// -> concept cards in lesson order; each one passed the evidence, length and leak checks against its own chunk.
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
    const cards = checkConceptCards(out.cards, comparable(chunk.text), onDrop);
    if (!ctx.stopped()) onProgress({ done: ++done, total: chunks.length });
    return cards;
  });
  return lists.flat();
}

// An AI reply's cards through the length, leak and evidence checks (evidence against `sourceKey`, the comparable text
// the call was given). A list item's quote may be short ("Builds confidence."), so 2 explaining words are enough.
function checkConceptCards(replyCards, sourceKey, onDrop) {
  const cards = [];
  for (const c of replyCards) {
    const reject = (reason) => onDrop({ front: c.question, reason });
    const leak = givesAnswerAway({ front: c.question, back: c.answer });
    if (wordList(c.answer).length > MAX_ANSWER_WORDS) reject('answer too long to recall');
    else if (wordList(c.question).length > MAX_QUESTION_WORDS) reject('question too long');
    else if (leak) reject(leak.rule === 'l' ? `${leak.detail} (l)` : `gives its answer away (${leak.rule}: ${leak.detail})`);
    else {
      const check = checkEvidence({ term: c.question, evidence: c.evidence, sourceKey, minExplaining: 2 });
      if (check.ok) cards.push({ kind: 'concept', front: c.question, back: c.answer, evidence: check.evidence });
      else reject(check.reason);
    }
  }
  return cards;
}

// The blocks of the lesson that hold `items` (each block once, in lesson order), as the text for the coverage call.
function blocksHolding(lessonText, items) {
  const keys = items.map(comparable);
  return String(lessonText ?? '')
    .split(/\n{2,}/)
    .filter((block) => {
      const key = comparable(block);
      return keys.some((k) => key.includes(k));
    })
    .join('\n\n');
}

// `cards` with each of `extra` put after the last card whose quote comes before its own in the lesson, so a coverage
// card sits beside its list's other cards.
export function placeInLesson(cards, extra, lessonText) {
  const sourceKey = comparable(lessonText);
  const at = (c) => sourceKey.indexOf(comparable(c.evidence ?? ''));
  const out = [...cards];
  for (const card of extra) {
    const where = at(card);
    let i = out.length;
    // term cards are only skipped: generateFlashcards interleaves them with the concept cards itself
    while (i > 0 && (out[i - 1].kind === 'term' || at(out[i - 1]) > where)) i--;
    out.splice(i, 0, card);
  }
  return out;
}

// The coverage follow-up: ONE call asking for a card for each list item no card covers yet (see listItems).
export async function coverItems({ ai, items, lessonText, keyTerms = [], onDrop = () => {} }) {
  const text = blocksHolding(lessonText, items);
  if (!items.length || !text) return [];
  const { system, user } = flashcardsPrompt({ text, keyTerms, index: 0, total: 1, targetCards: items.length, items });
  const out = await ai.generateJSON({
    system,
    user,
    schema: cardsSchema,
    responseSchema,
    maxTokens: Math.min(8000, 600 + items.length * 160),
    label: 'the flashcards for list items without a card',
  });
  return checkConceptCards(out.cards, comparable(lessonText), onDrop);
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
// The target counts every key term and every list item the lesson stresses (listItems), so the term cards fit beside a
// card per item; past that, term cards take at most half, so a term-heavy lesson still gets questions about how things
// work. After the per-chunk calls, list items no card asks about get ONE more call (coverItems).
export async function generateFlashcards({ ai, chunks, lessonText, keyTerms = [], sections = [], wordCount, maxCards = 30, concurrency = 1, onProgress = () => {}, onDrop = () => {} }) {
  const items = listItems(lessonText);
  const terms = termCards(keyTerms, { sourceKey: comparable(lessonText), onDrop });
  const target = targetCardCount(wordCount, maxCards, { terms: terms.length, items: items.length });
  const termShare = Math.min(terms.length, Math.max(Math.ceil(target / 2), target - items.length));
  const termNames = terms.map((t) => t.front);
  let calls = 0;
  const concepts = await generateConceptCards({
    ai,
    chunks,
    sections,
    keyTerms: termNames,
    target: target - termShare,
    concurrency,
    onProgress: (p) => {
      calls = p.total;
      onProgress(p);
    },
    onDrop,
  });

  // de-duplicated, without cards that give another card's answer away (rule j in quiz/leaks.js)
  const tidy = (cards) => {
    const { kept, dropped } = dedupeCards(cards);
    for (const { card, duplicateOf } of dropped) onDrop({ front: card.front, reason: `duplicate of "${duplicateOf.front}"` });
    return kept.filter((c) => {
      if (c.kind !== 'concept') return true;
      const leak = cardLeaks(c, kept).find((p) => p.rule === 'j');
      if (leak) onDrop({ front: c.front, reason: `gives another card's answer away (${leak.detail})` });
      return !leak;
    });
  };
  let kept = tidy([...terms, ...concepts]);
  let added = 0;
  const missing = uncoveredItems(items, kept);
  if (missing.length && kept.length < maxCards) {
    onProgress({ done: calls, total: calls + 1 });
    const extra = await coverItems({ ai, items: missing.slice(0, maxCards - kept.length), lessonText, keyTerms: termNames, onDrop });
    onProgress({ done: calls + 1, total: calls + 1 });
    const before = kept.length;
    kept = tidy(placeInLesson(kept, extra, lessonText));
    added = Math.max(0, kept.length - before);
  }
  const keptTerms = kept.filter((c) => c.kind === 'term');
  const keptConcepts = kept.filter((c) => c.kind === 'concept');
  // fill the target: terms up to their share, concepts next, then more terms if concepts ran short
  const useTerms = Math.min(keptTerms.length, Math.max(termShare, target - keptConcepts.length));
  const useCards = keptTerms.slice(0, useTerms);
  // A list item's card is never cut to fit the target: the cards the coverage call added get room beyond it (up to
  // the card limit), and inside the room a card that is the first to ask about an item goes before the others.
  const needed = new Set();
  for (const item of uncoveredItems(items, useCards)) {
    const card = keptConcepts.find((c) => !uncoveredItems([item], [c]).length);
    if (card) needed.add(card);
  }
  const room = Math.min(maxCards - useTerms, Math.max(target - useTerms + added, needed.size));
  const others = keptConcepts.filter((c) => !needed.has(c)).slice(0, Math.max(0, room - needed.size));
  const chosen = new Set([...[...needed].slice(0, room), ...others]);
  return interleave(useCards, keptConcepts.filter((c) => chosen.has(c)));
}
