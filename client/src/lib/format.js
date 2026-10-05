// Display helpers. They only change how stored text is shown; nothing here is written back to the database.

const ABBREVIATIONS = /(?:\b(?:e\.g|i\.e|etc|vs|cf|dr|mr|mrs|ms|prof|fig|no|approx)|\b[A-Za-z])\.$/i;

// "One. Two? Three!" -> sentences. A full stop after an abbreviation or a single letter does not end a sentence.
export function splitSentences(text) {
  const pieces = text.split(/(?<=[.!?])["')\]]?\s+(?=["'(\[]?[A-Z0-9])/u);
  const out = [];
  for (const piece of pieces) {
    const prev = out[out.length - 1];
    if (prev && ABBREVIATIONS.test(prev)) out[out.length - 1] = `${prev} ${piece}`;
    else out.push(piece);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

const WALL = 380; // a paragraph longer than this is a wall of text and gets split for display
const GROUP = 240; // aim for display paragraphs about this long

// Splits one long paragraph into shorter ones at sentence ends. Short paragraphs, and text with no sentence breaks,
// come back unchanged.
export function splitWall(paragraph) {
  if (paragraph.length <= WALL) return [paragraph];
  const sentences = splitSentences(paragraph);
  if (sentences.length < 2) return [paragraph];
  const groups = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && current.length + 1 + sentence.length > GROUP) {
      groups.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) groups.push(current);
  return groups;
}

// A lesson titled from its file name ("Nature_of_Inquiry.pptx" -> "Nature_of_Inquiry") reads better without underscores.
export const prettyTitle = (title) => String(title ?? '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();

// Models sometimes write a bulleted list on one line ("... end. - Next item"); put each bullet on its own line.
const splitInlineBullets = (text) => text.replace(/([.!?])\s+-\s+(?=["“(]?[A-Z0-9])/g, '$1\n- ');

// Section text -> display blocks: [{ type: 'p', text } | { type: 'ul', items: [text] }].
// Blank lines and single line breaks both start a new paragraph; consecutive "- " lines become one list.
export function toBlocks(content) {
  const blocks = [];
  for (const raw of splitInlineBullets(String(content ?? '')).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      const last = blocks[blocks.length - 1];
      if (last?.type === 'ul') last.items.push(bullet[1]);
      else blocks.push({ type: 'ul', items: [bullet[1]] });
    } else {
      for (const text of splitWall(line)) blocks.push({ type: 'p', text });
    }
  }
  return blocks;
}

// Cuts text at a word boundary and adds an ellipsis when it is longer than `max`; shorter text is returned as is.
export function truncateAtWord(text, max = 200) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const atBoundary = /\s/.test(clean[max]);
  const trimmed = (atBoundary ? cut : cut.replace(/\s+\S*$/, '')).replace(/[\s,;:\-–—(]+$/, '');
  return `${trimmed || cut.trim()}…`;
}

const WORDS_PER_MINUTE = 200;

export const countWords = (text) => (String(text ?? '').match(/\S+/g) ?? []).length;

// Minutes to read the review sections (at least 1).
export function readingMinutes(sections) {
  const words = sections.reduce((sum, s) => sum + countWords(s.title) + countWords(s.content), 0);
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}
