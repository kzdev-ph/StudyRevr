import mammoth from 'mammoth';
import { HttpError } from '../middleware/errors.js';
import { splitBlocks } from '../ai/chunk.js';
import { extractPdf } from './pdf.js';
import { extractPptx } from './pptx.js';
import { countWords, normalizeText } from './text.js';
import { assertSafeZip } from './zipguard.js';

const UNREADABLE = "Couldn't read this file. Make sure it opens in Word, PowerPoint or a PDF viewer, then try again.";

async function extractDocx(buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  return value;
}

// Returns { text, wordCount, pageCount, source } for a .docx/.pptx/.pdf buffer (pageCount only for PDFs).
// raw_text format: blocks (slides / pages) separated by a blank line, one paragraph per line inside a block.
// For .docx every paragraph is its own block. wordCount is counted on the final combined text.
// source = { kind, numbers, total } says where each block came from: numbers[k] is the real slide / page number of
// the k-th block of `text` (a slide or page with no text has no block, so the two differ), kind is 'slide', 'page' or
// 'paragraph' and total how many of those the file has. source.numbers is null if the blocks can't be matched up
// with certainty, and then nothing is claimed about where a block came from.
export async function extractText(buffer, ext, { includeNotes = true } = {}) {
  let raw;
  let pageCount = null;
  let found = null; // { numbers, total } as the parser saw them
  if (ext === '.docx' || ext === '.pptx') assertSafeZip(buffer); // before any parser inflates the archive
  try {
    if (ext === '.docx') raw = await extractDocx(buffer);
    else if (ext === '.pptx') {
      const { text, numbers, total } = await extractPptx(buffer, { includeNotes });
      raw = text;
      found = { numbers, total };
    } else {
      const { text, numbers, pageCount: pages } = await extractPdf(buffer);
      raw = text;
      pageCount = pages;
      found = { numbers, total: pages };
    }
  } catch (err) {
    console.error(`Extraction failed (${ext}):`, err.message);
    throw new HttpError(422, UNREADABLE);
  }
  const text = normalizeText(raw || '');
  const blockCount = splitBlocks(text).length;
  const kind = ext === '.pptx' ? 'slide' : ext === '.pdf' ? 'page' : 'paragraph';
  if (!found) found = { numbers: Array.from({ length: blockCount }, (_, i) => i + 1), total: blockCount };
  const aligned = found.numbers.length === blockCount;
  if (!aligned) console.warn(`Extraction (${ext}): ${found.numbers.length} numbered blocks but ${blockCount} blocks of text; section sources are not recorded`);
  return { text, wordCount: countWords(text), pageCount, source: { kind, numbers: aligned ? found.numbers : null, total: found.total } };
}
