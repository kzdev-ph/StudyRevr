import { singular } from '../pipeline/terms.js';

// Checks for quiz questions and flashcards that give their own answer away, so a student could answer them without
// knowing the lesson. Pure and shared by the quiz builder (which skips or repairs what fails), the wrong-answers step
// (which drops bad options), the admin flag and `npm run quiz:check`. Works on English, Filipino and Taglish.
//
//   a  the question holds the answer, or most of its content words
//   b  only the right option shares content words with the question
//   c  the right option stands out: length, sentence shape, opening words, or tone (it is the only one that isn't
//      a negative or reversed statement)
//   d  a term question's definition holds the term (or a form of it)
//   e  a Yes/No statement is true or false from its wording alone (a negative or reversed statement, another
//      language, or another kind of card's answer)
//   f  wrong options that are near-duplicates of each other, in another language, or about nothing in the lesson
// Flashcards:
//   g  the front holds the back, or most of its content words
//   h  a term card's definition holds the term
//   i  a yes/no or either/or question
//   j  the front holds another card's answer
//   k  front and back are nearly the same, or the back only restates the front
//
// These are word checks: they catch wording and tone, not a question whose meaning already says the answer
// ("Why is language called dynamic?" -> "because it changes"). The prompts ask for that; the checks can't see it.

// Words that carry no meaning of their own here: English and Filipino function words, question words and the words
// questions use to ask for a definition. Kept apart from the card de-duplication list in pipeline/flashcards.js.
const STOP_EN =
  'a an the of to in on at for and or nor but is are was were be been being it its this that these those what which who whom whose how why when where does do did can could should would will may might define definition meaning mean means term called refer refers referred by with as from into than then there their about give example name list explain describe not no so also such other they them we our you your he she his her has have had one two three first second third lesson according through during after before over under between because while only just very each some any all';
const STOP_FIL =
  "ang ng sa mga na ay at ito iyon iyan isang isa para o si ni kay nang may kung din rin lamang lang ba pa po ano anong paano bakit saan saang kailan sino alin aling ating atin natin tayo kami namin amin sila nila kanila siya niya kaniya nito dito doon mula upang dahil kapag habang naman ayon tungkol bilang pamamagitan ibig sabihin kahulugan tumutukoy nina sina kanilang aming iba ibang hindi mas pang ilang lahat kasi pero ngunit subalit kaya noon ngayon itong iyong yung yun sapagkat tulad gaya";
export const STOPWORDS = new Set(`${STOP_EN} ${STOP_FIL}`.split(' '));

// Words that mark the language of a phrase.
const FIL_MARKERS = new Set('ang ng sa mga ay ito nang isang para hindi upang dahil ating nito'.split(' '));
const EN_MARKERS = new Set('the of is are and to in a an that this it for with'.split(' '));

// Negatives, and the reversing verbs wrong answers are often built from (as stems: "itago", "pagtatago" -> "tago").
const NEGATIVE_WORDS = new Set('not never no none without cannot nothing hindi wala walang huwag di'.split(' '));
const NEGATIVE_STEMS = ['tago', 'alis', 'pigil', 'bawas', 'tanggal', 'limita', 'sugp', 'hadlang', 'bura', 'tigil', 'hirap', 'limot', 'limut', 'galit', 'ayaw', 'wala', 'prevent', 'remov', 'reduc', 'decreas', 'hinder', 'block', 'ignor', 'avoid', 'lose', 'losing', 'lost', 'hide', 'hidd', 'hiding', 'restrict', 'forbid', 'destroy', 'weaken', 'discourag', 'neglect', 'refus', 'deny', 'denie', 'harm'];

export const words = (s) => String(s ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? [];
const wordCount = (s) => String(s ?? '').match(/\S+/g)?.length ?? 0;

// A light stemmer, enough to see that two words are forms of one. English (lang 'en'): plurals and -ing/-ed.
// Otherwise Filipino: the linker ("wikang" -> "wika"), common prefixes ("pag-unlad" -> "unlad", "nagbabago" ->
// "bago"), the infixes -um-/-in- ("ginamit" -> "gamit"), first-syllable reduplication and -an/-in/-han/-hin. The
// language is the text's (see contentWords); an English plural in a Filipino or Taglish text still matches its
// singular through sameWord's containment.
const PREFIXES = ['pinakama', 'pinaka', 'nakaka', 'makaka', 'nakapag', 'makapag', 'ipinag', 'ipag', 'pagka', 'pagpa', 'pinag', 'pang', 'pam', 'pan', 'nag', 'mag', 'pag', 'naka', 'maka', 'napa', 'mapa', 'ika', 'ipa', 'ma', 'na', 'ka', 'i'];
export function stem(word, lang = null) {
  let s = String(word).normalize('NFKC').toLowerCase();
  if (lang === 'en') {
    s = singular(s.replace(/-/g, ''));
    return s.length > 6 ? s.replace(/(?:ing|ed)$/, '') : s;
  }
  if (s.length > 4 && /[aeiou]ng$/.test(s)) s = s.slice(0, -2);
  for (let pass = 0; pass < 2; pass++) {
    const prefix = PREFIXES.find((p) => s.startsWith(p) && s.length - p.length >= 4);
    if (prefix) s = s.slice(prefix.length);
    s = s.replace(/^-/, '');
  }
  s = s.replace(/-/g, '');
  if (s.length > 5 && /^[^aeiou](?:um|in)[aeiou]/.test(s)) s = s[0] + s.slice(3);
  const syllable = s.match(/^([^aeiou]?[aeiou])(.*)$/);
  if (syllable && syllable[2].startsWith(syllable[1]) && s.length - syllable[1].length >= 4) s = syllable[2];
  if (s.length > 5) s = s.replace(/(?:han|hin|an|in)$/, '');
  return s;
}

// The meaning-carrying words of a text, as stems, each once.
export function contentWords(text) {
  const lang = language(text);
  return [...new Set(words(text).filter((w) => w.length > 1 && !STOPWORDS.has(w)).map((w) => stem(w, lang)))];
}

// Two stems are one word when equal, or when one holds the other and the shorter has at least 4 letters
// ("wika" / "wikain", "gamit" / "ginagamit").
export const sameWord = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a)));
const shared = (list, other) => list.filter((w) => other.some((o) => sameWord(w, o)));
const coverage = (part, whole) => (part.length ? shared(part, whole).length / part.length : 0);
const jaccard = (a, b) => {
  if (!a.length || !b.length) return 0;
  const n = shared(a, b).length;
  return n / (a.length + b.length - n);
};

// 'en', 'fil' or null when it can't tell (Taglish, a list of names).
export function language(text) {
  const ws = words(text);
  const fil = ws.filter((w) => FIL_MARKERS.has(w)).length;
  const en = ws.filter((w) => EN_MARKERS.has(w)).length;
  if (fil === en) return null;
  return fil > en ? 'fil' : 'en';
}

export const isNegative = (text) =>
  words(text).some((w) => NEGATIVE_WORDS.has(w) || [stem(w), stem(w, 'en')].some((s) => NEGATIVE_STEMS.some((n) => s.startsWith(n))));
const fullSentence = (text) => /[.!?]$/.test(String(text).trim()) && wordCount(text) >= 4;
const opening = (text) => words(text).slice(0, 2).join(' ');
const plain = (s) => words(s).join(' ');

export const ANSWER_COVERAGE = 0.6; // share of the answer's content words that, found in the question, give it away
export const NEAR_DUPLICATE = 0.7; // content-word overlap at which two options say the same thing
const LENGTH_RATIO = [0.6, 1.6]; // a wrong option's words / the right one's ...
const LENGTH_SLACK = 4; // ... or within this many words of it

// Rule a / g: the question (or front) gives the answer away. -> a reason, or null
export function answerInQuestion(question, answer) {
  const a = plain(answer);
  if (a && ` ${plain(question)} `.includes(` ${a} `)) return 'the question holds the answer';
  const answerWords = contentWords(answer);
  const questionWords = contentWords(question);
  if (answerWords.length >= 2 && coverage(answerWords, questionWords) >= ANSWER_COVERAGE)
    return `the question holds most of the answer (${shared(answerWords, questionWords).join(', ')})`;
  if (answerWords.length === 1 && shared(answerWords, questionWords).length) return `the question holds the answer word "${answerWords[0]}"`;
  return null;
}

// Rule d / h: the term (or most of a multi-word term) appears in the text. -> the words found, or null
export function termInText(term, text) {
  const termWords = contentWords(term);
  if (!termWords.length) return null;
  const found = shared(termWords, contentWords(text));
  return found.length === termWords.length || (termWords.length >= 2 && found.length * 2 >= termWords.length) ? found : null;
}

// A definition with its own term blanked out, so "Does this describe X?" and "Which term matches?" don't answer
// themselves. Only words that are forms of the term's words are replaced; the rest is left as written.
export function maskTerm(text, term) {
  if (!termInText(term, text)) return text;
  const termWords = contentWords(term);
  const masked = String(text).replace(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu, (w) => {
    const lower = w.normalize('NFKC').toLowerCase();
    return !STOPWORDS.has(lower) && termWords.some((t) => sameWord(stem(lower), t)) ? '___' : w;
  });
  return masked.replace(/___(?:\s+___)+/g, '___');
}

// What is wrong with one wrong option next to the right answer (rules c and f). `lessonWords`: contentWords of the
// lesson text, for the off-topic check (skipped without it). `lengths: false` for term names, which differ in length
// on their own. -> [{ rule, detail }]
export function wrongOptionProblems(wrong, correct, { lessonWords = null, lengths = true, otherAnswers = [] } = {}) {
  const problems = [];
  if (isNegative(wrong) && !isNegative(correct)) problems.push({ rule: 'c', detail: 'tone: a negative or reversed statement next to a positive right answer' });
  if (lengths) {
    const n = wordCount(correct);
    const w = wordCount(wrong);
    const ratio = w / Math.max(n, 1);
    if ((ratio < LENGTH_RATIO[0] || ratio > LENGTH_RATIO[1]) && Math.abs(w - n) > LENGTH_SLACK) problems.push({ rule: 'c', detail: `length: ${w} words next to a ${n}-word right answer` });
  }
  const lc = language(correct);
  const lw = language(wrong);
  if (lc && lw && lc !== lw) problems.push({ rule: 'f', detail: 'another language' });
  const own = contentWords(wrong);
  if (jaccard(own, contentWords(correct)) >= NEAR_DUPLICATE) problems.push({ rule: 'f', detail: 'the right answer’s own words: reworded (a second right answer) or reversed' });
  // another card's answer reads as the answer to that other question, so a student can match it away
  if (otherAnswers.some((a) => jaccard(own, contentWords(a)) >= NEAR_DUPLICATE)) problems.push({ rule: 'f', detail: 'another card’s answer: it answers a different question' });
  if (lessonWords && own.length >= 2 && !own.some((w) => lessonWords.has(w) || [...lessonWords].some((l) => sameWord(w, l)))) problems.push({ rule: 'f', detail: 'about nothing in the lesson' });
  return problems;
}

// What gives the right option away among a full set of options (rules b, c, f). -> [{ rule, detail }]
export function optionSetProblems(question, correct, wrong) {
  const problems = [];
  if (!wrong.length) return problems;
  const questionWords = contentWords(question);
  // a word of the question that the right option repeats and no wrong option does ("komunikasyon" in a question about
  // communication) points at the right one, even when every option shares the lesson's common words ("wika")
  const echo = [...new Set(shared(contentWords(correct), questionWords))];
  const only = echo.filter((e) => !wrong.some((w) => shared(contentWords(w), [e]).length));
  if (only.length) problems.push({ rule: 'b', detail: `only the right option repeats the question (${only.join(', ')})` });
  if (wrong.length >= 2 && wrong.every((w) => opening(w) === opening(wrong[0])) && opening(correct) !== opening(wrong[0]))
    problems.push({ rule: 'c', detail: `opening: every wrong option starts "${opening(wrong[0])}"` });
  if (wrong.every((w) => fullSentence(w) === fullSentence(wrong[0])) && fullSentence(correct) !== fullSentence(wrong[0]))
    problems.push({ rule: 'c', detail: 'sentence shape: the right option is the only one shaped differently' });
  if (!isNegative(correct) && wrong.length >= 3 && wrong.filter(isNegative).length >= wrong.length - 1)
    problems.push({ rule: 'c', detail: 'tone: the right option is the only (or one of two) positive statements' });
  if (isNegative(correct) && wrong.length >= 3 && !wrong.some(isNegative))
    problems.push({ rule: 'c', detail: 'tone: the right option is the only negative statement' });
  for (let i = 0; i < wrong.length; i++)
    for (let j = i + 1; j < wrong.length; j++)
      if (jaccard(contentWords(wrong[i]), contentWords(wrong[j])) >= NEAR_DUPLICATE) problems.push({ rule: 'f', detail: `near-duplicate wrong options ${i + 1} and ${j + 1}` });
  return problems;
}

// A false Yes/No statement that is false from its wording alone (rule e). -> [{ rule, detail }]
export function falseStatementProblems(statement, answer) {
  const problems = [];
  if (isNegative(statement) && !isNegative(answer)) problems.push({ rule: 'e', detail: 'a negative or reversed statement' });
  const la = language(answer);
  const ls = language(statement);
  if (la && ls && la !== ls) problems.push({ rule: 'e', detail: 'another language' });
  if (jaccard(contentWords(statement), contentWords(answer)) >= NEAR_DUPLICATE) problems.push({ rule: 'e', detail: 'the right answer’s own words: reworded (so it may be true) or reversed' });
  return problems;
}

// Every rule a built question breaks. q: { type 'mc'|'tf', kind, question, statement, choices, answer_index,
// answer_text, false_from? ('term'|'concept': where a false statement came from) }; lessonWords as above.
// -> [{ rule, detail }]
export function questionLeaks(q, { lessonWords = null } = {}) {
  const problems = [];
  if (q.type === 'mc') {
    const correct = q.choices[q.answer_index];
    const wrong = q.choices.filter((_, i) => i !== q.answer_index);
    if (q.kind === 'term') {
      const found = termInText(correct, q.question);
      if (found) problems.push({ rule: 'd', detail: `the definition holds the term (${found.join(', ')})` });
    } else {
      const given = answerInQuestion(q.question, correct);
      if (given) problems.push({ rule: 'a', detail: given });
      problems.push(...optionSetProblems(q.question, correct, wrong));
    }
    for (const w of wrong) problems.push(...wrongOptionProblems(w, correct, { lessonWords, lengths: q.kind !== 'term' }).map((p) => ({ ...p, detail: `${p.detail}: "${w}"` })));
    return problems;
  }
  const truth = q.answer_index === 0;
  if (q.kind === 'term') {
    const found = termInText(q.question, q.statement);
    if (found) problems.push({ rule: 'e', detail: `the statement holds the term (${found.join(', ')})` });
  } else if (truth) {
    const given = answerInQuestion(q.question, q.statement);
    if (given) problems.push({ rule: 'e', detail: given });
  }
  if (!truth) {
    if (q.false_from && q.false_from !== q.kind) problems.push({ rule: 'e', detail: `the false statement is a ${q.false_from} card's answer under a ${q.kind} question` });
    problems.push(...falseStatementProblems(q.statement, q.answer_text));
  }
  return problems;
}

// Rules g-k for one flashcard. `others`: the lesson's other cards, for rule j. -> [{ rule, detail }]
export function cardLeaks(card, others = []) {
  const problems = [];
  // a term card's front is the term itself: its definition holding the term is rule h, not g
  const given = card.kind === 'term' ? null : answerInQuestion(card.front, card.back);
  if (given) problems.push({ rule: 'g', detail: given.replace('question', 'front') });
  if (card.kind === 'term') {
    const found = termInText(card.front, card.back);
    if (found) problems.push({ rule: 'h', detail: `the definition holds the term (${found.join(', ')})` });
  } else {
    const ws = words(card.front);
    const joined = ws.join(' ');
    if (/^(?:is|are|does|do|did|can|could|was|were|will|would|should|has|have|had)$/.test(ws[0] ?? '') || /\b(?:ba|o hindi|or not)\b/.test(joined))
      problems.push({ rule: 'i', detail: 'a yes/no or either/or question' });
  }
  const front = contentWords(card.front);
  for (const other of others) {
    if (other === card || (other.id != null && other.id === card.id)) continue;
    const answerWords = contentWords(other.back);
    if (answerWords.length >= 3 && coverage(answerWords, front) >= 0.8) problems.push({ rule: 'j', detail: `the front holds the answer of "${other.front}"` });
  }
  if (card.kind !== 'term') {
    const back = contentWords(card.back);
    if (jaccard(front, back) >= 0.6) problems.push({ rule: 'k', detail: 'front and back are nearly the same' });
    else if (back.length >= 2 && coverage(back, front) >= 0.8) problems.push({ rule: 'k', detail: 'the back only restates the front' });
  }
  return problems;
}
