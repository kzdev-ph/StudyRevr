// Checks the slide / page numbers a model gives as the source of a review section. The model's answer is only a
// claim: a number is kept when it is a whole number between 1 and the file's real slide / page count AND is the
// number of a block the model was actually shown for this section (`allowed`), since it can't have used any other.
// A "3-5" range is expanded, then every number in it is checked the same way.

const MAX_RANGE = 60;

// -> { numbers: [ascending, distinct] | null, dropped: [anything that was refused] }. `numbers` is null when
// nothing valid is left, which means "no known source" (not "an empty source").
export function validateSources(raw, { allowed, total }) {
  const dropped = [];
  const kept = new Set();
  const consider = (n, original) => {
    if (Number.isInteger(n) && n >= 1 && (!total || n <= total) && allowed.has(n)) kept.add(n);
    else dropped.push(original);
  };
  for (const item of Array.isArray(raw) ? raw : []) {
    if (typeof item === 'number') consider(item, item);
    else if (typeof item === 'string' && /^\s*\d+\s*$/.test(item)) consider(Number(item), item);
    else if (typeof item === 'string' && /^\s*\d+\s*[-–]\s*\d+\s*$/.test(item)) {
      const [from, to] = item.split(/[-–]/).map(Number);
      if (to < from || to - from >= MAX_RANGE) dropped.push(item);
      else for (let n = from; n <= to; n++) consider(n, n);
    } else dropped.push(item);
  }
  return { numbers: kept.size ? [...kept].sort((a, b) => a - b) : null, dropped };
}
