import { comparable } from '../pipeline/evidence.js';

// The lesson text one AI call is shown. Pure, and kept apart from services/quiz-review.js so quiz/distractors.js can use
// it without an import cycle (quiz-review.js imports distractors.js).
const CONTEXT_CHARS = 16000;

// The lesson for one call: all of it when short, else the blocks around the batch's quotes (one on each side).
export function contextForBatch(rawText, evidences) {
  const text = String(rawText ?? '');
  if (text.length <= CONTEXT_CHARS) return text;
  const blocks = text.split(/\n\s*\n/);
  const keys = blocks.map(comparable);
  const keep = new Set();
  for (const evidence of evidences) {
    const key = comparable(evidence ?? '');
    const at = key ? keys.findIndex((b) => b.includes(key)) : -1;
    if (at >= 0) for (const i of [at - 1, at, at + 1]) if (i >= 0 && i < blocks.length) keep.add(i);
  }
  if (!keep.size) return text.slice(0, CONTEXT_CHARS);
  return [...keep]
    .sort((a, b) => a - b)
    .map((i) => blocks[i])
    .join('\n\n')
    .slice(0, CONTEXT_CHARS * 2);
}
