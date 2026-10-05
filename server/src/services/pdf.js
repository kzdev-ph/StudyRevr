import { getDocumentProxy, extractText as extractPdfPages } from 'unpdf';
import { normalizeText } from './text.js';

// ---- Header/footer removal ------------------------------------------------------------------
// Short lines are compared with digits masked so "Page 3" and "Page 4" match; longer lines must match
// exactly so numbered body text ("Question 1 ...", "Step 2 ...") isn't mistaken for a footer.
const REPEAT_MIN_PAGES = 3;
const REPEAT_SHARE = 0.6;
const REPEAT_MAX_LINE = 120;
const MASK_DIGITS_MAX_LINE = 40;
const lineKey = (line) => {
  const flat = line.replace(/\s+/g, ' ').trim().toLowerCase();
  return flat.length <= MASK_DIGITS_MAX_LINE ? flat.replace(/\d+/g, '#') : flat;
};

// Takes one string per page; drops lines that repeat on most pages (headers, footers, page numbers).
export function stripRepeatedLines(pages) {
  if (pages.length < REPEAT_MIN_PAGES) return pages;
  const pageLines = pages.map((p) => p.split('\n').map((l) => l.trim()).filter(Boolean));
  const seenOn = new Map();
  for (const lines of pageLines) {
    for (const key of new Set(lines.filter((l) => l.length <= REPEAT_MAX_LINE).map(lineKey))) {
      seenOn.set(key, (seenOn.get(key) ?? 0) + 1);
    }
  }
  const threshold = Math.max(REPEAT_MIN_PAGES, Math.ceil(pages.length * REPEAT_SHARE));
  const repeated = new Set([...seenOn].filter(([, n]) => n >= threshold).map(([key]) => key));
  if (!repeated.size) return pages;
  return pageLines.map((lines) => lines.filter((l) => !(l.length <= REPEAT_MAX_LINE && repeated.has(lineKey(l)))).join('\n'));
}

// ---- Reflow: wrapped lines -> paragraphs ----------------------------------------------------
// PDF text arrives one visual line at a time. A paragraph ends when a line is clearly short (last line of a
// paragraph, heading, list item), when the next line starts a bullet, or at the end of the document.
const BULLET_GLYPHS = '»•●▪■◦‣';
const BULLET_INLINE = new RegExp(`(\\S)\\s+([${BULLET_GLYPHS}])\\s+`, 'g');
const STARTS_BULLET = new RegExp(`^(?:[${BULLET_GLYPHS}]|[-–—*]\\s|\\d{1,2}[.)]\\s|[a-z]\\)\\s)`);
const TERMINAL = /[.!?:;…"”’')\]]$/;
const SHORT_LINE = 0.5; // share of the typical line width below which a line always ends its paragraph
const SHORT_SENTENCE_END = 0.75; // ...and below which a line ending in punctuation does

const startsLower = (line) => /^\p{Ll}/u.test(line);
// "time-" + "consuming": the line break is removed but the hyphen kept (most are real compounds).
const hyphenBreak = (a, b) => /[\p{L}\d]-$/u.test(a) && /^\p{L}/u.test(b);

function typicalWidth(lines) {
  const lengths = lines.map((l) => l.length).filter((n) => n >= 15).sort((a, b) => a - b);
  if (!lengths.length) return Math.max(...lines.map((l) => l.length), 1);
  return lengths[Math.ceil(lengths.length * 0.9) - 1]; // nearest-rank 90th percentile
}

// `seam` is true when `b` is the first line of the next page. A seam only continues a paragraph when the
// sentence is clearly unfinished; otherwise a full-width last line would run the whole document together.
function endsParagraph(a, b, width, seam) {
  if (STARTS_BULLET.test(b)) return true;
  if (hyphenBreak(a, b)) return false;
  if (!TERMINAL.test(a) && startsLower(b)) return false; // sentence continues
  if (seam) return true;
  if (a.length < width * SHORT_LINE) return true;
  return TERMINAL.test(a) && a.length < width * SHORT_SENTENCE_END;
}

// Takes one string per page, returns one block per page: one paragraph per line. A paragraph that runs over
// a page seam stays whole and belongs to the page it starts on; pages left empty are dropped.
export function reflowPdfPages(pages) {
  const lines = [];
  pages.forEach((page, pageIndex) => {
    const text = page.replace(BULLET_INLINE, '$1\n$2 ');
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line) lines.push({ line, pageIndex });
    }
  });
  if (!lines.length) return [];

  const width = typicalWidth(lines.map((l) => l.line));
  const perPage = pages.map(() => []);
  let current = null;
  lines.forEach(({ line, pageIndex }, i) => {
    if (!current) current = { text: line, pageIndex };
    else current.text += hyphenBreak(current.last, line) ? line : ` ${line}`;
    current.last = line;
    const next = lines[i + 1];
    if (!next || endsParagraph(line, next.line, width, next.pageIndex !== pageIndex)) {
      perPage[current.pageIndex].push(current.text);
      current = null;
    }
  });
  return perPage.map((paragraphs) => paragraphs.join('\n')).filter(Boolean);
}

// Returns { text, pageCount }. Pages are separated by a blank line; each line in a page is one paragraph.
export async function extractPdf(buffer) {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractPdfPages(pdf, { mergePages: false });
  const pages = stripRepeatedLines(text.map((p) => normalizeText(p).replace(/\n{2,}/g, '\n')));
  return { text: reflowPdfPages(pages).join('\n\n'), pageCount: text.length };
}
