import { singular } from '../pipeline/terms.js';

// Checks for quiz questions and flashcards that give their own answer away, so a student could answer them without
// knowing the lesson. Pure and shared by the quiz builder (which skips or repairs what fails), the wrong-answers step
// (which drops bad options), the admin flag and `npm run quiz:check`. Works on English, Filipino and Taglish.
//
//   a  the question holds the answer, or most of its content words
//   b  only the right option repeats words of the question (two or more, besides the question's topic)
//   c  the right option stands out: length, sentence shape, opening words, or tone (it is the only one that isn't
//      a negative or reversed statement)
//   d  a term question's definition holds the term (or a form of it)
//   e  a Yes/No statement is true or false from its wording alone (a negative or reversed statement, another
//      language, or another kind of card's answer)
//   f  wrong options that are near-duplicates of each other, in another language, or about nothing in the lesson
// Flashcards:
//   g  the front holds the back, or most of its content words
//   h  a term card's definition holds the term (reported only: the quiz blanks the term)
//   i  a yes/no or either/or question
//   j  the front holds another card's answer
//   k  front and back are nearly the same, or the back only restates the front
//   l  the question asks by a place in the list ("the aim listed first"), not by what the item is (concept cards)
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

// Filipino question words, with their linked forms: a question with one of them is not a yes/no question, "ba" or not.
const WH_WORDS = new Set('ano anong ano-ano anu-ano sino sinong sino-sino sinu-sino kanino saan saang nasaan kailan bakit paano paanong papaano alin aling ilan ilang gaano gaanong magkano'.split(' '));

// Words that mark the language of a phrase.
const FIL_MARKERS = new Set('ang ng sa mga ay ito nang isang para hindi upang dahil ating nito'.split(' '));
const EN_MARKERS = new Set('the of is are and to in a an that this it for with'.split(' '));

// Negatives, and the reversing verbs wrong answers are often built from. Whole words only, so a topic word that
// starts like one ("harmony", "blockchain", "hidden layer", "burador", "reduction") is not a negative. Words that
// only describe an amount ("reduce", "decrease", "bawasan") are left out: in a science lesson they are often the
// right answer. Filipino reversing verbs are matched by their stem ("itigil", "pagtigil" -> "tigil"), except where
// the stem is also a plain topic word: "hirap" (paghihirap, hardship), "alis" (pag-alis, departure) and "tago"
// (nakatago, stored) count only in these verb forms.
const NEGATIVE_WORDS = new Set('not never no none without cannot nothing hindi wala walang huwag di'.split(' '));
const NEGATIVE_EN = new Set(
  'prevent prevents prevented preventing prevention remove removes removed removing removal hinder hinders hindered hindering ignore ignores ignored ignoring avoid avoids avoided avoiding lose loses losing hide hides hiding hid restrict restricts restricted restricting forbid forbids forbade forbidden destroy destroys destroyed destroying weaken weakens weakened weakening discourage discourages discouraged discouraging neglect neglects neglected neglecting refuse refuses refused refusing deny denies denied denying harm harms harmed harming harmful'.split(' '),
);
const NEGATIVE_FIL = new Set(
  'mahirapan pahirapan pinahirapan nahirapan mahihirapan pinahihirapan alisin inalis inaalis aalisin maalis naalis itago itinago itinatago itatago tinatago pagtatago'.split(' '),
);
const NEGATIVE_FIL_STEMS = new Set('pigil tanggal limita sugpo sugpu hadlang hadla bura tigil limot limut galit ayaw wala'.split(' '));

export const words = (s) => String(s ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? [];
const wordCount = (s) => String(s ?? '').match(/\S+/g)?.length ?? 0;

// A light stemmer, enough to see that two words are forms of one. English (lang 'en'): plurals and -ing/-ed.
// Otherwise Filipino: the linker ("wikang" -> "wika"), common prefixes ("pag-unlad" -> "unlad", "nagbabago" ->
// "bago"), the infixes -um-/-in- ("ginamit" -> "gamit"), first-syllable reduplication and -an/-in/-han/-hin. The
// language is the text's, or both when it can't tell (see wordStems); an English plural in a Filipino or Taglish
// text still matches its singular through sameWord's containment.
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

// A word's possible stems: its text's language's, or both languages' when language() can't tell (a short phrase
// such as "Pattern matching", where the Filipino rules alone would cut "matching" to "tchi").
function stemsOf(word, lang) {
  if (lang) return [stem(word, lang)];
  const fil = stem(word);
  const en = stem(word, 'en');
  return fil === en ? [fil] : [fil, en];
}
const isContent = (w) => w.length > 1 && !STOPWORDS.has(w);

// The meaning-carrying words of a text, each once, as lists of possible stems (see stemsOf).
export function wordStems(text) {
  const lang = language(text);
  const seen = new Map();
  for (const w of words(text).filter(isContent)) {
    const forms = stemsOf(w, lang);
    const key = forms.join('|');
    if (!seen.has(key)) seen.set(key, forms);
  }
  return [...seen.values()];
}

// The meaning-carrying words of a text, as stems, each once (the first stem of each; see wordStems).
export const contentWords = (text) => [...new Set(wordStems(text).map((forms) => forms[0]))];

// Two stems are one word when equal, or when one holds the other and the shorter has at least 4 letters
// ("wika" / "wikain", "gamit" / "ginagamit").
export const sameWord = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a)));
// Two words (lists of possible stems, from wordStems) are one when any of their stems are (sameWord), or for
// `exact`, equal.
const matches = (a, b) => a.some((x) => b.some((y) => sameWord(x, y)));
// `exact` is the strict match, used where "data" must not match "database": the same stem, or a form of the same word
// ("professional" / "professionalism", "create" / "creates" / "creation", "confident" / "confidence"). A word's forms
// are itself and what is left after one common ending (FORM_SUFFIXES), without a final "e", provided at least 5
// letters are left, so a short stem ("state" in "statement") never links two words.
const FORM_SUFFIXES = [
  's', 'es', 'd', 'ed', 'ing', 'ings', 'ion', 'ions', 'ation', 'ations', 'ive', 'ively', 'ly', 'al', 'ally', 'ism', 'isms', 'ist', 'ists', 'ity', 'ness',
  'ment', 'ments', 'er', 'ers', 'or', 'ors', 'ic', 'ical', 'ize', 'ized', 'izes', 'izing', 'ent', 'ents', 'ence', 'ences', 'ant', 'ance', 'able', 'ible', 'ful',
];
const FORM_MIN_LETTERS = 5;
// Plain inflections (formed / forms / forming -> form) may leave a 4-letter base: they only add a verb or plural ending.
// The derivational suffixes above keep 5, so "state" never links to "statement".
const INFLECTIONS = new Set(['s', 'es', 'd', 'ed', 'ing']);
const INFLECTION_MIN_LETTERS = 4;
const formCache = new Map();
function wordForms(word) {
  let forms = formCache.get(word);
  if (!forms) {
    const base = (w) => w.replace(/e$/, '');
    forms = new Set([base(word)]);
    for (const suffix of FORM_SUFFIXES) {
      const rest = base(word.slice(0, word.length - suffix.length));
      const min = INFLECTIONS.has(suffix) ? INFLECTION_MIN_LETTERS : FORM_MIN_LETTERS;
      if (word.endsWith(suffix) && rest.length >= min) forms.add(rest);
    }
    formCache.set(word, forms);
  }
  return forms;
}
export const sameForm = (x, y) => x === y || [...wordForms(x)].some((f) => wordForms(y).has(f));
const exact = (a, b) => a.some((x) => b.some((y) => sameForm(x, y)));
// A word of a term (`term`) found as a word of a text (`text`), both lists of stems: a form of it (exact), or a shorter
// text word it starts with ("observ", from "observing", in "observational", which no ending rule reduces), never a
// longer text word that holds it ("databases" for "data"). termInText and maskTerm.
const PREFIX_MIN_LETTERS = 4;
const inTerm = (term, text) => exact(term, text) || text.some((x) => x.length >= PREFIX_MIN_LETTERS && term.some((y) => y.length > x.length && y.startsWith(x)));
const shared = (list, other, same = matches) => list.filter((w) => other.some((o) => same(w, o)));
const names = (list) => list.map((forms) => forms[0]);
const coverage = (part, whole) => (part.length ? shared(part, whole).length / part.length : 0);
const jaccard = (a, b) => {
  if (!a.length || !b.length) return 0;
  const n = shared(a, b).length;
  return n / (a.length + b.length - n);
};

// The words of a lesson for the off-topic check (rule f): every word under both languages' stems, so a Taglish
// lesson or an English word in a Filipino lesson is still found. `holds(stem)` is memoised; `count(stem)` is how
// often the lesson uses it. Cached by the text itself, so a changed or replaced lesson is read again.
class LessonWords {
  constructor(text) {
    this.counts = new Map();
    for (const w of words(text).filter(isContent))
      for (const s of new Set([stem(w), stem(w, 'en')])) this.counts.set(s, (this.counts.get(s) ?? 0) + 1);
    this.memo = new Map();
  }
  count(s) {
    return this.counts.get(s) ?? 0;
  }
  has(s) {
    return this.counts.has(s);
  }
  holds(s) {
    if (this.counts.has(s)) return true;
    if (!this.memo.has(s)) {
      let found = false;
      for (const l of this.counts.keys())
        if (sameWord(s, l)) {
          found = true;
          break;
        }
      this.memo.set(s, found);
    }
    return this.memo.get(s);
  }
}
const LESSON_CACHE = 20;
const lessonCache = new Map(); // raw text -> LessonWords, oldest first
export function lessonWords(text) {
  if (!text) return null;
  let entry = lessonCache.get(text);
  if (entry) lessonCache.delete(text);
  else entry = new LessonWords(text);
  lessonCache.set(text, entry);
  if (lessonCache.size > LESSON_CACHE) lessonCache.delete(lessonCache.keys().next().value);
  return entry;
}
// Whether two texts share a content word ("on the same subject").
export const sharesWord = (a, b) => {
  const other = wordStems(b);
  return wordStems(a).some((w) => other.some((o) => matches(w, o)));
};
// whether a lesson (a LessonWords, or a plain Set of stems as in tests) holds a word (a list of possible stems)
const lessonHolds = (lesson, forms) => forms.some((s) => (lesson.holds ? lesson.holds(s) : lesson.has(s) || [...lesson].some((l) => sameWord(s, l))));

// 'en', 'fil' or null when it can't tell (Taglish, a list of names).
export function language(text) {
  const ws = words(text);
  const fil = ws.filter((w) => FIL_MARKERS.has(w)).length;
  const en = ws.filter((w) => EN_MARKERS.has(w)).length;
  if (fil === en) return null;
  return fil > en ? 'fil' : 'en';
}

// "No. 5", "(no.)": the abbreviation of number, not a negative
const withoutNumberSign = (text) => String(text ?? '').replace(/\bno\.(?=\s*(?:\d|#|\)))/gi, ' ');
export const isNegative = (text) =>
  words(withoutNumberSign(text)).some((w) => NEGATIVE_WORDS.has(w) || NEGATIVE_EN.has(w) || NEGATIVE_FIL.has(w) || NEGATIVE_FIL_STEMS.has(stem(w)));
const fullSentence = (text) => /[.!?]$/.test(String(text).trim()) && wordCount(text) >= 4;
const opening = (text) => words(text).slice(0, 2).join(' ');
const plain = (s) => words(s).join(' ');

// Thresholds lean towards not flagging: a false flag drops a good question, and what these word checks miss is left
// to the prompts and the admin list.
export const ANSWER_COVERAGE = 0.8; // share of the answer's content words that, found in the question, give it away
export const RESTATES = 0.8; // front / back content-word overlap at which a flashcard's back only restates its front
export const NEAR_DUPLICATE = 0.7; // content-word overlap at which two options say the same thing
// overlap with the right answer at which a wrong option is the same claim reworded. English only: the Filipino stemmer
// cuts "nagkaroon" to "roon", so two options in the same sentence frame would share words that are not a claim
export const REWORDED = 0.36;
// Two enumerations (4 or more items, so 3 or more commas) share items by design: "transportation, technology, health,
// education, and decision-making" beside the same list with one item swapped is a different claim, not a reworded one.
const enumerations = (a, b) => [a, b].every((s) => (String(s).match(/,/g) ?? []).length >= 3);
export const ECHO_WORDS = 2; // question words only the right option repeats (besides the topic) that point at it
const LENGTH_RATIO = [0.6, 1.6]; // a wrong option's words / the right one's ...
const LENGTH_SLACK = 4; // ... or within this many words of it

// Rule a / g: the question (or front) gives the answer away. -> a reason, or null
export function answerInQuestion(question, answer) {
  const a = plain(answer);
  if (a && ` ${plain(question)} `.includes(` ${a} `)) return 'the question holds the answer';
  const answerWords = wordStems(answer);
  const questionWords = wordStems(question);
  if (answerWords.length >= 2 && coverage(answerWords, questionWords) >= ANSWER_COVERAGE)
    return `the question holds most of the answer (${names(shared(answerWords, questionWords)).join(', ')})`;
  // one word: the same word or a form of it, not a word that merely contains it ("data" in "database")
  if (answerWords.length === 1 && shared(answerWords, questionWords, exact).length) return `the question holds the answer word "${answerWords[0][0]}"`;
  return null;
}

// Rule l: a question that asks by a place in a list ("Which aim is listed first?", "the second purpose") instead of by
// what the item is. Only the unmistakable shapes: "first impression", "first aid" or "the first step of the method"
// ask about content and are not matched.
const PLACE = 'first|second|third|fourth|fifth|sixth|last|final';
const LIST_NOUNS = 'item|bullet|entry|aim|purpose|goal|objective|outcome|topic|lesson|section|component|characteristic|feature|benefit|reason|key element|way|method|type|kind|approach|technique|example';
// "a second way ...", "another third reason": an ordinal after an article asks for the item at that place. "first" is
// left out here ("a first impression", "a first draft" are ordinary phrases); step and stage are not nouns of this
// pattern, since a process lesson may teach its order.
const LATER_PLACE = 'second|third|fourth|fifth|sixth|2nd|3rd|[4-6]th';
const LATER_NOUNS = 'way|method|type|kind|form|approach|technique|reason|example|benefit|aim|purpose|goal|objective|outcome|topic|feature|characteristic|item';
const POSITION_PATTERNS = [
  new RegExp(`\\b(?:a|an|another|one more)\\s+(?:${LATER_PLACE})\\s+(?:${LATER_NOUNS})s?\\b`, 'i'),
  new RegExp(`\\b(?:the|which|what)\\s+(?:2nd|3rd|[4-6]th)\\s+(?:${LIST_NOUNS})s?\\b`, 'i'),
  new RegExp(`\\b(?:listed|mentioned|named|presented|shown|given)\\s+(?:${PLACE})\\b`, 'i'),
  new RegExp(`\\b(?:${PLACE})[- ](?:listed|mentioned|named)\\b`, 'i'),
  // one word may stand between: "the first learning objective", "the third main purpose" (not "the first step")
  new RegExp(`\\b(?:the|which|what)\\s+(?:${PLACE})\\s+(?:[a-z-]+\\s+)?(?:${LIST_NOUNS})s?\\b`, 'i'),
  new RegExp(`\\b(?:${PLACE})\\s+(?:one\\s+)?(?:in|on)\\s+the\\s+(?:list|slide)\\b`, 'i'),
  /\b(?:item|bullet|entry)\s+(?:no\.?\s*|number\s*|#)?\d+\b/i,
];
export const asksByPosition = (question) => POSITION_PATTERNS.some((p) => p.test(String(question ?? '')));

// Rule d / h: the term (or half of a multi-word term) appears in the text. -> the words found, or null. A word of the
// term is found as itself, a form of it (sameForm: "observing" for "Observation") or a shorter word it starts with
// ("observing" for "Observational": inTerm), never inside a longer word: a blank where the definition said "databases"
// under "Archival Data" left a fragment ("___ taken from existing records or ___.", lesson 32 card #742, Gemini audit
// 2026-10-18). The same match decides what maskTerm blanks, what counts as still showing the term and rules d / e, so
// they never disagree. `strict` (rule h, the flashcard itself): only forms (sameForm), and every word of a one- or
// two-word term (more than half of a longer one), so "Cell membrane" is not flagged for a definition that says "cell".
export function termInText(term, text, { strict = false } = {}) {
  const termWords = wordStems(term);
  if (!termWords.length) return null;
  const found = shared(termWords, wordStems(text), strict ? exact : inTerm);
  const enough = strict ? found.length === termWords.length || (termWords.length >= 3 && found.length * 2 > termWords.length) : found.length === termWords.length || (termWords.length >= 2 && found.length * 2 >= termWords.length);
  return enough ? names(found) : null;
}

// A definition with its own term blanked out, so "Does this describe X?" and "Which term matches?" don't answer
// themselves. Only words that are forms of the term's words (sameForm, as termInText finds them) are replaced; the rest
// is left as written. Each word is stemmed the way termInText stems the text, so every form it finds is blanked.
export function maskTerm(text, term) {
  if (!termInText(term, text)) return text;
  const termWords = wordStems(term);
  const lang = language(text);
  const masked = String(text).replace(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu, (w) => {
    const lower = w.normalize('NFKC').toLowerCase();
    return isContent(lower) && termWords.some((t) => inTerm(t, stemsOf(lower, lang))) ? '___' : w;
  });
  return masked.replace(/___(?:\s+___)+/g, '___');
}

// What is wrong with one wrong option next to the right answer (rules c and f). `lessonWords`: lessonWords(lesson
// text), for the off-topic check (skipped without it). `lengths: false` for term names, which differ in length
// on their own. `reworded: false` for the other items of a list in the lesson, which share the list's words on purpose;
// otherwise an option sharing REWORDED of its words with the right answer is the same claim in other words.
// -> [{ rule, detail }]
export function wrongOptionProblems(wrong, correct, { lessonWords = null, lengths = true, otherAnswers = [], reworded = true } = {}) {
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
  const own = wordStems(wrong);
  const overlap = jaccard(own, wordStems(correct));
  if (overlap >= NEAR_DUPLICATE) problems.push({ rule: 'f', detail: 'the right answer’s own words: reworded (a second right answer) or reversed' });
  else if (reworded && lc !== 'fil' && lw !== 'fil' && !enumerations(wrong, correct) && overlap >= REWORDED) problems.push({ rule: 'f', detail: 'the right answer’s own words: nearly the same claim reworded (a second right answer)' });
  // another card's answer reads as the answer to that other question, so a student can match it away
  if (otherAnswers.some((a) => jaccard(own, wordStems(a)) >= NEAR_DUPLICATE)) problems.push({ rule: 'f', detail: 'another card’s answer: it answers a different question' });
  if (lessonWords && own.length >= 2 && !own.some((w) => lessonHolds(lessonWords, w))) problems.push({ rule: 'f', detail: 'about nothing in the lesson' });
  return problems;
}

// The question's topic: its word the lesson uses most (needs lessonWords() counts). A right answer naturally names
// what the question is about, so that word alone never points at it.
function topicOf(questionWords, lessonWords) {
  if (!lessonWords?.count) return null;
  let best = null;
  let most = 0;
  for (const w of questionWords) {
    const n = Math.max(...w.map((s) => lessonWords.count(s)));
    if (n > most) [best, most] = [w, n];
  }
  return best;
}

// What gives the right option away among a full set of options (rules b, c, f). `lessonWords`: lessonWords(lesson
// text), to find the question's topic for rule b. -> [{ rule, detail }]
export function optionSetProblems(question, correct, wrong, { lessonWords = null } = {}) {
  const problems = [];
  if (!wrong.length) return problems;
  const questionWords = wordStems(question);
  // words of the question that the right option repeats and no wrong option does ("ugat" and "sanga" in a question
  // about roots and branches) point at the right one, even when every option shares the lesson's common words
  // ("wika"). At least ECHO_WORDS of them besides the topic, each the same word (not "data" in "database").
  const topic = topicOf(questionWords, lessonWords);
  const echo = shared(wordStems(correct), questionWords, exact).filter((e) => !(topic && exact(e, topic)));
  const only = echo.filter((e) => !wrong.some((w) => shared(wordStems(w), [e], exact).length));
  if (only.length >= ECHO_WORDS) problems.push({ rule: 'b', detail: `only the right option repeats the question (${names(only).join(', ')})` });
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
      if (jaccard(wordStems(wrong[i]), wordStems(wrong[j])) >= NEAR_DUPLICATE) problems.push({ rule: 'f', detail: `near-duplicate wrong options ${i + 1} and ${j + 1}` });
  return problems;
}

// A false Yes/No statement that is false from its wording alone (rule e). `reworded: true` (a concept card's own wrong
// answers, not list items) also refuses one sharing REWORDED of its words with the answer. -> [{ rule, detail }]
export function falseStatementProblems(statement, answer, { reworded = false } = {}) {
  const problems = [];
  if (isNegative(statement) && !isNegative(answer)) problems.push({ rule: 'e', detail: 'a negative or reversed statement' });
  const la = language(answer);
  const ls = language(statement);
  if (la && ls && la !== ls) problems.push({ rule: 'e', detail: 'another language' });
  const threshold = reworded && la !== 'fil' && ls !== 'fil' && !enumerations(statement, answer) ? REWORDED : NEAR_DUPLICATE;
  if (jaccard(wordStems(statement), wordStems(answer)) >= threshold) problems.push({ rule: 'e', detail: 'the right answer’s own words: reworded (so it may be true) or reversed' });
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
      problems.push(...optionSetProblems(q.question, correct, wrong, { lessonWords }));
    }
    for (const w of wrong) problems.push(...wrongOptionProblems(w, correct, { lessonWords, lengths: q.kind !== 'term', reworded: q.kind !== 'term' }).map((p) => ({ ...p, detail: `${p.detail}: "${w}"` })));
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

// Rule m: a question that ends in a hint tail, "…help researchers do regarding decisions?", where a word of the tail
// is a word of the answer ("Make informed decisions"). The tail only points at the answer: the question should ask
// by the item's meaning. -> the shared words, or null.
const HINT_TAIL = /\b(?:regarding|related to|concerning|in terms of|with regard to|in relation to)\s+(.+?)[?.\s]*$/i;
export function hintTail(question, answer) {
  const tail = HINT_TAIL.exec(String(question ?? ''))?.[1];
  if (!tail) return null;
  const found = shared(wordStems(tail), wordStems(answer), exact);
  return found.length ? names(found) : null;
}

// The rules that make a flashcard give its answer away during flashcard study (h is only reported: see above).
export const CARD_LEAK_RULES = ['g', 'i', 'j', 'k', 'l', 'm'];

// Rules g-k for one flashcard. `others`: the lesson's other cards, for rule j. -> [{ rule, detail }]
export function cardLeaks(card, others = []) {
  const problems = [];
  // a term card's front is the term itself: its definition holding the term is rule h, not g
  const given = card.kind === 'term' ? null : answerInQuestion(card.front, card.back);
  if (given) problems.push({ rule: 'g', detail: given.replace('question', 'front') });
  if (card.kind === 'term') {
    const found = termInText(card.front, card.back, { strict: true });
    if (found) problems.push({ rule: 'h', detail: `the definition holds the term (${found.join(', ')})` });
  } else {
    const ws = words(card.front);
    const joined = ws.join(' ');
    // "ba" makes a yes/no question only without a question word: "Ano ba ang…?" still asks what
    const yesNoBa = ws.includes('ba') && !ws.some((w) => WH_WORDS.has(w));
    if (/^(?:is|are|does|do|did|can|could|was|were|will|would|should|has|have|had)$/.test(ws[0] ?? '') || /\b(?:o hindi|or not)\b/.test(joined) || yesNoBa)
      problems.push({ rule: 'i', detail: 'a yes/no or either/or question' });
    if (asksByPosition(card.front)) problems.push({ rule: 'l', detail: 'asks by place in the list' });
    const hint = hintTail(card.front, card.back);
    if (hint) problems.push({ rule: 'm', detail: `a hint tail repeats the answer (${hint.join(', ')})` });
  }
  const front = wordStems(card.front);
  for (const other of others) {
    if (other === card || (other.id != null && other.id === card.id)) continue;
    const answerWords = wordStems(other.back);
    if (answerWords.length >= 3 && coverage(answerWords, front) >= 0.8) problems.push({ rule: 'j', detail: `the front holds the answer of "${other.front}"` });
  }
  if (card.kind !== 'term') {
    const back = wordStems(card.back);
    // "Bakit mahalaga ang wika…?" -> "Mahalaga ang wika dahil…" repeats the claim and adds the reason: not a restatement
    if (jaccard(front, back) >= RESTATES) problems.push({ rule: 'k', detail: 'front and back are nearly the same' });
    else if (back.length >= 2 && coverage(back, front) >= RESTATES) problems.push({ rule: 'k', detail: 'the back only restates the front' });
  }
  return problems;
}
