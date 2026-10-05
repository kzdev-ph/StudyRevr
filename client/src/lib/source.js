// Finds which parts of the uploaded file a review section was written from.
// Sections don't record their source, so this is a best match: each block of the file (a slide, a PDF page or a
// Word paragraph, separated by a blank line in raw_text) is scored by how much of the section's vocabulary it holds.

const STOPWORDS = new Set(
  `the and for are was were with that this these those from have has had not but you your they their them its into
  about than then also such can may might will would should could which what when where who whom how why each other
  more most some any all one two use used using been being between within without over under per via our out`.split(/\s+/),
);

const stem = (w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

function tokens(text) {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w)).map(stem));
}

export function splitBlocks(rawText) {
  return String(rawText ?? '')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
}

const MAX_BLOCKS = 5;
const MAX_WORDS = 450;
const KEEP_RATIO = 0.3; // a block must score at least this fraction of the best block to be shown
const MIN_COVERAGE = 0.08; // below this the match is just noise

// -> [{ index, text }] in file order. `index` is the block's place in the file (0-based). Empty when nothing matches.
export function matchSource(sectionText, rawText) {
  const blocks = splitBlocks(rawText);
  const wanted = tokens(sectionText);
  if (!blocks.length || !wanted.size) return [];

  const blockTokens = blocks.map(tokens);
  const idf = new Map();
  for (const w of wanted) {
    const df = blockTokens.filter((t) => t.has(w)).length;
    idf.set(w, Math.log(1 + blocks.length / (df || 1)));
  }
  const total = [...idf.values()].reduce((a, b) => a + b, 0);
  const scored = blockTokens
    .map((t, index) => ({ index, score: [...wanted].reduce((sum, w) => sum + (t.has(w) ? idf.get(w) : 0), 0) / total }))
    .filter((b) => b.score >= MIN_COVERAGE)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  if (!scored.length) return [];

  const picked = [];
  let words = 0;
  for (const b of scored) {
    if (b.score < scored[0].score * KEEP_RATIO && picked.length) break;
    const size = blocks[b.index].split(/\s+/).length;
    if (picked.length && (picked.length >= MAX_BLOCKS || words + size > MAX_WORDS)) continue;
    picked.push(b);
    words += size;
  }
  return picked.sort((a, b) => a.index - b.index).map((b) => ({ index: b.index, text: blocks[b.index] }));
}
