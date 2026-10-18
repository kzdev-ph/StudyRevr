import { comparable } from '../pipeline/evidence.js';
import { termKey } from '../pipeline/terms.js';
import { answerInQuestion, cardLeaks, falseStatementProblems, lessonWords as lessonWordsOf, maskTerm, optionSetProblems, sharesWord, termInText, wrongOptionProblems } from './leaks.js';
import { listGroups, onlyInObjectives, sameItem, sameShape, siblingItems, withoutObjectives } from './list-items.js';
import { familyIndex, relatedTerms } from './related.js';
import { describe, optionFlags, reviewFor } from './review-flags.js';

// Turning a lesson's flashcards into quiz questions. Pure: the caller passes the cards, the saved wrong answers and a
// `random` function (tests pass a seeded one), so the same inputs always give the same quiz.
//
//   term card     multiple choice "which term matches this definition?"; the wrong options are other key terms of the
//                 same lesson. With fewer than 3 other terms: true / false against another term card's definition.
//   concept card  multiple choice with the 3 wrong answers the AI made for it (quiz_distractors). With fewer:
//                 true / false, where the false statement is a saved wrong answer or, with none saved, another concept
//                 card's answer on the same subject (sharing a word with the question).
//   list item     a concept card whose answer is an item of a list in the lesson (3 or more bullets on one slide): the
//                 wrong options and false statements are the other items of that list (list-items.js), no AI call.
// About 3 in 10 questions are true / false for variety, even when every card could be multiple choice.
//
// Nothing that gives its answer away is asked (see leaks.js): a concept card whose question holds its answer is
// skipped; wrong options and false statements that stand out are left out, and a card with too few left is asked
// the other way or not at all. A definition that holds its own term is shown with the term blanked ("___"), and is
// checked again after blanking: one that still shows the term is not asked. So a lesson whose cards can't fill 10
// clean questions gets a shorter quiz instead of leaking ones.
//
// A related term (one holds the other, "Self-Introduction" and "Written Self-Introduction", or the AI review put them
// in one family) is never a wrong option or false statement for the other (related.js). What the AI exam reviewer
// flagged (review-flags.js) is left out: a flagged card is not asked, a flagged option or false statement is not shown,
// a flagged set is not asked as multiple choice and a flagged true statement not as Yes/No.

export const QUIZ_LENGTH = 10;
export const TF_SHARE = 0.3;
export const TF_CHOICES = ['True', 'False'];
const WRONG_PER_QUESTION = 3;

// Two answers are the same when they match ignoring case and surrounding (or repeated) spaces.
const plain = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
export const sameAnswer = (a, b) => plain(a) === plain(b);

// Whether a text says anything: a letter or digit is left once whitespace, invisible characters (zero-width space,
// soft hyphen, BOM...) and the "___" gap of a blanked term are taken away. An option or statement without text is
// never saved, shown or asked.
export const hasText = (s) => /[\p{L}\p{N}]/u.test(String(s ?? '').replace(/[\p{Z}\p{Cc}\p{Cf}_]/gu, ''));

// A built question with a blank choice, statement or question text (never asked).
export const hasBlank = (q) => !hasText(q.question) || (q.type === 'mc' ? !q.choices.every(hasText) : !hasText(q.statement));

// Wrong answers that can be shown next to `correct`: no blanks, none equal to it or to each other, at most `limit`.
export function usableWrong(wrong, correct, limit = WRONG_PER_QUESTION) {
  const kept = [];
  for (const w of wrong ?? []) {
    const text = String(w ?? '').trim();
    if (!hasText(text) || sameAnswer(text, correct) || kept.some((k) => sameAnswer(k, text))) continue;
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
//     its option set can't be used: [{ rule, detail }]), reviewable (the wrong options and false statements that passed
//     the code checks: what the AI reviewer is shown), mcCode (the wrong options of those, for multiple choice), excluded ([{ text, rule, detail }]: left out as a related term,
//     rule r, or flagged by the AI reviewer, rule ai; text null for a flag on the whole set or the true statement) }
// `npm run quiz:check` reports the candidates; the quiz only uses mcClean and falseClean.
// termFamilies: [[term, ...]] from the AI review; reviews: Map card id -> readReview(row) (review-flags.js).
export function quizCandidates(cards, { distractors = new Map(), extraTerms = [], lessonText = null, termFamilies = [], reviews = new Map() } = {}) {
  const lessonWords = lessonWordsOf(lessonText);
  const families = familyIndex(termFamilies);
  const names = new Map(); // termKey -> spelling, from term cards first, then key terms without a card
  for (const name of [...cards.filter((c) => c.kind === 'term').map((c) => c.front), ...extraTerms]) {
    const key = termKey(name);
    if (key && !names.has(key)) names.set(key, String(name).trim());
  }
  const termCards = cards.filter((c) => c.kind === 'term');
  const conceptCards = cards.filter((c) => c.kind !== 'term');
  const masked = new Map(termCards.map((c) => [c.id, maskTerm(c.back, c.front)]));
  const shown = (card) => (card.kind === 'term' ? masked.get(card.id) : card.back);
  const blanked = (card) => masked.get(card.id) !== card.back;
  // checked again after blanking: a definition that still shows its term is neither asked nor used as a false statement
  const stillShows = new Map(termCards.map((c) => [c.id, termInText(c.front, masked.get(c.id))]));
  const groups = listGroups(lessonText);
  // a card whose quote is only in the learning objectives / outline / agenda slides is never asked (rule o)
  const fullKey = lessonText ? comparable(lessonText) : '';
  const bodyKey = lessonText ? comparable(withoutObjectives(lessonText)) : '';
  const fromObjectives = (c) => Boolean(lessonText) && onlyInObjectives(comparable(c.evidence ?? ''), fullKey, bodyKey);
  const OBJECTIVE_PROBLEM = { rule: 'o', detail: 'the card comes from the learning objectives, outline or agenda, not from what the lesson teaches' };

  return cards.map((card) => {
    const review = reviewFor(reviews, card);
    const excluded = [];
    // the reviewer's verdict on one option: a flagged one is left out (and listed in `excluded`)
    const passesReview = (text) => {
      const flags = optionFlags(review, text);
      if (flags.length) excluded.push({ text, rule: 'ai', detail: describe(flags) });
      return !flags.length;
    };
    // what the reviewer said about the card as a whole, its multiple-choice set and its true statement
    const reviewProblems = review?.card.length ? [{ rule: 'ai', detail: describe(review.card) }] : [];
    const setFlagged = Boolean(review?.set.length);
    const trueFlagged = Boolean(review?.trueStatement.length);
    if (setFlagged) excluded.push({ text: null, rule: 'ai', detail: `multiple choice: ${describe(review.set)}` });
    if (trueFlagged) excluded.push({ text: null, rule: 'ai', detail: `Yes/No: ${describe(review.trueStatement)}` });

    if (card.kind === 'term') {
      const visible = stillShows.get(card.id);
      if (fromObjectives(card)) return { card, shown: shown(card), mcWrong: [], mcClean: [], falsePool: [], falseClean: [], reviewable: [], mcCode: [], excluded, problems: [OBJECTIVE_PROBLEM] };
      // a definition that is only its own term is "___" once blanked: nothing to ask
      if (!hasText(shown(card))) return { card, shown: shown(card), mcWrong: [], mcClean: [], falsePool: [], falseClean: [], reviewable: [], mcCode: [], excluded, problems: [{ rule: 'd', detail: 'the definition is only the term, blank once the term is hidden' }] };
      if (visible) return { card, shown: shown(card), mcWrong: [], mcClean: [], falsePool: [], falseClean: [], reviewable: [], mcCode: [], excluded, problems: [{ rule: 'd', detail: `the term still shows after blanking (${visible.join(', ')})` }] };
      const own = termKey(card.front);
      // a related term is not wrong for this definition: never offered, never used as a false statement
      const unrelated = (name, text = name) => {
        if (!relatedTerms(card.front, name, families)) return true;
        excluded.push({ text, rule: 'r', detail: `a related term (${name})` });
        return false;
      };
      const mcWrong = usableWrong(
        [...names].filter(([key]) => key !== own).map(([, name]) => name),
        card.front,
        Infinity,
      ).filter((name) => unrelated(name));
      // only other definitions: another kind of card's answer under "Does this describe X?" is plainly not a definition.
      // Rule e as for concept cards: not one that names the asked term, is negative beside a positive definition, is in
      // another language or is nearly this card's own definition.
      // Another term's blanked definition ("presented in ___ form") is never a false statement: under "Does this
      // describe Oral Self-Introduction?" the gap reads as a misprint and points at No.
      const others = termCards.filter((c) => c.id !== card.id && !stillShows.get(c.id) && !blanked(c) && unrelated(c.front, shown(c)));
      const falsePool = usableWrong(others.map(shown), shown(card), Infinity);
      const falseCode = falsePool.filter((s) => !termInText(card.front, s) && !falseStatementProblems(s, shown(card)).length);
      const reviewable = [...new Set([...mcWrong, ...falseCode])];
      if (reviewProblems.length) return { card, shown: shown(card), mcWrong, mcClean: [], falsePool, falseClean: [], reviewable, mcCode: mcWrong, excluded, problems: reviewProblems };
      const mcClean = setFlagged ? [] : mcWrong.filter(passesReview);
      // a definition that had to be blanked is never asked as Yes/No: the gap would be the only mark of the true one
      const falseClean = trueFlagged || blanked(card) ? [] : falseCode.filter(passesReview);
      return { card, shown: shown(card), mcWrong, mcClean, falsePool, falseClean, reviewable, mcCode: mcWrong, excluded, problems: [] };
    }

    const problems = [];
    const given = answerInQuestion(card.front, card.back);
    if (given) problems.push({ rule: 'a', detail: given });
    problems.push(...cardLeaks(card).filter((p) => p.rule === 'k' || p.rule === 'l' || p.rule === 'm'));
    if (fromObjectives(card)) problems.push(OBJECTIVE_PROBLEM);

    // a list item's wrong options are the other items of its list (list-items.js), not saved AI ones; those items are
    // other cards' answers too, which is accepted here as for term cards (they don't answer this question)
    const siblings = siblingItems(groups, card.back);
    const saved = siblings ? usableWrong(siblings, card.back, Infinity) : usableWrong(distractors.get(card.id), card.back);
    const otherAnswers = conceptCards.filter((c) => c.id !== card.id && !(siblings && siblings.some((s) => sameItem(s, c.back)))).map((c) => c.back);
    const savedClean = saved.filter((w) => !wrongOptionProblems(w, card.back, { lessonWords, otherAnswers, reworded: !siblings }).length);
    const reviewedClean = savedClean.filter(passesReview);
    // with more than 3 siblings: the first 3 that make a set where the right answer doesn't stand out
    const set = pickSet(card, reviewedClean, lessonWords);
    problems.push(...set.problems, ...reviewProblems);
    const mcClean = !given && !setFlagged && !problems.length && set.wrong.length >= WRONG_PER_QUESTION ? set.wrong : [];

    // without saved wrong answers, other concept answers on the same subject; one about something else is plainly "No".
    // Only a card's own saved wrong answers are tested for being its answer reworded: another card's answer is another claim
    const others = usableWrong(
      conceptCards.filter((c) => c.id !== card.id && !fromObjectives(c)).map((c) => c.back),
      card.back,
      Infinity,
    ).filter((s) => sameShape(card.back, s));
    const falsePool = saved.length ? saved : others;
    const onTopic = (s) => sharesWord(s, card.front);
    const plausible = (s) => !falseStatementProblems(s, card.back, { reworded: !siblings && saved.length > 0 }).length;
    const cardOk = !problems.some((p) => p.rule === 'a' || p.rule === 'k' || p.rule === 'm' || p.rule === 'o');
    const savedFalse = saved.filter((s) => plausible(s) && !wrongOptionProblems(s, card.back, { lengths: false, otherAnswers }).some((p) => p.detail.startsWith('another card')));
    const falseCode = !cardOk ? [] : saved.length ? savedFalse : others.filter((s) => plausible(s) && onTopic(s));
    const reviewable = cardOk ? [...new Set([...savedClean, ...falseCode])] : [];
    const flagged = new Set(excluded.map((x) => x.text));
    const falseClean = reviewProblems.length || trueFlagged ? [] : falseCode.filter((s) => (flagged.has(s) ? false : passesReview(s)));
    return { card, shown: card.back, mcWrong: saved, mcClean, falsePool, falseClean, reviewable, mcCode: cardOk ? savedClean : [], excluded, problems, sibling: Boolean(siblings) };
  });
}

// The first 3 of `clean` that pass the set checks (rules b, c, f as a set). -> { wrong, problems }: wrong is [] when
// there are fewer than 3, or no 3 pass (problems then say why, for the first set tried).
function pickSet(card, clean, lessonWords) {
  if (clean.length < WRONG_PER_QUESTION) return { wrong: [], problems: [] };
  let first = null;
  for (let i = 0; i < clean.length; i++)
    for (let j = i + 1; j < clean.length; j++)
      for (let k = j + 1; k < clean.length; k++) {
        const wrong = [clean[i], clean[j], clean[k]];
        const problems = optionSetProblems(card.front, card.back, wrong, { lessonWords });
        if (!problems.length) return { wrong, problems };
        first ??= problems;
      }
  return { wrong: [], problems: first };
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
// opts: as for buildQuiz.
export function usableCount(cards, opts = {}) {
  return quizCandidates(cards, opts).filter(usable).length;
}

// cards: [{ id, kind, front, back, evidence }]; distractors: Map card id -> [wrong answer]; extraTerms: key-term names
// that have no card; lessonText: the lesson's raw text (wrong options about nothing in it are left out); termFamilies,
// reviews: what the AI review said (quizBuildOptions in options.js).
// -> questions in the order they are asked:
//   [{ flashcard_id, type 'mc'|'tf', kind, question, statement, choices, answer_index, answer_text, evidence }]
export function buildQuiz({ cards, count = QUIZ_LENGTH, random = Math.random, ...opts }) {
  const candidates = quizCandidates(cards, opts).filter(usable);
  const picked = shuffle(candidates, random).slice(0, count);
  const forced = picked.filter((p) => !canMc(p)).length;
  const variety = picked.length >= 4 ? Math.round(picked.length * TF_SHARE) : 0;
  const extraTf = new Set(shuffle(picked.filter((p) => canMc(p) && p.falseClean.length), random).slice(0, Math.max(0, variety - forced)));
  return picked.map((p) => (canMc(p) && !extraTf.has(p) ? multipleChoice(p, random) : trueFalse(p, random))).filter((q) => !hasBlank(q));
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
