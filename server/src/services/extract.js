import mammoth from 'mammoth';
import { OfficeParser } from 'officeparser';
import { HttpError } from '../middleware/errors.js';

const UNREADABLE = "Couldn't read this file. Make sure it opens in Word/PowerPoint, then try again.";

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

// Returns { text, wordCount } for a .docx/.pptx buffer.
export async function extractText(buffer, ext) {
  let raw;
  try {
    raw = ext === '.docx' ? await extractDocx(buffer) : await extractPptx(buffer);
  } catch (err) {
    console.error(`Extraction failed (${ext}):`, err.message);
    throw new HttpError(422, UNREADABLE);
  }
  const text = normalizeText(raw || '');
  return { text, wordCount: countWords(text) };
}
