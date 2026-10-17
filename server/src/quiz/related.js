import { termKey } from '../pipeline/terms.js';

// Two key terms are related when one could be a right answer for the other's definition: a term and its own kind
// ("Self-Introduction" and "Written Self-Introduction": every written self-introduction is a self-introduction), or two
// terms the AI review put in the same family. A related term is never a wrong option or a false statement for the
// other: a student who picks it is not wrong. Sibling kinds ("Written" vs "Oral Self-Introduction") stay usable unless
// the review groups them.

const termWords = (term) => termKey(term).split(' ').filter(Boolean);

// true when the words of `inner` appear in order, side by side, inside `outer` ("self introduction" in "written self
// introduction"; "cell" in "cell membrane")
function containsWords(outer, inner) {
  if (!inner.length || inner.length > outer.length) return false;
  for (let i = 0; i + inner.length <= outer.length; i++) {
    if (inner.every((w, j) => outer[i + j] === w)) return true;
  }
  return false;
}

// families: [[term, term, ...], ...] (names as the lesson writes them) -> Map termKey -> Set of family numbers
export function familyIndex(families = []) {
  const index = new Map();
  (families ?? []).forEach((family, n) => {
    for (const name of family ?? []) {
      const key = termKey(name);
      if (!key) continue;
      if (!index.has(key)) index.set(key, new Set());
      index.get(key).add(n);
    }
  });
  return index;
}

// a, b: term names; families: a familyIndex (or the plain list)
export function relatedTerms(a, b, families = new Map()) {
  const wa = termWords(a);
  const wb = termWords(b);
  if (!wa.length || !wb.length) return false;
  if (containsWords(wa, wb) || containsWords(wb, wa)) return true;
  const index = families instanceof Map ? families : familyIndex(families);
  const fa = index.get(termKey(a));
  const fb = index.get(termKey(b));
  return Boolean(fa && fb && [...fa].some((n) => fb.has(n)));
}

// The families the review returned, without the groups that only repeat containment or join siblings: a group with a
// term whose words are inside every other one (a term and its own kinds: containment already relates them, and the
// family would relate the kinds to each other too), or a group whose terms all end in the same word (kinds of one
// thing, "Written" and "Oral Self-Introduction", which mean different things). Families are meant for synonyms.
export function usableFamilies(families = []) {
  return (families ?? []).filter((group) => {
    const words = group.map(termWords);
    if (words.some((inner, i) => words.every((outer, j) => i === j || containsWords(outer, inner)))) return false;
    const heads = new Set(words.map((w) => w.at(-1)));
    return heads.size > 1;
  });
}
