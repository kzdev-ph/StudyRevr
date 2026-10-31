import {
  answerInQuestion,
  falseStatementProblems,
  isNegative,
  language,
  wordsNotIn,
  wordStems,
  words,
  wrongOptionProblems,
} from './leaks.js';

// Checks for the AI's True/False statement pairs: a TRUE sentence T that states the card's answer, and a FALSE twin F
// that is T with the answer swapped for a wrong one. Pure (no DB, no AI): the same word checks as leaks.js, applied to
// the sentences and to what changed between them. Grounding is by exact words (wordStems and leaks.js's `exact`), never
// by a similarity score.
//
//   s  (new) a sentence that is not grounded in the card, does not state the answer, or is not a clean sentence
//   a, c, e, f  as in leaks.js, for the twin (see twinProblems)

export const MAX_STATEMENT_WORDS = 45;

// Words that make a statement true or false on their own. The stop words of leaks.js hide most of these ("all",
// "only", "lahat"), so they are looked for in the raw words.
export const ABSOLUTES = new Set(
  'always all every each any only solely exclusively entirely completely totally purely invariably constantly everyone everything everywhere anyone anything must lahat palagi palaging lagi laging tanging lamang lang bawat kailanman pawang buong lubos'.split(' '),
);

const wordCount = (s) => String(s ?? '').match(/\S+/g)?.length ?? 0;
const absolutesIn = (text) => words(text).filter((w) => ABSOLUTES.has(w));

// Strip the common prefix and suffix of T and F: what is left is `removed` (from T) and `added` (in F). Each part is
// { tokens, text }; `frame` is the shared prefix and suffix.
export function splitChange(trueText, falseText) {
  const t = words(trueText);
  const f = words(falseText);
  let start = 0;
  while (start < t.length && start < f.length && t[start] === f[start]) start++;
  let end = 0;
  while (end < t.length - start && end < f.length - start && t[t.length - 1 - end] === f[f.length - 1 - end]) end++;
  const part = (tokens) => ({ tokens, text: tokens.join(' ') });
  return {
    removed: part(t.slice(start, t.length - end)),
    added: part(f.slice(start, f.length - end)),
    frame: part([...t.slice(0, start), ...t.slice(t.length - end)]),
  };
}

// What is wrong with a sentence as a sentence, whichever of the pair it is. -> [{ rule, detail }]
function formProblems(text) {
  const problems = [];
  if (!String(text ?? '').trim()) return [{ rule: 's', detail: 'no text' }];
  const n = wordCount(text);
  if (n > MAX_STATEMENT_WORDS) problems.push({ rule: 's', detail: `${n} words, more than ${MAX_STATEMENT_WORDS}` });
  if (/[?？][\s"'”’)\]]*$/.test(String(text).trim())) problems.push({ rule: 's', detail: 'ends with a question mark' });
  return problems;
}

// A true sentence is a whole sentence, not the bare answer or a formula (rule s).
export const MIN_TRUE_WORDS = 5;

// The TRUE sentence for a card ({ front, back, evidence }). -> [{ rule, detail }]
export function trueProblems(card, text) {
  const problems = formProblems(text);
  if (!String(text ?? '').trim()) return problems;
  const cardText = `${card.front ?? ''} ${card.back ?? ''}`;
  // grounding: every content word comes from the question, the answer or the card's quote
  const strange = wordsNotIn(text, `${cardText} ${card.evidence ?? ''}`);
  if (strange.length) problems.push({ rule: 's', detail: `words that are not in the card or its quote (${strange.join(', ')})` });
  // it states the answer: every content word of the answer is in it
  const missing = wordsNotIn(card.back, text);
  if (missing.length) problems.push({ rule: 's', detail: `does not state the answer (missing ${missing.join(', ')})` });
  // it is a sentence: long enough, with a real word, and with a word of the question besides the answer
  const n = wordCount(text);
  if (n < MIN_TRUE_WORDS) problems.push({ rule: 's', detail: `${n} words, fewer than ${MIN_TRUE_WORDS}` });
  if (!/\p{L}{3,}/u.test(text)) problems.push({ rule: 's', detail: 'no word, only digits or a formula' });
  const subject = wordsNotIn(card.front, card.back);
  const notInText = wordsNotIn(card.front, text);
  if (subject.length && subject.every((w) => notInText.includes(w))) problems.push({ rule: 's', detail: 'only the answer, without the subject of the question' });
  if (isNegative(text) && !isNegative(cardText)) problems.push({ rule: 'e', detail: 'a negative statement the card does not make' });
  const cardWords = new Set(words(cardText));
  const absolute = absolutesIn(text).filter((w) => !cardWords.has(w));
  if (absolute.length) problems.push({ rule: 'e', detail: `an absolute word the card does not use (${absolute.join(', ')})` });
  const la = language(card.back);
  const lt = language(text);
  if (la && lt && la !== lt) problems.push({ rule: 'e', detail: 'another language than the answer' });
  return problems;
}

// The FALSE twin of a TRUE sentence, checked on the words that changed. `lessonWords`: lessonWords(lesson text), for the
// lesson-grounded change; `otherAnswers`: the answers of the lesson's other cards. -> [{ rule, detail }]
export function twinProblems(card, trueText, falseText, { lessonWords = null, otherAnswers = [] } = {}) {
  const problems = formProblems(falseText);
  if (!String(falseText ?? '').trim()) return problems;
  const { removed, added, frame } = splitChange(trueText, falseText);
  // rule e: it only adds or drops words ("not", "only"), so it is false from its wording alone
  if (!removed.tokens.length || !added.tokens.length) {
    problems.push({ rule: 'e', detail: 'only adds or drops words' });
    return problems;
  }
  if (!wordsNotIn(added.text, removed.text).length) problems.push({ rule: 'e', detail: 'only reordered or re-inflected words' });
  // the changed part is the same kind of thing as the answer: a number for a number, a word for a word
  if (/\d/.test(removed.text) !== /\d/.test(added.text)) problems.push({ rule: 'f', detail: 'a different kind of change (number vs word)' });
  // the change must replace the answer, never the subject
  if (wordsNotIn(card.back, removed.text).length === wordStems(card.back).length) problems.push({ rule: 's', detail: 'the change does not replace the answer' });
  const given = answerInQuestion(falseText, card.back);
  if (given) problems.push({ rule: 'a', detail: given.replace('the question', 'the twin') });
  // a negative A is caught below, by falseStatementProblems (e) and wrongOptionProblems (c), when R is not negative
  const absolute = absolutesIn(added.text).filter((w) => !absolutesIn(removed.text).includes(w));
  if (absolute.length) problems.push({ rule: 'e', detail: `adds an absolute word (${absolute.join(', ')})` });
  problems.push(...falseStatementProblems(added.text, removed.text, { reworded: true }));
  problems.push(...wrongOptionProblems(added.text, removed.text, { lessonWords, otherAnswers }));
  // the lesson-grounded change: every content word of A is a word of the lesson, exactly
  if (lessonWords) {
    const off = wordStems(added.text).filter((forms) => !forms.some((s) => lessonWords.has(s)));
    if (off.length) problems.push({ rule: 'f', detail: `words that are not in the lesson (${off.map((forms) => forms[0]).join(', ')})` });
  }
  // A only repeats words of the shared frame, so the sentence says nothing new
  if (!wordsNotIn(added.text, frame.text).length) problems.push({ rule: 'e', detail: 'only repeats the rest of the sentence' });
  return problems;
}

// A pair ({ true_statement, false_statement }, or { true_text, false_text } as stored) for a card.
// -> { ok, problems: [{ rule, detail }] }
export function checkPair(card, pair, opts = {}) {
  const trueText = pair?.true_statement ?? pair?.true_text ?? '';
  const falseText = pair?.false_statement ?? pair?.false_text ?? '';
  const problems = [
    ...trueProblems(card, trueText).map((p) => ({ ...p, detail: `true statement: ${p.detail}` })),
    ...twinProblems(card, trueText, falseText, opts).map((p) => ({ ...p, detail: `false twin: ${p.detail}` })),
  ];
  return { ok: problems.length === 0, problems };
}
