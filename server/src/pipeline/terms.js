// Helpers for combining the key terms found in different chunks of a lesson.

// "Media Channels", "media channel" and "media-channel!" are the same term. Each word loses a trailing plural
// ("-ies" -> "-y", "-ses/-xes/-ches/-shes/-zes" -> without "es", other "-s" unless it is "-ss", "-us" or "-is").
const singular = (w) => {
  if (w.length <= 3) return w;
  if (/ies$/.test(w)) return `${w.slice(0, -3)}y`;
  if (/(?:[sxz]|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w) && !/(?:ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
};

export const termKey = (term) =>
  (String(term).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(singular).join(' ');

// terms: [{ term, definition, evidence }] best-first -> [{ term, versions: [{ definition, evidence }] }], one group per
// distinct term. The first spelling wins; every definition/evidence given for the same term is kept as a version, so a
// later merge step can pick the best one without inventing anything.
export function groupTerms(terms) {
  const groups = new Map();
  for (const { term, definition, evidence } of terms) {
    const key = termKey(term);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { term, versions: [] });
    groups.get(key).versions.push({ definition, evidence });
  }
  return [...groups.values()];
}
