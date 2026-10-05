import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { chunkBlocks, chunkLesson } from '../src/ai/chunk.js';
import { createApp } from '../src/app.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { labelledText, sectionsPrompt } from '../src/ai/prompts.js';
import { generateSections } from '../src/pipeline/generate.js';
import { queueJob } from '../src/pipeline/jobs.js';
import { createPipelineRunner } from '../src/pipeline/runner.js';
import { validateSources } from '../src/pipeline/sources.js';
import { extractText } from '../src/services/extract.js';

const quiet = { error() {}, warn() {}, log() {}, info() {} };
const questions = [{ question: 'Why?', answer: 'Because.' }];
const section = (title, sources) => ({ title, content: `${title} explained in enough words.`, check_questions: questions, sources });

describe('validateSources', () => {
  const allowed = new Set([1, 3, 4, 7]);
  const check = (raw, total = 8) => validateSources(raw, { allowed, total });

  it('keeps real numbers, sorted and without repeats', () => {
    assert.deepEqual(check([7, 3, 3, 1]).numbers, [1, 3, 7]);
  });

  it('refuses numbers beyond the real slide count, zero, negatives and fractions', () => {
    const out = check([3, 9, 0, -2, 2.5, 100], 8);
    assert.deepEqual(out.numbers, [3]);
    assert.deepEqual(out.dropped, [9, 0, -2, 2.5, 100]);
  });

  it('refuses a number that exists in the file but was not in the text the model was shown', () => {
    const out = check([2, 3, 5]);
    assert.deepEqual(out.numbers, [3]);
    assert.deepEqual(out.dropped, [2, 5], 'slide 2 is real (and empty or in another chunk) but was not on a label');
  });

  it('reads numbers given as text and expands a range, checking every number in it', () => {
    assert.deepEqual(check(['3', ' 4 ', '1-4']).numbers, [1, 3, 4]);
    assert.deepEqual(check(['5-9']).numbers, [7], '7 is the only number of the range that was on a label');
    assert.deepEqual(check(['5-6']).numbers, null);
  });

  it('refuses words, objects, reversed and absurd ranges', () => {
    const out = check(['three', { n: 3 }, '4-3', '1-500', null]);
    assert.equal(out.numbers, null);
    assert.equal(out.dropped.length, 5);
  });

  it('answers null (no known source) when nothing valid is left, and for a reply that is not a list', () => {
    assert.equal(check([]).numbers, null);
    assert.equal(check(undefined).numbers, null);
    assert.equal(check('3').numbers, null);
  });
});

describe('chunks that know their slide numbers', () => {
  it('carry the numbers and the parts of each chunk, and nothing extra without numbers', () => {
    const plain = chunkLesson('A\n\nB\n\nC');
    assert.equal(plain[0].parts, undefined);
    assert.equal(plain[0].numbers, undefined);

    const [chunk] = chunkLesson('A\n\nB\n\nC', { numbers: [1, 3, 4] });
    assert.deepEqual(chunk.numbers, [1, 3, 4]);
    assert.deepEqual(chunk.parts, [{ text: 'A', number: 1 }, { text: 'B', number: 3 }, { text: 'C', number: 4 }]);
    assert.equal(chunk.text, 'A\n\nB\n\nC', 'the unlabelled text is unchanged');
  });

  it('ignore a numbers list that does not match the blocks', () => {
    assert.equal(chunkBlocks(['A', 'B'], { numbers: [1] })[0].numbers, undefined);
  });

  it('give each chunk only its own numbers, and a block cut in two keeps its number', () => {
    const para = (n) => `${'word '.repeat(60)}${n}`;
    const slides = [para(1), para(2), `${para(3)}\n${para(4)}\n${para(5)}`, para(6)];
    const chunks = chunkBlocks(slides, { maxTokens: 130, numbers: [2, 5, 6, 9] });
    assert.ok(chunks.length >= 3);
    const seen = new Set(chunks.flatMap((c) => c.numbers));
    assert.deepEqual([...seen].sort((a, b) => a - b), [2, 5, 6, 9]);
    for (const c of chunks) assert.ok(c.numbers.every((n) => c.parts.some((p) => p.number === n)));
    assert.ok(chunks.filter((c) => c.numbers.includes(6)).length >= 2, 'the cut slide 6 is in more than one chunk');
  });
});

describe('labelledText and the sections prompt', () => {
  it('puts a label above each block and one label for a block that was cut', () => {
    const parts = [{ text: 'First', number: 2 }, { text: 'Second a', number: 5 }, { text: 'Notes:\nSecond b', number: 5 }, { text: 'Third', number: 6 }];
    assert.equal(labelledText(parts, 'slide'), '[Slide 2]\nFirst\n\n[Slide 5]\nSecond a\nNotes:\nSecond b\n\n[Slide 6]\nThird');
    assert.match(labelledText([{ text: 'x', number: 4 }], 'page'), /^\[Page 4\]\nx$/);
    assert.match(labelledText([{ text: 'x', number: 4 }], 'paragraph'), /^\[Paragraph 4\]\nx$/);
  });

  it('asks for sources only when the text is labelled', () => {
    const labelled = sectionsPrompt({ parts: [{ text: 'Hello', number: 3 }], kind: 'slide', index: 0, total: 1, summaryLength: 'short' });
    assert.match(labelled.system, /"sources"/);
    assert.match(labelled.system, /\[Slide 3\]/);
    assert.match(labelled.user, /<lesson_text>\n\[Slide 3\]\nHello\n<\/lesson_text>/);

    const plain = sectionsPrompt({ text: 'Hello', index: 0, total: 1, summaryLength: 'short' });
    assert.doesNotMatch(plain.system, /sources/);
    assert.match(plain.user, /<lesson_text>\nHello\n<\/lesson_text>/);
  });
});

describe('generateSections with sources', () => {
  const ai = (reply) => ({ async generateJSON({ schema, user }) { return schema.parse(reply(user)); } });

  it('stores only the sources that pass the check, and null when none do', async () => {
    const chunks = chunkLesson('Slide one text\n\nSlide three text\n\nSlide four text', { numbers: [1, 3, 4] });
    const dropped = [];
    const sections = await generateSections({
      ai: ai(() => ({ sections: [section('Good', [4, 3, 3]), section('Mixed', ['1', 2, 40]), section('Invented', [9, 12]), section('Silent', undefined)] })),
      chunks,
      sourceKind: 'slide',
      sourceTotal: 5,
      onDrop: (d) => dropped.push(d),
    });
    assert.deepEqual(sections.map((s) => s.sources), [[3, 4], [1], null, null]);
    assert.deepEqual(dropped, [{ title: 'Mixed', dropped: [2, 40] }, { title: 'Invented', dropped: [9, 12] }]);
  });

  it('gives null sources, and sends no labels, for a lesson with no numbers', async () => {
    const chunks = chunkLesson('Slide one text\n\nSlide two text');
    let prompt;
    const sections = await generateSections({ ai: ai((user) => { prompt = user; return { sections: [section('A', [1, 2])] }; }), chunks });
    assert.deepEqual(sections.map((s) => s.sources), [null]);
    assert.doesNotMatch(prompt, /\[Slide/);
  });

  it('checks each chunk against the numbers that chunk was shown', async () => {
    const big = (n) => `${'word '.repeat(80)}${n}`;
    const chunks = chunkLesson([1, 2, 3, 4].map(big).join('\n\n'), { maxTokens: 120, numbers: [10, 20, 30, 40] });
    assert.ok(chunks.length >= 2);
    const first = chunks[0].numbers;
    const other = chunks.at(-1).numbers.find((n) => !first.includes(n));
    // every chunk's reply claims the first chunk's first slide and the last chunk's slide
    const sections = await generateSections({
      ai: ai(() => ({ sections: [section('S', [first[0], other])] })),
      chunks,
      sourceKind: 'slide',
      sourceTotal: 40,
    });
    assert.deepEqual(sections[0].sources, [first[0]]);
    assert.ok(sections.at(-1).sources.includes(other) && !sections.at(-1).sources.includes(first[0]));
  });
});

describe('numbers from the file parsers', () => {
  it('pptx: a slide with no text leaves a gap in the numbers, and the total counts every slide', async () => {
    const pptx = new PptxGenJS();
    pptx.addSlide().addText('Slide one about inquiry', { x: 1, y: 1, w: 8, h: 1 });
    pptx.addSlide(); // a picture-only slide: nothing to read
    pptx.addSlide().addText('Slide three about research', { x: 1, y: 1, w: 8, h: 1 });
    pptx.addSlide().addText('Slide four about data', { x: 1, y: 1, w: 8, h: 1 });
    const { text, source } = await extractText(await pptx.write({ outputType: 'nodebuffer' }), '.pptx');
    assert.equal(text.split('\n\n').length, 3);
    assert.deepEqual(source, { kind: 'slide', numbers: [1, 3, 4], total: 4 });
  });

  it('pdf: a blank page leaves a gap in the numbers, and the total is the real page count', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (const line of ['Page one has some words on it.', null, 'Page three has words too.']) {
      const page = pdf.addPage([400, 400]);
      if (line) page.drawText(line, { x: 20, y: 300, size: 12, font });
    }
    const { text, source } = await extractText(Buffer.from(await pdf.save()), '.pdf');
    assert.equal(text.split('\n\n').length, 2);
    assert.deepEqual(source, { kind: 'page', numbers: [1, 3], total: 3 });
  });

  it('docx: every paragraph is a block, numbered from 1', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    const p = (t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
    zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${p('First paragraph')}${p('Second paragraph')}${p('Third paragraph')}</w:body></w:document>`);
    const { source } = await extractText(await zip.generateAsync({ type: 'nodebuffer' }), '.docx');
    assert.deepEqual(source, { kind: 'paragraph', numbers: [1, 2, 3], total: 3 });
  });
});

describe('sources end to end (mocked AI)', () => {
  let db;
  let server;
  let base;
  let prompts;

  // A model that names whatever sources `claim` says for each section it writes.
  const fakeAi = (claim) => ({
    async generateJSON({ schema, user, label }) {
      prompts.push({ label, user });
      let value;
      if (label.startsWith('the review sections')) value = { sections: [section('Inquiry basics', claim), section('Methods', [])] };
      else if (label.startsWith('the key points')) value = { key_points: ['One point.'] };
      else value = { terms: [] };
      return schema.parse(value);
    },
  });
  const start = async (ai) => {
    const runner = createPipelineRunner({ db, ai, log: quiet });
    const app = createApp(db, { maxUploadBytes: 5 * 1024 * 1024 }, { ai, runner });
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
    return runner;
  };
  const upload = async (buffer, name) => {
    const form = new FormData();
    form.append('file', new Blob([buffer]), name);
    const res = await fetch(`${base}/api/lessons`, { method: 'POST', body: form });
    return (await res.json()).lesson;
  };
  const getLesson = async (id) => (await fetch(`${base}/api/lessons/${id}`)).json();

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    prompts = [];
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  it('records the real slide numbers at upload, labels the prompt with them, validates and serves the sources', async () => {
    const runner = await start(fakeAi([4, 2, 3, 99]));
    const pptx = new PptxGenJS();
    pptx.addSlide().addText('Slide one about inquiry', { x: 1, y: 1, w: 8, h: 1 });
    pptx.addSlide(); // no text: slide 2 is not in raw_text
    pptx.addSlide().addText('Slide three about research', { x: 1, y: 1, w: 8, h: 1 });
    pptx.addSlide().addText('Slide four about data', { x: 1, y: 1, w: 8, h: 1 });
    const { id } = await upload(await pptx.write({ outputType: 'nodebuffer' }), 'inquiry.pptx');
    await runner.idle();

    const sectionsPrompt = prompts.find((p) => p.label.startsWith('the review sections')).user;
    assert.match(sectionsPrompt, /\[Slide 1\]\nSlide one about inquiry\n\n\[Slide 3\]\nSlide three about research\n\n\[Slide 4\]\nSlide four about data/);
    assert.doesNotMatch(sectionsPrompt, /\[Slide 2\]/);
    const keyTermsPrompt = prompts.find((p) => p.label.startsWith('the key terms')).user;
    assert.doesNotMatch(keyTermsPrompt, /\[Slide/, 'only the sections call gets labels');

    const { lesson, sections } = await getLesson(id);
    assert.equal(lesson.status, 'ready');
    assert.deepEqual(lesson.source, { kind: 'slide', total: 4, numbers: [1, 3, 4] });
    assert.ok(!('source_numbers' in lesson) && !('source_kind' in lesson), 'the raw columns are not exposed');
    assert.deepEqual(sections.map((s) => s.sources), [[3, 4], null], 'slide 2 had no text and 99 does not exist: both refused; no claim is null');
  });

  it('a lesson made before this change (no numbers) is processed without labels and reports no sources', async () => {
    const runner = await start(fakeAi([1, 2]));
    const id = Number(db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status) VALUES ('Old', 'old.pptx', 'Slide one\n\nSlide two', 4, 'processing')").run().lastInsertRowid);
    queueJob(db, id);
    runner.enqueue(id);
    await runner.idle();

    assert.doesNotMatch(prompts.find((p) => p.label.startsWith('the review sections')).user, /\[Slide/);
    const { lesson, sections } = await getLesson(id);
    assert.equal(lesson.source, null);
    assert.deepEqual(sections.map((s) => s.sources), [null, null]);
  });

  it('an old section row with no sources column value still loads', async () => {
    await start(fakeAi([]));
    const id = Number(db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status) VALUES ('Old', 'old.pdf', 'Page text', 2, 'ready')").run().lastInsertRowid);
    db.prepare("INSERT INTO sections (lesson_id, position, title, content, check_questions) VALUES (?, 1, 'S', 'Some content here.', '[]')").run(id);
    const { sections } = await getLesson(id);
    assert.equal(sections[0].sources, null);
  });
});
