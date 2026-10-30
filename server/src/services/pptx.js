import JSZip from 'jszip';
import { OfficeParser } from 'officeparser';
import { latexToText } from './math-text.js';

const NOTES_LABEL = 'Notes:';

const clean = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

// OOXML writes characters XML can't hold as _xHHHH_ (a vertical tab, a soft return inside a run, is _x000B_).
const decodeOoxml = (s) => String(s ?? '').replace(/_x([0-9a-f]{4})_/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
// Two sentences with no space between them ("trust.Share your background.") are two lines that lost their break:
// officeparser joins the runs of a paragraph as they are, so a bullet typed or pasted without its break arrives glued.
// Split after a word ending in two lowercase letters and . ! or ?, before a capitalised word, so "e.g.The" and
// "St.Mary" stay whole.
const GLUED = /(?<=\p{Ll}{2}[.!?])(?=\p{Lu}\p{Ll})/u;

// The lines one paragraph or list item really holds: a soft return ("\n", a vertical tab, a line separator) or two
// glued sentences start a new line. Empty pieces are dropped.
export const textLines = (text) =>
  decodeOoxml(text)
    .split(/[\n\v\u2028]/)
    .flatMap((part) => part.split(GLUED))
    .map(clean)
    .filter(Boolean);

// A typed bullet glyph ("• item") or dash ("- item") at the start of a list item; we add our own "- " prefix.
const TYPED_BULLET = /^(?:[•●▪■◦‣»]\s*|[-–]\s+)/;
// Compares lines regardless of list prefixes so the same text isn't added twice.
const dedupeKey = (line) => line.replace(/^(?:(?:[-–•●▪■◦‣»]|\d+[.)])\s*)+/, '').trim().toLowerCase();

const hasMath = (node) => (node.children ?? []).some((c) => (c.type === 'code' && c.metadata?.math) || hasMath(c));

// The text of a node. An equation arrives twice from officeparser (once appended to the node's text as LaTeX, once as
// a { type: 'code', metadata: { math } } child), so a node that holds one is rebuilt from its children, with the
// equation as readable Unicode. Any other node keeps its own text, exactly as before.
export function nodeText(node) {
  if (!hasMath(node)) return node.text;
  return node.children
    .map((child) => {
      if (child.type === 'code' && child.metadata?.math) return ` ${latexToText(child.text)} `;
      return child.type === 'text' ? child.text : nodeText(child);
    })
    .join('');
}

// Turns a slide (or notes) AST node into one line per paragraph, list item or table row.
export function nodeLines(node, out = []) {
  switch (node.type) {
    case 'paragraph':
    case 'heading': // title placeholders
      // a soft line break inside a paragraph arrives as "\n"; keep each side as its own line
      out.push(...textLines(nodeText(node)));
      break;
    case 'list': {
      // every line of a bullet is a bullet of its own ("- Build trust.", "- Share your background."); an ordered
      // item keeps its number on its first line, the rest follow as plain lines
      const lines = textLines(nodeText(node)).map((l) => l.replace(TYPED_BULLET, '')).filter(Boolean);
      if (!lines.length) break;
      const { listType, itemIndex = 0 } = node.metadata ?? {};
      if (listType === 'ordered') out.push(`${itemIndex + 1}. ${lines[0]}`, ...lines.slice(1));
      else out.push(...lines.map((l) => `- ${l}`));
      break;
    }
    case 'table':
      for (const row of node.children ?? []) {
        const cells = (row.children ?? []).map((cell) => clean(nodeText(cell))).filter(Boolean);
        if (cells.length) out.push(cells.join(' | '));
      }
      break;
    default:
      if (node.children?.length) for (const child of node.children) nodeLines(child, out);
      else if (node.type !== 'text' && clean(node.text)) out.push(clean(node.text)); // any other text-bearing leaf
  }
  return out;
}

// Notes pages carry date and page-number placeholders that aren't lesson content. The number is the notes
// page's own, so it rarely matches the slide number; any lone 1-3 digit line is treated as one.
const isNotesPlaceholder = (line) => /^\d{1,3}$/.test(line) || /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(line) || /^[‹<]#[›>]$/.test(line);

const decodeEntities = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

// One line per <a:p>, runs joined; a soft line break (<a:br/> or <a:br><a:rPr/></a:br>) starts a new line.
// Used for SmartArt data models and notes pages.
export function drawingMlLines(xml) {
  const lines = [];
  for (const para of xml.matchAll(/<a:p[ >][\s\S]*?<\/a:p>/g)) {
    for (const segment of para[0].split(/<a:br\b[^>]*?(?:\/>|>[\s\S]*?<\/a:br>)/)) {
      const text = [...segment.matchAll(/<a:t(?: [^>]*)?>([^<]*)<\/a:t>/g)].map((m) => decodeEntities(m[1])).join('');
      // a raw newline inside <a:t> is only XML whitespace (a real break is <a:br> or _x000B_)
      lines.push(...textLines(clean(text)));
    }
  }
  return lines;
}

const resolveTarget = (baseDir, target) => {
  const parts = (target.startsWith('/') ? target.slice(1) : `${baseDir}/${target}`).split('/');
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return out.join('/');
};

const relTargets = (relsXml) => [...relsXml.matchAll(/<Relationship\b[^>]*>/g)].map((m) => {
  const tag = m[0];
  return { id: /\bId="([^"]+)"/.exec(tag)?.[1], target: /\bTarget="([^"]+)"/.exec(tag)?.[1], type: /\bType="([^"]+)"/.exec(tag)?.[1] ?? '' };
});

// Slide part names in presentation order (file numbering can differ from slide order).
async function orderedSlideParts(zip) {
  const pres = await zip.file('ppt/presentation.xml')?.async('string');
  const rels = await zip.file('ppt/_rels/presentation.xml.rels')?.async('string');
  if (!pres || !rels) return [];
  const byId = new Map(relTargets(rels).map((r) => [r.id, r.target]));
  return [...pres.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)]
    .map((m) => byId.get(m[1]))
    .filter(Boolean)
    .map((t) => resolveTarget('ppt', t));
}

// Reads the parts a slide links to through its .rels file, e.g. kind = 'diagramData' or 'notesSlide'.
async function linkedParts(zip, slidePart, kind) {
  const dir = slidePart.slice(0, slidePart.lastIndexOf('/'));
  const file = slidePart.slice(slidePart.lastIndexOf('/') + 1);
  const relsXml = await zip.file(`${dir}/_rels/${file}.rels`)?.async('string');
  if (!relsXml) return [];
  const xmls = [];
  for (const rel of relTargets(relsXml).filter((r) => r.type.endsWith(`/${kind}`))) {
    const xml = await zip.file(resolveTarget(dir, rel.target))?.async('string');
    if (xml) xmls.push(xml);
  }
  return xmls;
}

// SmartArt text lives in ppt/diagrams/dataN.xml, linked from the slide's .rels.
const smartArtLines = async (zip, slidePart) => (await linkedParts(zip, slidePart, 'diagramData')).flatMap(drawingMlLines);

// Speaker notes are the body placeholder of the notes page the slide links to. (officeparser pairs the Nth notes page
// with the Nth slide instead of following the link, which puts notes on the wrong slides, so its notes aren't used.)
async function notesLines(zip, slidePart) {
  const lines = [];
  for (const xml of await linkedParts(zip, slidePart, 'notesSlide')) {
    for (const [shape] of xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)) {
      if (/<p:ph\b[^>]*\btype="body"/.test(shape)) lines.push(...drawingMlLines(shape));
    }
  }
  return lines;
}

// officeparser returns slides sorted by file number (slide1.xml, slide2.xml, ...), which is not necessarily the
// order in the deck. Pair each parsed slide with its part by file number, then emit in presentation order.
async function slidePlan(zip, slideCount) {
  const byNumber = Object.keys(zip.files)
    .map((name) => ({ name, n: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(name)?.[1]) }))
    .filter((p) => p.n)
    .sort((a, b) => a.n - b.n)
    .map((p) => p.name);
  if (byNumber.length !== slideCount) {
    console.warn(`pptx: ${byNumber.length} slide parts vs ${slideCount} parsed slides; skipping SmartArt text and reordering`);
    return null;
  }
  const deckOrder = await orderedSlideParts(zip);
  const emit = deckOrder.length ? byNumber.map((part, i) => ({ part, i, rank: deckOrder.indexOf(part) })).filter((s) => s.rank >= 0) : byNumber.map((part, i) => ({ part, i, rank: i }));
  return emit.sort((a, b) => a.rank - b.rank);
}

// One block per slide: slide text, then SmartArt text, then (optionally) "Notes:" and the speaker notes.
// Blocks are separated by a blank line; each line inside a block is one paragraph.
// Returns { text, numbers, total }: `numbers[k]` is the slide number (deck order, from 1) of the k-th block, since a
// slide with no text is skipped, and `total` is how many slides the deck has.
export async function extractPptx(buffer, { includeNotes = true } = {}) {
  const ast = await OfficeParser.parseOffice(buffer, { fileType: 'pptx' });
  const slides = ast.content.filter((n) => n.type === 'slide');

  let zip = null;
  let plan = null;
  try {
    zip = await JSZip.loadAsync(buffer);
    plan = await slidePlan(zip, slides.length);
  } catch (err) {
    console.warn('pptx: could not read package structure:', err.message);
  }
  const order = plan ?? slides.map((_, i) => ({ i, part: null }));

  const blocks = [];
  const numbers = [];
  for (const [position, { i, part }] of order.entries()) {
    const slide = slides[i];
    const lines = nodeLines(slide);
    if (part) {
      // officeparser already returns some SmartArt text as list items; only add what the slide doesn't have yet.
      const seen = new Set(lines.map(dedupeKey));
      for (const line of await smartArtLines(zip, part)) {
        if (!seen.has(dedupeKey(line))) lines.push(TYPED_BULLET.test(line) ? `- ${line.replace(TYPED_BULLET, '')}` : line);
      }
    }
    if (includeNotes && part) {
      const notes = (await notesLines(zip, part)).filter((l) => !isNotesPlaceholder(l));
      if (notes.length) lines.push(NOTES_LABEL, ...notes);
    }
    if (lines.length) {
      blocks.push(lines.join('\n'));
      numbers.push(position + 1);
    }
  }
  return { text: blocks.join('\n\n'), numbers, total: order.length };
}
