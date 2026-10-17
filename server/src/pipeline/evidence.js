// Grounding for key terms: a term is kept only if the quote the AI gives as evidence really is in the lesson text
// and says something about the term (not just its title). This stops the model defining a term from its own knowledge.

export const MAX_EVIDENCE_WORDS = 25;
export const MAX_CHECK_EVIDENCE_WORDS = 40; // a quick check's quote may be longer: it has to hold the reason too
const MIN_EXPLAINING_WORDS = 3; // words in the quote that are not the term itself
const MIN_CUT_WORDS = 8; // a cut at a boundary must keep at least this many words
const SENTENCE_END = /[.!?;:—]["')”’]*$/;
const CLAUSE_END = /[,–-]["')”’]*$/;

const words = (s) => String(s).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

// Case, spacing, punctuation, bullets and line-end hyphens all vanish, so "word-\nnext", "Word - Next" and
// "wordnext" compare equal. Whole quotes are compared, so the looseness can't make a short quote match by accident.
export const comparable = (s) => words(s).join('');

// A quote longer than `max` words cut where a sentence or clause ends, not in the middle of a phrase (a prefix of a
// verbatim quote is still verbatim): the last sentence end within `max` words, else the last comma or dash, else the
// next sentence end up to `max` + TRIM_REACH words, else (no boundary anywhere near) the first `max` words.
const TRIM_REACH = 15;
export function trimQuote(quote, max = MAX_EVIDENCE_WORDS) {
  const tokens = String(quote).split(' ');
  if (tokens.length <= max) return tokens.join(' ');
  const last = (pattern, from, to) => {
    for (let n = to; n >= from; n--) if (pattern.test(tokens[n - 1])) return n;
    return 0;
  };
  const first = (pattern, from, to) => {
    for (let n = from; n <= to; n++) if (pattern.test(tokens[n - 1])) return n;
    return 0;
  };
  const upTo = Math.min(max, tokens.length);
  const cut = last(SENTENCE_END, MIN_CUT_WORDS, upTo) || last(CLAUSE_END, MIN_CUT_WORDS, upTo) || first(SENTENCE_END, upTo + 1, Math.min(max + TRIM_REACH, tokens.length)) || max;
  return tokens.slice(0, cut).join(' ');
}

// -> { ok: true, evidence } with the quote tidied and cut to about `maxWords` words by trimQuote, or { ok: false,
// reason }. `sourceKey` is comparable(lesson text), computed once by the caller.
// `minExplaining`: words the quote must have besides the term's (a concept card's list item, "Builds confidence.",
// needs only 2).
export function checkEvidence({ term, evidence, sourceKey, minExplaining = MIN_EXPLAINING_WORDS, maxWords = MAX_EVIDENCE_WORDS }) {
  const quote = String(evidence ?? '')
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '')
    .replace(/\s+/g, ' ');
  if (!quote) return { ok: false, reason: 'no evidence quote' };
  const termWords = new Set(words(term));
  const explaining = words(quote).filter((w) => !termWords.has(w));
  if (explaining.length < minExplaining) return { ok: false, reason: 'evidence is only the term or a title' };
  if (!sourceKey.includes(comparable(quote))) return { ok: false, reason: 'evidence not found in the lesson text' };
  return { ok: true, evidence: trimQuote(quote, maxWords) };
}
