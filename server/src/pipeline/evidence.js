// Grounding for key terms: a term is kept only if the quote the AI gives as evidence really is in the lesson text
// and says something about the term (not just its title). This stops the model defining a term from its own knowledge.

export const MAX_EVIDENCE_WORDS = 25;
const MIN_EXPLAINING_WORDS = 3; // words in the quote that are not the term itself

const words = (s) => String(s).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

// Case, spacing, punctuation, bullets and line-end hyphens all vanish, so "word-\nnext", "Word - Next" and
// "wordnext" compare equal. Whole quotes are compared, so the looseness can't make a short quote match by accident.
export const comparable = (s) => words(s).join('');

// -> { ok: true, evidence } with the quote tidied and cut to MAX_EVIDENCE_WORDS words (a prefix of a verbatim quote is
// still verbatim), or { ok: false, reason }. `sourceKey` is comparable(lesson text), computed once by the caller.
export function checkEvidence({ term, evidence, sourceKey }) {
  const quote = String(evidence ?? '')
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '')
    .replace(/\s+/g, ' ');
  if (!quote) return { ok: false, reason: 'no evidence quote' };
  const termWords = new Set(words(term));
  const explaining = words(quote).filter((w) => !termWords.has(w));
  if (explaining.length < MIN_EXPLAINING_WORDS) return { ok: false, reason: 'evidence is only the term or a title' };
  if (!sourceKey.includes(comparable(quote))) return { ok: false, reason: 'evidence not found in the lesson text' };
  return { ok: true, evidence: quote.split(' ').slice(0, MAX_EVIDENCE_WORDS).join(' ') };
}
