import { termKey } from '../pipeline/terms.js';

// Turning a lesson's flashcards into quiz questions. Pure: the caller passes the cards, the saved wrong answers and a
// `random` function (tests pass a seeded one), so the same inputs always give the same quiz.
//
//   term card     multiple choice "which term matches this definition?"; the wrong options are other key terms of the
//                 same lesson. With fewer than 3 other terms: true / false.
//   concept card  multiple choice with the 3 wrong answers the AI made for it (quiz_distractors). With fewer:
//                 true / false, where the false statement is a saved wrong answer or, with none saved, another card's
//                 answer from the same lesson.
// About 3 in 10 questions are true / false for variety, even when every card could be multiple choice.

export const QUIZ_LENGTH = 10;
export const TF_SHARE = 0.3;
export const TF_CHOICES = ['True', 'False'];
const WRONG_PER_QUESTION = 3;

// Two answers are the same when they match ignoring case and surrounding (or repeated) spaces.
const plain = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
export const sameAnswer = (a, b) => plain(a) === plain(b);

// Wrong answers that can be shown next to `correct`: no blanks, none equal to it or to each other, at most `limit`.
export function usableWrong(wrong, correct, limit = WRONG_PER_QUESTION) {
  const kept = [];
  for (const w of wrong ?? []) {
    const text = String(w ?? '').trim();
    if (!text || sameAnswer(text, correct) || kept.some((k) => sameAnswer(k, text))) continue;
    kept.push(text);
    if (kept.length === limit) break;
  }
  return kept;
}

export function shuffle(list, random = Math.random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const pickOne = (list, random) => list[Math.floor(random() * list.length)];

// Options in a random order, with the index of the right one.
function arrange(correct, wrong, random) {
  const choices = shuffle([correct, ...wrong], random);
  return { choices, answer_index: choices.indexOf(correct) };
}

// What each card can become. -> { card, mcWrong (3 or fewer), falsePool (statements that are false for it) }
function plan(cards, { distractors, extraTerms }) {
  const names = new Map(); // termKey -> spelling, from term cards first, then key terms without a card
  for (const name of [...cards.filter((c) => c.kind === 'term').map((c) => c.front), ...extraTerms]) {
    const key = termKey(name);
    if (key && !names.has(key)) names.set(key, String(name).trim());
  }
  // Other cards' answers, same kind first: a term's definition reads more believably next to a term.
  const otherAnswers = (card) =>
    usableWrong(
      [...cards.filter((c) => c.kind === card.kind), ...cards.filter((c) => c.kind !== card.kind)].filter((c) => c.id !== card.id).map((c) => c.back),
      card.back,
      Infinity,
    );

  return cards.map((card) => {
    if (card.kind === 'term') {
      const own = termKey(card.front);
      const mcWrong = [...names].filter(([key]) => key !== own).map(([, name]) => name);
      return { card, mcWrong: usableWrong(mcWrong, card.front, Infinity), falsePool: otherAnswers(card) };
    }
    const saved = usableWrong(distractors.get(card.id), card.back);
    return { card, mcWrong: saved, falsePool: saved.length ? saved : otherAnswers(card) };
  });
}

function multipleChoice({ card, mcWrong }, random) {
  const wrong = shuffle(mcWrong, random).slice(0, WRONG_PER_QUESTION);
  const term = card.kind === 'term';
  const correct = term ? card.front : card.back;
  return {
    flashcard_id: card.id,
    type: 'mc',
    kind: card.kind,
    question: term ? card.back : card.front,
    statement: null,
    ...arrange(correct, wrong, random),
    answer_text: correct,
    evidence: card.evidence ?? null,
  };
}

function trueFalse({ card, falsePool }, random) {
  const truth = random() < 0.5;
  return {
    flashcard_id: card.id,
    type: 'tf',
    kind: card.kind,
    question: card.front,
    statement: truth ? card.back : pickOne(falsePool, random),
    choices: TF_CHOICES,
    answer_index: truth ? 0 : 1,
    answer_text: card.back,
    evidence: card.evidence ?? null,
  };
}

// How many questions a lesson's cards support (a card needs something to be wrong against).
export function usableCount(cards, opts = {}) {
  return plan(cards, { distractors: new Map(), extraTerms: [], ...opts }).filter((p) => p.mcWrong.length >= WRONG_PER_QUESTION || p.falsePool.length).length;
}

// cards: [{ id, kind, front, back, evidence }]; distractors: Map card id -> [wrong answer]; extraTerms: key-term names
// that have no card. -> questions in the order they are asked:
//   [{ flashcard_id, type 'mc'|'tf', kind, question, statement, choices, answer_index, answer_text, evidence }]
export function buildQuiz({ cards, distractors = new Map(), extraTerms = [], count = QUIZ_LENGTH, random = Math.random }) {
  const usable = plan(cards, { distractors, extraTerms }).filter((p) => p.mcWrong.length >= WRONG_PER_QUESTION || p.falsePool.length);
  const picked = shuffle(usable, random).slice(0, count);
  const canMc = (p) => p.mcWrong.length >= WRONG_PER_QUESTION;
  const forced = picked.filter((p) => !canMc(p)).length;
  const variety = picked.length >= 4 ? Math.round(picked.length * TF_SHARE) : 0;
  const extraTf = new Set(shuffle(picked.filter(canMc), random).slice(0, Math.max(0, variety - forced)));
  return picked.map((p) => (canMc(p) && !extraTf.has(p) ? multipleChoice(p, random) : trueFalse(p, random)));
}

// A retake: the same questions in a new order, multiple-choice options shuffled again (true / false stays True, False).
export function reshuffle(questions, random = Math.random) {
  return shuffle(questions, random).map((q) => {
    if (q.type !== 'mc') return { ...q };
    const correct = q.choices[q.answer_index];
    const choices = shuffle(q.choices, random);
    return { ...q, choices, answer_index: choices.indexOf(correct) };
  });
}
