import { NOTES_LABEL } from '../ai/chunk.js';

// The lesson's lists, for list-item cards ("Which purpose of a self-introduction is about trust?" -> "Build
// relationships and trust."). Their wrong options are the other items of the same list, chosen in code the way a term
// card's are the other key terms: real lesson words, the same shape as the right answer, and wrong for this question.
// Pure: the quiz builder (build.js), the wrong-answers stage (distractors.js) and the AI review use it.

const LIST_ITEM = /^(?:-|\d+[.)])\s+(.+)$/; // "- item" or "1. item"; an en dash sub-line ("– explain…") is not an item
const MAX_ITEM_WORDS = 20;
const MIN_ITEMS = 3; // two bullets are not a list to choose from

// An item as compared: case, spaces and a closing full stop (or ! ? ; :) ignored.
const itemKey = (s) =>
  String(s ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!?;:]+$/, '')
    .toLowerCase();

// [[item, ...]]: the bullet and numbered lines of each block (a slide or page) before its Notes:, for blocks with at
// least 3 of them.
export function listGroups(lessonText) {
  const groups = [];
  for (const block of String(lessonText ?? '').split(/\n{2,}/)) {
    const items = [];
    for (const line of block.split('\n')) {
      if (line.trim() === NOTES_LABEL) break;
      const text = LIST_ITEM.exec(line.trim())?.[1]?.trim();
      if (!text || text.split(/\s+/).length > MAX_ITEM_WORDS) continue;
      if (!items.some((i) => itemKey(i) === itemKey(text))) items.push(text);
    }
    if (items.length >= MIN_ITEMS) groups.push(items);
  }
  return groups;
}

// The other items of the list `answer` is an item of (exactly, as itemKey compares), or null when it is not one.
export function siblingItems(groups, answer) {
  const key = itemKey(answer);
  const group = key ? groups.find((g) => g.some((i) => itemKey(i) === key)) : null;
  return group ? group.filter((i) => itemKey(i) !== key) : null;
}

export const sameItem = (a, b) => itemKey(a) === itemKey(b);
