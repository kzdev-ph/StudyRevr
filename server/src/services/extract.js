import mammoth from 'mammoth';
import { HttpError } from '../middleware/errors.js';
import { extractPdf } from './pdf.js';
import { extractPptx } from './pptx.js';
import { countWords, normalizeText } from './text.js';

const UNREADABLE = "Couldn't read this file. Make sure it opens in Word, PowerPoint or a PDF viewer, then try again.";

async function extractDocx(buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  return value;
}

// Returns { text, wordCount, pageCount } for a .docx/.pptx/.pdf buffer (pageCount only for PDFs).
// raw_text format: blocks (slides / pages) separated by a blank line, one paragraph per line inside a block.
// For .docx every paragraph is its own block. wordCount is counted on the final combined text.
export async function extractText(buffer, ext, { includeNotes = true } = {}) {
  let raw;
  let pageCount = null;
  try {
    if (ext === '.docx') raw = await extractDocx(buffer);
    else if (ext === '.pptx') raw = await extractPptx(buffer, { includeNotes });
    else ({ text: raw, pageCount } = await extractPdf(buffer));
  } catch (err) {
    console.error(`Extraction failed (${ext}):`, err.message);
    throw new HttpError(422, UNREADABLE);
  }
  const text = normalizeText(raw || '');
  return { text, wordCount: countWords(text), pageCount };
}
