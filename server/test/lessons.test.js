import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Document, Packer, Paragraph, HeadingLevel } from 'docx';
import PptxGenJS from 'pptxgenjs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createApp } from '../src/app.js';
import { reflowPdfPages, stripRepeatedLines } from '../src/services/pdf.js';
import { openDb, runMigrations } from '../src/db/index.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const MAX_UPLOAD = 1024 * 1024; // 1 MB in tests so the size limit is cheap to hit

const sentence = 'Photosynthesis converts light energy into chemical energy stored in glucose.';

async function makeDocx(paragraphs) {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: 'Plant Biology', heading: HeadingLevel.HEADING_1 }),
          ...paragraphs.map((text) => new Paragraph(text)),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

async function makePptx(slides) {
  const pptx = new PptxGenJS();
  for (const [title, body] of slides) {
    const slide = pptx.addSlide();
    slide.addText(title, { x: 0.5, y: 0.3, w: 9, h: 1, fontSize: 28 });
    slide.addText(body, { x: 0.5, y: 1.5, w: 9, h: 3, fontSize: 18 });
  }
  return pptx.write({ outputType: 'nodebuffer' });
}

const PDF_MIME = 'application/pdf';

// Text PDF: every page has a header, a "Page N of M" footer, and its own body lines.
async function makeTextPdf(bodies, { header = 'StudyRevr Biology 101' } = {}) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  bodies.forEach((lines, i) => {
    const page = pdf.addPage([612, 792]);
    page.drawText(header, { x: 50, y: 750, size: 10, font });
    lines.forEach((line, j) => page.drawText(line, { x: 50, y: 680 - j * 24, size: 12, font }));
    page.drawText(`Page ${i + 1} of ${bodies.length}`, { x: 50, y: 30, size: 10, font });
  });
  return Buffer.from(await pdf.save());
}

// Image-only stand-in: pages exist but carry no text objects.
async function makeBlankPdf(pages = 3) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i++) pdf.addPage([612, 792]);
  return Buffer.from(await pdf.save());
}

const pdfBodies = Array.from({ length: 5 }, (_, i) =>
  Array.from({ length: 6 }, (_, j) => `Chapter ${i + 1} paragraph ${j + 1} describes how cells divide and grow over time.`),
);

describe('stripRepeatedLines', () => {
  it('drops headers, footers and page numbers that repeat on most pages', () => {
    const pages = ['Course Title\nIntro text\n1', 'Course Title\nMiddle text\n2', 'Course Title\nMore text\n3'];
    assert.deepEqual(stripRepeatedLines(pages), ['Intro text', 'Middle text', 'More text']);
  });

  it('keeps lines that repeat on only a few pages', () => {
    const pages = ['A\nshared line', 'B\nshared line', 'C', 'D', 'E'];
    assert.deepEqual(stripRepeatedLines(pages), pages);
  });

  it('keeps long numbered body lines that differ only in digits', () => {
    const pages = [1, 2, 3, 4].map((n) => `Question ${n} asks why the cell membrane regulates what enters and leaves.`);
    assert.deepEqual(stripRepeatedLines(pages), pages);
  });

  it('leaves documents under 3 pages alone', () => {
    const pages = ['Header\nOne', 'Header\nTwo'];
    assert.deepEqual(stripRepeatedLines(pages), pages);
  });
});

describe('lessons API', () => {
  let db;
  let server;
  let base;

  const upload = (buffer, filename, { mime, fields = {} } = {}) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('file', new Blob([buffer], { type: mime ?? 'application/octet-stream' }), filename);
    return fetch(`${base}/api/lessons`, { method: 'POST', body: form });
  };

  before(async () => {
    db = openDb(':memory:');
    runMigrations(db);
    const app = createApp(db, { maxUploadBytes: MAX_UPLOAD }, { runner: { enqueue() {} } });
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  it('creates every table from the data model', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name);
    for (const t of [
      'lessons', 'jobs', 'sections', 'key_points', 'key_terms', 'review_progress', 'flashcards',
      'flashcard_reviews', 'quiz_questions', 'quiz_attempts', 'study_sessions', 'settings', 'schema_migrations',
    ]) {
      assert.ok(tables.includes(t), `missing table ${t}`);
    }
  });

  it('runs migrations idempotently', () => {
    assert.deepEqual(runMigrations(db), []);
  });

  it('uploads a .docx and stores extracted text', async () => {
    const buf = await makeDocx(Array(40).fill(sentence));
    const res = await upload(buf, 'Plant Biology.docx', { mime: DOCX_MIME });
    assert.equal(res.status, 201);
    const { lesson, warning } = await res.json();
    assert.equal(lesson.title, 'Plant Biology');
    assert.equal(lesson.filename, 'Plant Biology.docx');
    assert.equal(lesson.status, 'processing', 'AI processing is queued; the lesson is ready once it finishes');
    assert.ok(lesson.word_count > 300, `word_count was ${lesson.word_count}`);
    assert.equal(warning, null);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM jobs WHERE lesson_id = ?').get(lesson.id).c, 1);

    const detail = await (await fetch(`${base}/api/lessons/${lesson.id}`)).json();
    assert.match(detail.lesson.raw_text, /Photosynthesis converts light energy/);
  });

  it('uploads a .pptx and extracts slide text', async () => {
    const buf = await makePptx([
      ['Cell Structure', 'The nucleus stores genetic material and controls cell activity.'],
      ['Mitochondria', 'Mitochondria produce ATP through cellular respiration.'],
    ]);
    const res = await upload(buf, 'cells.pptx', { mime: PPTX_MIME, fields: { title: 'Cells 101' } });
    assert.equal(res.status, 201);
    const { lesson } = await res.json();
    assert.equal(lesson.title, 'Cells 101');
    const detail = await (await fetch(`${base}/api/lessons/${lesson.id}`)).json();
    assert.match(detail.lesson.raw_text, /Cell Structure/);
    assert.match(detail.lesson.raw_text, /Mitochondria produce ATP/);
    assert.equal(detail.lesson.raw_text.split('\n\n').length, 2, 'one blank-line-separated block per slide');
  });

  it('uploads a text .pdf, one block per page, with repeated headers/footers removed', async () => {
    const res = await upload(await makeTextPdf(pdfBodies), 'biology.pdf', { mime: PDF_MIME });
    assert.equal(res.status, 201);
    const { lesson, warning } = await res.json();
    assert.equal(lesson.title, 'biology');
    assert.equal(warning, null);
    const { raw_text: text } = (await (await fetch(`${base}/api/lessons/${lesson.id}`)).json()).lesson;
    assert.equal(text.split('\n\n').length, 5, 'one blank-line-separated block per page');
    assert.match(text, /Chapter 1 paragraph 1/);
    assert.ok(text.indexOf('Chapter 2 paragraph 1') < text.indexOf('Chapter 3 paragraph 1'), 'page order kept');
    assert.doesNotMatch(text, /StudyRevr Biology 101/);
    assert.doesNotMatch(text, /Page \d of 5/);
  });

  it('warns that an image-only .pdf looks scanned', async () => {
    const res = await upload(await makeBlankPdf(), 'scan.pdf', { mime: PDF_MIME });
    assert.equal(res.status, 201);
    const { lesson, warning } = await res.json();
    assert.equal(lesson.word_count, 0);
    assert.equal(warning, "This PDF looks scanned or image-only; text can't be extracted.");
  });

  it('rejects a .pdf without the %PDF signature and one that is corrupt', async () => {
    let res = await upload(Buffer.from('definitely not a pdf'), 'fake.pdf', { mime: PDF_MIME });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /isn't a valid \.pdf/);
    res = await upload(Buffer.from('%PDF-1.7 garbage garbage garbage'), 'broken.pdf', { mime: PDF_MIME });
    assert.equal(res.status, 422);
  });

  it('rejects a .pdf sent with a non-PDF MIME type', async () => {
    const res = await upload(await makeBlankPdf(1), 'wrongmime.pdf', { mime: 'image/png' });
    assert.equal(res.status, 400);
  });

  it('warns when very little text is extracted', async () => {
    const buf = await makeDocx(['Just a line.']);
    const res = await upload(buf, 'tiny.docx', { mime: DOCX_MIME });
    assert.equal(res.status, 201);
    const { warning } = await res.json();
    assert.match(warning, /Very little text/);
  });

  it('rejects legacy .doc/.ppt with a save-as hint', async () => {
    for (const name of ['old.doc', 'old.ppt']) {
      const res = await upload(Buffer.from('legacy'), name);
      assert.equal(res.status, 400);
      const { error } = await res.json();
      assert.match(error.message, new RegExp(`save as \\${name.slice(name.indexOf('.'))}x`));
    }
  });

  it('rejects unsupported extensions and mismatched MIME types', async () => {
    let res = await upload(Buffer.from('hello'), 'notes.txt', { mime: 'text/plain' });
    assert.equal(res.status, 400);
    res = await upload(Buffer.from('PK\x03\x04'), 'fake.docx', { mime: 'image/png' });
    assert.equal(res.status, 400);
  });

  it('rejects a renamed non-zip file', async () => {
    const res = await upload(Buffer.from('this is plain text, not a zip'), 'fake.docx', { mime: DOCX_MIME });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /isn't a valid/);
  });

  it('returns 422 for a corrupt zip that is not a real document', async () => {
    const res = await upload(Buffer.from('PK\x03\x04 garbage garbage garbage'), 'broken.docx', { mime: DOCX_MIME });
    assert.equal(res.status, 422);
  });

  it('rejects files over the size limit with 413', async () => {
    const big = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(MAX_UPLOAD + 1024)]);
    const res = await upload(big, 'huge.docx', { mime: DOCX_MIME });
    assert.equal(res.status, 413);
    assert.match((await res.json()).error.message, /larger than/);
  });

  it('requires a file', async () => {
    const res = await fetch(`${base}/api/lessons`, { method: 'POST', body: new FormData() });
    assert.equal(res.status, 400);
  });

  it('lists, fetches, and deletes lessons', async () => {
    const buf = await makeDocx(Array(40).fill(sentence));
    const { lesson } = await (await upload(buf, 'round-trip.docx', { mime: DOCX_MIME })).json();

    const list = await (await fetch(`${base}/api/lessons`)).json();
    const row = list.lessons.find((l) => l.id === lesson.id);
    assert.ok(row);
    assert.equal('raw_text' in row, false, 'list should omit raw_text');

    const del = await fetch(`${base}/api/lessons/${lesson.id}`, { method: 'DELETE' });
    assert.equal(del.status, 204);
    assert.equal((await fetch(`${base}/api/lessons/${lesson.id}`)).status, 404);
    assert.equal((await fetch(`${base}/api/lessons/${lesson.id}`, { method: 'DELETE' })).status, 404);
  });

  it('validates the lesson id', async () => {
    assert.equal((await fetch(`${base}/api/lessons/abc`)).status, 400);
    assert.equal((await fetch(`${base}/api/lessons/0`)).status, 400);
  });

  it('cascades deletes to child tables', async () => {
    const buf = await makeDocx(Array(40).fill(sentence));
    const { lesson } = await (await upload(buf, 'cascade.docx', { mime: DOCX_MIME })).json();
    const id = lesson.id;

    db.prepare("INSERT INTO sections (lesson_id, position, title, content) VALUES (?, 0, 't', 'c')").run(id);
    db.prepare("INSERT INTO key_points (lesson_id, position, text) VALUES (?, 0, 'p')").run(id);
    db.prepare("INSERT INTO key_terms (lesson_id, term, definition) VALUES (?, 't', 'd')").run(id);
    db.prepare('INSERT INTO review_progress (lesson_id) VALUES (?)').run(id);
    const card = db.prepare("INSERT INTO flashcards (lesson_id, front, back) VALUES (?, 'f', 'b')").run(id);
    db.prepare('INSERT INTO flashcard_reviews (flashcard_id, rating) VALUES (?, 3)').run(card.lastInsertRowid);
    db.prepare("INSERT INTO quiz_questions (lesson_id, question, choices, answer_index) VALUES (?, 'q', '[]', 0)").run(id);
    db.prepare('INSERT INTO quiz_attempts (lesson_id, score, total) VALUES (?, 1, 2)').run(id);
    db.prepare("INSERT INTO study_sessions (lesson_id, tab, started_at) VALUES (?, 'review', '2026-01-01T00:00:00Z')").run(id);

    assert.equal((await fetch(`${base}/api/lessons/${id}`, { method: 'DELETE' })).status, 204);

    for (const table of [
      'jobs', 'sections', 'key_points', 'key_terms', 'review_progress', 'flashcards',
      'quiz_questions', 'quiz_attempts', 'study_sessions',
    ]) {
      assert.equal(db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE lesson_id = ?`).get(id).c, 0, table);
    }
    assert.equal(db.prepare('SELECT COUNT(*) c FROM flashcard_reviews').get().c, 0, 'flashcard_reviews');
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
    assert.ok((await res.json()).error.message);
  });
});
