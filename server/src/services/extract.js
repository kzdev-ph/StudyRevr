import mammoth from 'mammoth';
import { OfficeParser } from 'officeparser';
import { getDocumentProxy, extractText as extractPdfPages } from 'unpdf';
import { HttpError } from '../middleware/errors.js';

const UNREADABLE = "Couldn't read this file. Make sure it opens in Word, PowerPoint or a PDF viewer, then try again.";

export function normalizeText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const countWords = (text) => (text ? text.split(/\s+/).filter(Boolean).length : 0);

async function extractDocx(buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  return value;
}

function paragraphTexts(node, out = []) {
  if (node.type === 'paragraph') {
    if (node.text) out.push(node.text);
  } else {
    for (const child of node.children ?? []) paragraphTexts(child, out);
  }
  return out;
}

// Slides are joined by a blank line so later phases can chunk by slide.
async function extractPptx(buffer) {
  const ast = await OfficeParser.parseOffice(buffer, { fileType: 'pptx' });
  const slides = ast.content.filter((n) => n.type === 'slide');
  if (!slides.length) {
    const { value } = await ast.to('text');
    return value;
  }
  return slides.map((slide) => paragraphTexts(slide).join('\n')).filter(Boolean).join('\n\n');
}

// Header/footer detection. Short lines are compared with digits masked so "Page 3" and "Page 4" match;
// longer lines must match exactly so numbered body text ("Question 1 ...", "Step 2 ...") isn't mistaken for a footer.
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

// Pages are joined by a blank line (like pptx slides); blank lines inside a page are collapsed.
async function extractPdf(buffer) {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractPdfPages(pdf, { mergePages: false });
  const pages = stripRepeatedLines(text.map((p) => normalizeText(p).replace(/\n{2,}/g, '\n')));
  return { text: pages.filter((p) => p.trim()).join('\n\n'), pageCount: text.length };
}

// Returns { text, wordCount, pageCount } for a .docx/.pptx/.pdf buffer (pageCount only for PDFs).
export async function extractText(buffer, ext) {
  let raw;
  let pageCount = null;
  try {
    if (ext === '.docx') raw = await extractDocx(buffer);
    else if (ext === '.pptx') raw = await extractPptx(buffer);
    else ({ text: raw, pageCount } = await extractPdf(buffer));
  } catch (err) {
    console.error(`Extraction failed (${ext}):`, err.message);
    throw new HttpError(422, UNREADABLE);
  }
  const text = normalizeText(raw || '');
  return { text, wordCount: countWords(text), pageCount };
}
