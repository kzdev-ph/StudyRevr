import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chunkBlocks, chunkLesson, estimateTokens, isHeadingLike, NOTES_LABEL, splitBlocks } from '../src/ai/chunk.js';

const para = (label, tokens = 50) => `${label} ${'word '.repeat(Math.max(0, tokens * 3 / 5 - 1)).trim()}`.slice(0, tokens * 3);
const lines = (chunk) => chunk.text.split('\n').filter(Boolean);
const allLines = (chunks) => chunks.flatMap(lines);

describe('chunking', () => {
  it('returns nothing for empty text and one chunk for a short lesson', () => {
    assert.deepEqual(chunkLesson(''), []);
    assert.deepEqual(chunkLesson('  \n\n \n'), []);
    const raw = 'Slide one title\n- point a\n- point b\n\nSlide two\nSome text.';
    const chunks = chunkLesson(raw);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].text, raw);
    assert.equal(chunks[0].index, 0);
  });

  it('splits raw_text into blocks on blank lines', () => {
    assert.deepEqual(splitBlocks('a\nb\n\n\n\nc\n\nd'), ['a\nb', 'c', 'd']);
  });

  it('keeps every paragraph exactly once, in order, and respects the budget', () => {
    const slides = Array.from({ length: 12 }, (_, i) => [`Slide ${i + 1} title`, para(`s${i}a`, 60), para(`s${i}b`, 60)].join('\n'));
    const chunks = chunkLesson(slides.join('\n\n'), { maxTokens: 300 });
    assert.ok(chunks.length > 3);
    assert.deepEqual(allLines(chunks), slides.flatMap((s) => s.split('\n')));
    for (const c of chunks) assert.ok(c.tokens <= 300, `chunk ${c.index} has ${c.tokens} tokens`);
  });

  it('cuts between slides when slides fit whole', () => {
    const slides = Array.from({ length: 6 }, (_, i) => `Slide ${i}\n${para(`body${i}`, 80)}`);
    const chunks = chunkLesson(slides.join('\n\n'), { maxTokens: 250 });
    for (const c of chunks) {
      const starts = lines(c).filter((l) => l.startsWith('Slide '));
      const bodies = lines(c).filter((l) => l.startsWith('body'));
      assert.equal(starts.length, bodies.length, 'no slide is cut in half');
    }
  });

  it("keeps a slide's Notes: with its slide when the slide fits in one chunk", () => {
    const slides = Array.from({ length: 5 }, (_, i) => `Slide ${i}\n- point ${i}\n${NOTES_LABEL}\n${para(`note${i}`, 70)}`);
    const chunks = chunkLesson(slides.join('\n\n'), { maxTokens: 220 });
    assert.ok(chunks.length >= 2);
    for (const c of chunks) {
      const l = lines(c);
      l.forEach((line, i) => {
        if (line === NOTES_LABEL) {
          assert.match(l[i - 1], /^- point \d$/, 'Notes: directly follows its slide body');
          assert.match(l[i + 1], /^note\d/, 'and is followed by its notes');
        }
      });
    }
  });

  it('splits an oversized slide at paragraphs and restarts "Notes:" when the cut lands inside the notes', () => {
    const notes = Array.from({ length: 6 }, (_, i) => para(`note${i}`, 40));
    const slide = ['Big slide', '- bullet', NOTES_LABEL, ...notes].join('\n');
    const chunks = chunkLesson(slide, { maxTokens: 120 });
    assert.ok(chunks.length >= 3);
    assert.equal(chunks[0].text.startsWith('Big slide\n- bullet\nNotes:\nnote0'), true);
    for (const c of chunks.slice(1)) assert.equal(lines(c)[0], NOTES_LABEL, 'continuation pieces announce the notes again');
    for (const c of chunks) assert.notEqual(lines(c).at(-1), NOTES_LABEL, 'a Notes: label is never stranded at the end');
    assert.deepEqual(allLines(chunks).filter((l) => l !== NOTES_LABEL), ['Big slide', '- bullet', ...notes], 'no paragraph lost or duplicated');
  });

  it('does not strand "Notes:" when the body fills the piece exactly up to the label', () => {
    const slide = ['Title', para('body', 90), NOTES_LABEL, para('note', 40)].join('\n');
    const chunks = chunkLesson(slide, { maxTokens: 110 });
    for (const c of chunks) assert.notEqual(lines(c).at(-1), NOTES_LABEL);
    assert.ok(chunks.some((c) => c.text.startsWith(`${NOTES_LABEL}\nnote`)));
  });

  it('never splits a single paragraph, even one over the budget', () => {
    const huge = para('huge', 900);
    const chunks = chunkLesson(`Intro\n\n${huge}\n\nOutro`, { maxTokens: 200 });
    assert.ok(chunks.some((c) => c.text.includes(huge)));
    assert.deepEqual(allLines(chunks), ['Intro', huge, 'Outro']);
  });

  it('prefers cutting before a heading over leaving it stranded at the end of a chunk', () => {
    // docx-style: every paragraph is its own block
    const paras = [para('intro', 90), para('more', 90), 'Chapter Two: Cells', para('cell', 90), para('end', 40)];
    const chunks = chunkBlocks(paras, { maxTokens: 250 });
    assert.equal(chunks.length, 2);
    assert.ok(chunks[0].text.endsWith(paras[1]), 'first chunk ends before the heading');
    assert.ok(chunks[1].text.startsWith('Chapter Two: Cells'), 'heading starts the next chunk with its content');
  });

  it('does not move a heading when that would leave its chunk too empty', () => {
    const paras = ['Heading One', para('a', 100), para('b', 100), para('c', 100)];
    const chunks = chunkBlocks(paras, { maxTokens: 250 });
    assert.equal(chunks[0].text.startsWith('Heading One'), true);
  });

  it('recognises headings', () => {
    assert.equal(isHeadingLike('Introduction to Media Channels'), true);
    assert.equal(isHeadingLike('Why do cells divide?'), false);
    assert.equal(isHeadingLike('A sentence that ends with a period.'), false);
    assert.equal(isHeadingLike('- a bullet'), false);
    assert.equal(isHeadingLike('Two\nlines'), false);
    assert.equal(isHeadingLike('word '.repeat(20).trim()), false);
  });

  it('estimates roughly 3 characters per token', () => {
    assert.equal(estimateTokens('abc'), 1);
    assert.equal(estimateTokens('a'.repeat(300)), 100);
  });

  it('handles a lesson of a few hundred paragraphs quickly', () => {
    const raw = Array.from({ length: 800 }, (_, i) => para(`p${i}`, 30)).join('\n\n');
    const started = Date.now();
    const chunks = chunkLesson(raw);
    assert.ok(Date.now() - started < 1000);
    assert.equal(allLines(chunks).length, 800);
  });
});
