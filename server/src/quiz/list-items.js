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

// Learning objectives, outline and agenda slides say what the lesson will cover, not what it teaches: nothing is asked
// from them. A block is one when a short heading line says so ("Learning Objectives:", "At the end of this lesson",
// "Outline", "Agenda"; the heading may come after the text, as in a pptx that sets the objectives before their title),
// or when two or more of its lines are "Students will be able to…" / "By the end of this lesson…".
const OBJECTIVE_HEADING = /^(?:(?:intended\s+)?learning\s+(?:objectives?|outcomes?|targets?)|(?:lesson|session|class|course|module)\s+(?:objectives?|outcomes?|outline|agenda|overview)|objectives?|outline|agenda|(?:at|by)\s+the\s+end\s+of\b.*|what\s+we\s+will\s+(?:learn|cover)|today'?s\s+(?:objectives?|agenda|outline))$/i;
const OBJECTIVE_LINE = /^(?:[-\d.)\s]*)(?:(?:students|learners|you)\s+(?:will|should|shall)\s+be\s+able\s+to\b|(?:at|by)\s+the\s+end\s+of\s+(?:this|the|today'?s)\s+(?:lesson|session|class|module|discussion))/i;
const MAX_HEADING_WORDS = 8;

export function isObjectiveBlock(block) {
  let objectiveLines = 0;
  for (const raw of String(block ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line === NOTES_LABEL) break;
    const heading = line.replace(/[:.]+$/, '').trim();
    if (!LIST_ITEM.test(line) && heading.split(/\s+/).length <= MAX_HEADING_WORDS && OBJECTIVE_HEADING.test(heading)) return true;
    if (OBJECTIVE_LINE.test(line)) objectiveLines += 1;
  }
  return objectiveLines >= 2;
}

// The lesson without its objective / outline / agenda blocks (blocks are separated by a blank line).
export function withoutObjectives(lessonText) {
  return String(lessonText ?? '')
    .split(/\n{2,}/)
    .filter((block) => !isObjectiveBlock(block))
    .join('\n\n');
}

// A quote that is in the lesson only inside objective blocks. The three arguments are comparable() keys (as in
// pipeline/evidence.js): the quote, the whole lesson and the lesson without those blocks.
export const onlyInObjectives = (key, fullKey, bodyKey) => Boolean(key) && fullKey.includes(key) && !bodyKey.includes(key);

const wordsOf = (s) => String(s ?? '').trim().split(/\s+/).filter(Boolean);
// A name ("Clear and Concise Language", "Bias"): no closing full stop and every longer word capitalised. A phrase or
// sentence ("Builds confidence.", "Makes studies easier to replicate") is not.
const nameShaped = (s) => !/[.!?]["')”’]*$/.test(String(s).trim()) && wordsOf(s).filter((w) => w.length > 3).every((w) => /^[\p{Lu}\d(]/u.test(w));

// Whether `item` can stand beside `answer` as another option: both names or both phrases, and not much longer or
// shorter ("Bias" is no sibling of "Makes studies easier to replicate", nor a 14-word sentence of "Test hypotheses").
export function sameShape(answer, item) {
  const a = wordsOf(answer).length;
  const b = wordsOf(item).length;
  return nameShaped(answer) === nameShaped(item) && Math.max(a, b) <= 2 * Math.min(a, b) + 3;
}

// [[item, ...]]: the bullet and numbered lines of each block (a slide or page) before its Notes:, for blocks with at
// least 3 of them. A line ending in ":" ("Reduces the risk of:", "- Helps gather information about:") introduces a
// sub-list: it ends the list before it and a new list starts after it. Objective blocks are skipped.
export function listGroups(lessonText) {
  const groups = [];
  for (const block of String(lessonText ?? '').split(/\n{2,}/)) {
    if (isObjectiveBlock(block)) continue;
    let items = [];
    const flush = () => {
      if (items.length >= MIN_ITEMS) groups.push(items);
      items = [];
    };
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === NOTES_LABEL) break;
      if (/:["')”’]*$/.test(trimmed)) {
        flush();
        continue;
      }
      const text = LIST_ITEM.exec(trimmed)?.[1]?.trim();
      if (!text || text.split(/\s+/).length > MAX_ITEM_WORDS) continue;
      if (!items.some((i) => itemKey(i) === itemKey(text))) items.push(text);
    }
    flush();
  }
  return groups;
}

// The other items of the list `answer` is an item of (exactly, as itemKey compares) that have its shape (sameShape,
// judged on the list's own item, so the card's casing doesn't matter), or null when it is not an item of a list or none
// of its list's other items has its shape (callers treat any non-null value as "a list item": a card with no usable
// siblings falls back to AI wrong answers like any concept card). Each is written with the answer's closing full stop (or none), so the stop alone never marks the right option: the AI
// writes a card's answer with one while a lesson's list lines often have none.
export function siblingItems(groups, answer) {
  const key = itemKey(answer);
  const group = key ? groups.find((g) => g.some((i) => itemKey(i) === key)) : null;
  const own = group?.find((i) => itemKey(i) === key);
  if (!group) return null;
  const stop = /\.\s*$/.test(String(answer));
  const likeAnswer = (i) => (stop ? (/\.\s*$/.test(i) ? i : `${i.trim()}.`) : i.replace(/\.\s*$/, ''));
  const siblings = group.filter((i) => itemKey(i) !== key && sameShape(own, i)).map(likeAnswer);
  return siblings.length ? siblings : null;
}

export const sameItem = (a, b) => itemKey(a) === itemKey(b);
