import JSZip from 'jszip';
import mammoth from 'mammoth';
import { OfficeParser } from 'officeparser';
import { HttpError } from '../middleware/errors.js';
import { splitBlocks } from '../ai/chunk.js';
import { mathText } from './math-text.js';
import { extractPdf } from './pdf.js';
import { extractPptx, nodeLines } from './pptx.js';
import { countWords, normalizeText } from './text.js';
import { assertEntrySizes, assertSafeZip } from './zipguard.js';

const UNREADABLE = "Couldn't read this file. Make sure it opens in Word, PowerPoint or a PDF viewer, then try again.";

// The part that makes a zip a Word document / a PowerPoint deck. A .pptx renamed .docx (or any other zip) has the "PK"
// signature too, so the type is checked by what the archive holds, not by its name.
const MAIN_PART = { '.docx': 'word/document.xml', '.pptx': 'ppt/presentation.xml' };

// Also the zip guard (zipguard.js): the sizes the directory declares, and then the real size of every entry.
export async function assertDocumentPart(buffer, ext) {
  const { names, records } = assertSafeZip(buffer);
  await assertEntrySizes(buffer, records);
  if (!names.has(MAIN_PART[ext])) {
    throw new HttpError(400, `This file isn't a real ${ext} (it looks like another kind of file with the wrong name). Save it as ${ext} from ${ext === '.docx' ? 'Word' : 'PowerPoint'} and try again.`, { code: 'wrong_content' });
  }
}

// Word equations (OMML) are invisible to mammoth, so a document that has one is read with officeparser instead.
const DOCX_BLOCKS = new Set(['paragraph', 'heading', 'list', 'table']);

async function extractDocxWithMath(buffer) {
  const ast = await OfficeParser.parseOffice(buffer, { fileType: 'docx', ignoreNotes: true, ignoreHeadersAndFooters: true });
  const lines = [];
  for (const node of ast.content) if (DOCX_BLOCKS.has(node.type)) nodeLines(node, lines);
  return lines.join('\n\n'); // every paragraph is its own block, as with mammoth
}

async function extractDocx(buffer) {
  const xml = await (await JSZip.loadAsync(buffer)).file('word/document.xml')?.async('string');
  if (xml && /<m:oMath[\s>]/.test(xml)) {
    try {
      return await extractDocxWithMath(buffer);
    } catch (err) {
      console.warn('docx: could not read the equations, falling back to the plain text reader:', err.message);
    }
  }
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
export async function extractText(buffer, ext, { includeNotes = true, pdfBudgetMs } = {}) {
  let raw;
  let pageCount = null;
  let found = null; // { numbers, total } as the parser saw them
  if (ext === '.docx' || ext === '.pptx') await assertDocumentPart(buffer, ext); // before any parser inflates the archive
  try {
    if (ext === '.docx') raw = await extractDocx(buffer);
    else if (ext === '.pptx') {
      const { text, numbers, total } = await extractPptx(buffer, { includeNotes });
      raw = text;
      found = { numbers, total };
    } else {
      const { text, numbers, pageCount: pages } = await extractPdf(buffer, pdfBudgetMs === undefined ? {} : { budgetMs: pdfBudgetMs });
      raw = text;
      pageCount = pages;
      found = { numbers, total: pages };
    }
  } catch (err) {
    if (err instanceof HttpError) throw err; // a limit of ours (a PDF that took too long), with its own message
    console.error(`Extraction failed (${ext}):`, err.message);
    throw new HttpError(422, UNREADABLE, { code: 'unreadable' });
  }
  const text = normalizeText(mathText(raw || '')); // typed LaTeX in any file type becomes readable Unicode
  const blockCount = splitBlocks(text).length;
  const kind = ext === '.pptx' ? 'slide' : ext === '.pdf' ? 'page' : 'paragraph';
  if (!found) found = { numbers: Array.from({ length: blockCount }, (_, i) => i + 1), total: blockCount };
  const aligned = found.numbers.length === blockCount;
  if (!aligned) console.warn(`Extraction (${ext}): ${found.numbers.length} numbered blocks but ${blockCount} blocks of text; section sources are not recorded`);
  return { text, wordCount: countWords(text), pageCount, source: { kind, numbers: aligned ? found.numbers : null, total: found.total } };
}
