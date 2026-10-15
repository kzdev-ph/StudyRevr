import { termKey } from '../pipeline/terms.js';
import { answerInQuestion, cardLeaks, contentWords, falseStatementProblems, maskTerm, optionSetProblems, sameWord, wrongOptionProblems } from './leaks.js';

// Turning a lesson's flashcards into quiz questions. Pure: the caller passes the cards, the saved wrong answers and a
// `random` function (tests pass a seeded one), so the same inputs always give the same quiz.
//
//   term card     multiple choice "which term matches this definition?"; the wrong options are other key terms of the
//                 same lesson. With fewer than 3 other terms: true / false against another term card's definition.
//   concept card  multiple choice with the 3 wrong answers the AI made for it (quiz_distractors). With fewer:
//                 true / false, where the false statement is a saved wrong answer or, with none saved, another concept
//                 card's answer on the same subject (sharing a word with the question).
// About 3 in 10 questions are true / false for variety, even when every card could be multiple choice.
//
// Nothing that gives its answer away is asked (see leaks.js): a concept card whose question holds its answer is
// skipped; wrong options and false statements that stand out are left out, and a card with too few left is asked
// the other way or not at all. A definition that holds its own term is shown with the term blanked ("___"). So a
// lesson whose cards can't fill 10 clean questions gets a shorter quiz instead of leaking ones.

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

// What each card could be asked as, before and after the leak checks:
//   { card, shown (the text shown for its answer: a term's definition with the term blanked, else the answer),
//     mcWrong / falsePool (every candidate), mcClean / falseClean (what passed), problems (why the card itself or
//     its option set can't be used: [{ rule, detail }]) }
// `npm run quiz:check` reports the candidates; the quiz only uses mcClean and falseClean.
export function quizCandidates(cards, { distractors = new Map(), extraTerms = [], lessonText = null } = {}) {
  const lessonWords = lessonText ? new Set(contentWords(lessonText)) : null;
  const names = new Map(); // termKey -> spelling, from term cards first, then key terms without a card
  for (const name of [...cards.filter((c) => c.kind === 'term').map((c) => c.front), ...extraTerms]) {
    const key = termKey(name);
    if (key && !names.has(key)) names.set(key, String(name).trim());
  }
  const shown = (card) => (card.kind === 'term' ? maskTerm(card.back, card.front) : card.back);
  const termCards = cards.filter((c) => c.kind === 'term');
  const conceptCards = cards.filter((c) => c.kind !== 'term');

  return cards.map((card) => {
    if (card.kind === 'term') {
      const own = termKey(card.front);
      const mcWrong = usableWrong(
        [...names].filter(([key]) => key !== own).map(([, name]) => name),
        card.front,
        Infinity,
      );
      // only other definitions: another kind of card's answer under "Does this describe X?" is plainly not a definition
      const falsePool = usableWrong(termCards.filter((c) => c.id !== card.id).map(shown), shown(card), Infinity);
      return { card, shown: shown(card), mcWrong, mcClean: mcWrong, falsePool, falseClean: falsePool, problems: [] };
    }

    const problems = [];
    const given = answerInQuestion(card.front, card.back);
    if (given) problems.push({ rule: 'a', detail: given });
    problems.push(...cardLeaks(card).filter((p) => p.rule === 'k'));

    const saved = usableWrong(distractors.get(card.id), card.back);
    const otherAnswers = conceptCards.filter((c) => c.id !== card.id).map((c) => c.back);
    const savedClean = saved.filter((w) => !wrongOptionProblems(w, card.back, { lessonWords, otherAnswers }).length);
    const setProblems = savedClean.length >= WRONG_PER_QUESTION ? optionSetProblems(card.front, card.back, savedClean) : [];
    problems.push(...setProblems);
    const mcClean = !given && !problems.length && savedClean.length >= WRONG_PER_QUESTION ? savedClean : [];

    // without saved wrong answers, other concept answers on the same subject; one about something else is plainly "No"
    const others = usableWrong(
      conceptCards.filter((c) => c.id !== card.id).map((c) => c.back),
      card.back,
      Infinity,
    );
    const falsePool = saved.length ? saved : others;
    const questionWords = contentWords(card.front);
    const onTopic = (s) => contentWords(s).some((w) => questionWords.some((q) => sameWord(w, q)));
    const plausible = (s) => !falseStatementProblems(s, card.back).length;
    const cardOk = !problems.some((p) => p.rule === 'a' || p.rule === 'k');
    const savedFalse = saved.filter((s) => plausible(s) && !wrongOptionProblems(s, card.back, { lengths: false, otherAnswers }).some((p) => p.detail.startsWith('another card')));
    const falseClean = !cardOk ? [] : saved.length ? savedFalse : others.filter((s) => plausible(s) && onTopic(s));
    return { card, shown: card.back, mcWrong: saved, mcClean, falsePool, falseClean, problems };
  });
}

const canMc = (p) => p.mcClean.length >= WRONG_PER_QUESTION;
const usable = (p) => canMc(p) || p.falseClean.length > 0;

function multipleChoice({ card, shown, mcClean }, random) {
  const wrong = shuffle(mcClean, random).slice(0, WRONG_PER_QUESTION);
  const term = card.kind === 'term';
  const correct = term ? card.front : card.back;
  return {
    flashcard_id: card.id,
    type: 'mc',
    kind: card.kind,
    question: term ? shown : card.front,
    statement: null,
    ...arrange(correct, wrong, random),
    answer_text: correct,
    evidence: card.evidence ?? null,
  };
}

function trueFalse({ card, shown, falseClean }, random) {
  const truth = random() < 0.5;
  return {
    flashcard_id: card.id,
    type: 'tf',
    kind: card.kind,
    question: card.front,
    statement: truth ? shown : pickOne(falseClean, random),
    choices: TF_CHOICES,
    answer_index: truth ? 0 : 1,
    answer_text: card.back,
    evidence: card.evidence ?? null,
  };
}

// How many cards can be asked without giving the answer away (the most questions a quiz on them can have).
// opts: { distractors, extraTerms, lessonText } as for buildQuiz.
export function usableCount(cards, opts = {}) {
  return quizCandidates(cards, opts).filter(usable).length;
}

// cards: [{ id, kind, front, back, evidence }]; distractors: Map card id -> [wrong answer]; extraTerms: key-term names
// that have no card; lessonText: the lesson's raw text (wrong options about nothing in it are left out).
// -> questions in the order they are asked:
//   [{ flashcard_id, type 'mc'|'tf', kind, question, statement, choices, answer_index, answer_text, evidence }]
export function buildQuiz({ cards, distractors = new Map(), extraTerms = [], lessonText = null, count = QUIZ_LENGTH, random = Math.random }) {
  const candidates = quizCandidates(cards, { distractors, extraTerms, lessonText }).filter(usable);
  const picked = shuffle(candidates, random).slice(0, count);
  const forced = picked.filter((p) => !canMc(p)).length;
  const variety = picked.length >= 4 ? Math.round(picked.length * TF_SHARE) : 0;
  const extraTf = new Set(shuffle(picked.filter((p) => canMc(p) && p.falseClean.length), random).slice(0, Math.max(0, variety - forced)));
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
