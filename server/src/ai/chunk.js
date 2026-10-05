// Splits lesson text into pieces small enough for ~8k-context models (the prompt and the reply share that window).
//
// Input is the `raw_text` format: blocks (slides / pages) separated by a blank line, one paragraph per line.
// Rules: never split a paragraph; prefer to cut between blocks; before a heading when there's a choice; keep a
// slide's "Notes:" with its slide whenever the slide fits in one chunk.

export const NOTES_LABEL = 'Notes:';
// Lesson text per request. Prompt (~700) + this + the reply (up to ~4000) stays under 8192 tokens.
export const DEFAULT_CHUNK_TOKENS = 2400;

// Cheap, tokenizer-free estimate. 3 chars/token is pessimistic for English and about right for Filipino/Taglish.
export const estimateTokens = (text) => Math.ceil(text.length / 3);

const SEPARATOR_TOKENS = 1; // the blank line between blocks

// A short single line with no sentence punctuation: a title, a heading, or a title-only slide.
export function isHeadingLike(block) {
  if (block.includes('\n') || block.length > 90 || /^(?:[-–•]|\d+[.)])\s/.test(block)) return false;
  return block.split(/\s+/).length <= 12 && !/[.!?:;,]$/.test(block);
}

export const splitBlocks = (rawText) =>
  String(rawText ?? '')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

// A block that is bigger than the budget is cut at paragraph (line) boundaries. When the cut lands inside the
// speaker notes, the next piece starts with "Notes:" again so the model still knows those lines are notes, and a
// "Notes:" label is never left stranded at the end of a piece. A paragraph over budget stays whole.
function splitBlock(block, budget) {
  if (estimateTokens(block) <= budget) return [block];
  const pieces = [];
  let piece = [];
  let tokens = 0;
  let inNotes = false;
  const startPiece = () => {
    piece = inNotes ? [NOTES_LABEL] : [];
    tokens = piece.length ? estimateTokens(NOTES_LABEL) + 1 : 0;
  };
  for (const line of block.split('\n')) {
    const cost = estimateTokens(line) + 1;
    const hasContent = piece.some((l) => l !== NOTES_LABEL);
    if (hasContent && tokens + cost > budget) {
      if (piece.at(-1) === NOTES_LABEL) piece.pop();
      pieces.push(piece.join('\n'));
      startPiece();
    }
    if (line === NOTES_LABEL) inNotes = true;
    piece.push(line);
    tokens += cost;
  }
  if (piece.some((l) => l !== NOTES_LABEL)) pieces.push(piece.join('\n'));
  return pieces;
}

// Packs blocks (strings, possibly multi-line) into chunks of at most `maxTokens`. Returns [{ index, text, tokens }].
// `numbers` (optional) gives the slide / page number of each block, in the same order. Each chunk then also has
// `parts` ([{ text, number }], the pieces in order; a block cut in two gives two parts with the same number) and
// `numbers` (the distinct block numbers it holds), so a caller can say where each piece of a chunk came from.
export function chunkBlocks(blocks, { maxTokens = DEFAULT_CHUNK_TOKENS, numbers } = {}) {
  const numbered = Array.isArray(numbers) && numbers.length === blocks.length;
  const units = blocks.flatMap((b, i) => splitBlock(b, maxTokens).map((text) => ({ text, number: numbered ? numbers[i] : undefined })));
  const cost = (u) => estimateTokens(u.text) + SEPARATOR_TOKENS;
  const sum = (arr) => arr.reduce((n, u) => n + cost(u), 0);

  const groups = [];
  let cur = [];
  let curTokens = 0;
  for (const unit of units) {
    const unitCost = cost(unit);
    if (cur.length && curTokens + unitCost > maxTokens) {
      // Default cut is right here, between blocks. If a heading sits in the back half of the chunk, cut before it
      // instead so a heading never ends a chunk with its content in the next one.
      let cut = cur.length;
      for (let i = cur.length - 1; i >= 1; i--) {
        if (isHeadingLike(cur[i].text) && sum(cur.slice(0, i)) >= maxTokens / 2 && sum(cur.slice(i)) + unitCost <= maxTokens) {
          cut = i;
          break;
        }
      }
      groups.push(cur.slice(0, cut));
      cur = cur.slice(cut);
      curTokens = sum(cur);
    }
    cur.push(unit);
    curTokens += unitCost;
  }
  if (cur.length) groups.push(cur);

  return groups.map((group, index) => {
    const text = group.map((u) => u.text).join('\n\n');
    const chunk = { index, text, tokens: estimateTokens(text) };
    if (numbered) {
      chunk.parts = group.map(({ text: partText, number }) => ({ text: partText, number }));
      chunk.numbers = [...new Set(group.map((u) => u.number))];
    }
    return chunk;
  });
}

export const chunkLesson = (rawText, opts) => chunkBlocks(splitBlocks(rawText), opts);
