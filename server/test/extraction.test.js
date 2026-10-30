import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Document, Math, MathFraction, MathRun, MathSuperScript, Packer, Paragraph, TextRun } from 'docx';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import { PDFDocument, StandardFonts, beginText, endText, moveText, setFontAndSize, setTextRise, showText } from 'pdf-lib';
import { createApp } from '../src/app.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { extractText } from '../src/services/extract.js';
import { latexToText } from '../src/services/math-text.js';
import { extractPdf, reflowPdfPages } from '../src/services/pdf.js';
import { drawingMlLines, textLines } from '../src/services/pptx.js';
import { countWords } from '../src/services/text.js';
import { seedTestLogin, studyFetch, TEST_PIN } from './helpers.js';

const fetch = studyFetch; // as participant P00, with the admin PIN (see helpers.js)

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const DIAGRAM_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramData';

// ---- fixtures ---------------------------------------------------------------------------------
// slides: [{ title, body?, bullets?, numbered?, table?, notes? }]
async function makePptx(slides) {
  const pptx = new PptxGenJS();
  for (const s of slides) {
    const slide = pptx.addSlide();
    slide.addText(s.title, { x: 0.5, y: 0.2, w: 9, h: 0.8, fontSize: 28 });
    if (s.body) slide.addText(s.body, { x: 0.5, y: 1.1, w: 9, h: 0.6 });
    if (s.numbered) {
      slide.addText(s.numbered.map((text) => ({ text, options: { bullet: { type: 'number' }, breakLine: true } })), { x: 0.5, y: 1.8, w: 9, h: 1.2 });
    }
    if (s.bullets) {
      slide.addText(s.bullets.map((text) => ({ text, options: { bullet: true, breakLine: true } })), { x: 0.5, y: 3.1, w: 9, h: 1.2 });
    }
    if (s.table) slide.addTable(s.table.map((row) => row.map((text) => ({ text }))), { x: 0.5, y: 4.4, w: 9 });
    if (s.notes) slide.addNotes(s.notes);
  }
  return pptx.write({ outputType: 'nodebuffer' });
}

// Adds a SmartArt data part (and the slide relationship that points at it) to slide<slideNo>.xml.
async function addSmartArt(buffer, slideNo, paragraphs) {
  const zip = await JSZip.loadAsync(buffer);
  const paras = paragraphs.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('');
  zip.file(
    `ppt/diagrams/data${slideNo}.xml`,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dgm:ptLst><dgm:pt modelId="1"><dgm:t><a:bodyPr/>${paras}</dgm:t></dgm:pt></dgm:ptLst></dgm:dataModel>`,
  );
  const relsPath = `ppt/slides/_rels/slide${slideNo}.xml.rels`;
  const rels = await zip.file(relsPath).async('string');
  zip.file(relsPath, rels.replace('</Relationships>', `<Relationship Id="rId99" Type="${DIAGRAM_REL}" Target="../diagrams/data${slideNo}.xml"/></Relationships>`));
  return zip.generateAsync({ type: 'nodebuffer' });
}

// Edits a slide's relationship file: `edit` receives and returns the .rels XML.
async function editSlideRels(buffer, slideNo, edit) {
  const zip = await JSZip.loadAsync(buffer);
  const path = `ppt/slides/_rels/slide${slideNo}.xml.rels`;
  zip.file(path, edit(await zip.file(path).async('string')));
  return zip.generateAsync({ type: 'nodebuffer' });
}

// Reverses the slide order in presentation.xml without renaming slide files.
async function reverseDeckOrder(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const pres = await zip.file('ppt/presentation.xml').async('string');
  const ids = [...pres.matchAll(/<p:sldId [^>]*\/>/g)].map((m) => m[0]);
  zip.file('ppt/presentation.xml', pres.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, `<p:sldIdLst>${ids.reverse().join('')}</p:sldIdLst>`));
  return zip.generateAsync({ type: 'nodebuffer' });
}

const blocks = (text) => text.split('\n\n');
const words = (n, w = 'lorem') => Array(n).fill(w).join(' ');

// ---- PPTX ---------------------------------------------------------------------------------
describe('pptx: lists and tables', () => {
  it('keeps ordered lists, bullets and table rows that a paragraph-only walk would drop', async () => {
    const buf = await makePptx([
      {
        title: 'Cell Biology',
        numbered: ['First step', 'Second step'],
        bullets: ['Plain bullet one', 'Plain bullet two'],
        table: [['Organelle', 'Function'], ['Nucleus', 'Stores DNA']],
      },
    ]);
    const { text } = await extractText(buf, '.pptx');
    const lines = text.split('\n');
    assert.deepEqual(lines, [
      'Cell Biology', '1. First step', '2. Second step', '- Plain bullet one', '- Plain bullet two',
      'Organelle | Function', 'Nucleus | Stores DNA',
    ]);
  });
});

describe('pptx: title placeholders', () => {
  it('keeps text that PowerPoint stores in a title placeholder', async () => {
    const pptx = new PptxGenJS();
    pptx.defineSlideMaster({
      title: 'WITH_TITLE',
      objects: [{ placeholder: { options: { name: 'heading', type: 'title', x: 0.5, y: 0.3, w: 9, h: 1 }, text: '' } }],
    });
    const slide = pptx.addSlide({ masterName: 'WITH_TITLE' });
    slide.addText('Lesson Objectives', { placeholder: 'heading' });
    slide.addText('Body text under the title.', { x: 0.5, y: 2, w: 9, h: 1 });
    const { text } = await extractText(await pptx.write({ outputType: 'nodebuffer' }), '.pptx');
    assert.deepEqual(text.split('\n'), ['Lesson Objectives', 'Body text under the title.']);
  });
});

describe('pptx: speaker notes', () => {
  const deck = () => makePptx([
    { title: 'Slide One', notes: 'Explain the first idea.\nGive an everyday example.' },
    { title: 'Slide Two' },
    { title: 'Slide Three', notes: 'Only notes here.' },
  ]);

  it('appends notes under "Notes:" inside that slide\'s block', async () => {
    const { text } = await extractText(await deck(), '.pptx');
    assert.deepEqual(blocks(text), [
      // pptxgenjs writes "\n" as a literal newline inside one run, which XML treats as a space
      'Slide One\nNotes:\nExplain the first idea. Give an everyday example.',
      'Slide Two',
      'Slide Three\nNotes:\nOnly notes here.',
    ]);
  });

  describe('notes belong to the slide that links to them, not to the Nth slide', () => {
    const three = () => makePptx([
      { title: 'Slide A', notes: 'note for A' },
      { title: 'Slide B', notes: 'note for B' },
      { title: 'Slide C', notes: 'note for C' },
    ]);
    const retarget = (from, to) => (rels) => rels.replace(`notesSlide${from}.xml`, `notesSlide${to}.xml`);
    const noNotesLink = (rels) => rels.replace(/<Relationship\b[^>]*notesSlide[^>]*\/>/, '');

    it('follows the slide relationship when notes pages are linked out of order', async () => {
      let buf = await three();
      buf = await editSlideRels(buf, 1, retarget(1, 3));
      buf = await editSlideRels(buf, 3, retarget(3, 1));
      const { text } = await extractText(buf, '.pptx');
      assert.deepEqual(blocks(text), [
        'Slide A\nNotes:\nnote for C',
        'Slide B\nNotes:\nnote for B',
        'Slide C\nNotes:\nnote for A',
      ]);
    });

    it('leaves a slide without a notes page empty instead of shifting the other notes onto it', async () => {
      const buf = await editSlideRels(await three(), 1, noNotesLink);
      const { text } = await extractText(buf, '.pptx');
      assert.deepEqual(blocks(text), ['Slide A', 'Slide B\nNotes:\nnote for B', 'Slide C\nNotes:\nnote for C']);
    });
  });

  it('drops a lone page number from the notes and adds no "Notes:" label for it', async () => {
    const { text } = await extractText(await makePptx([{ title: 'Only a number in notes', notes: '7' }]), '.pptx');
    assert.equal(text, 'Only a number in notes');
  });

  it('leaves notes out when includeNotes is false', async () => {
    const { text, wordCount } = await extractText(await deck(), '.pptx', { includeNotes: false });
    assert.deepEqual(blocks(text), ['Slide One', 'Slide Two', 'Slide Three']);
    assert.doesNotMatch(text, /Notes:|everyday example/);
    assert.equal(wordCount, 6);
  });
});

describe('pptx: soft line breaks', () => {
  it('starts a new line at every <a:br> form PowerPoint writes, without gluing words together', () => {
    const xml = [
      '<a:p><a:r><a:t>Heading</a:t></a:r><a:br><a:rPr lang="en-PH" dirty="0"/></a:br>',
      '<a:r><a:t>Explanation.</a:t></a:r><a:br/>',
      '<a:r><a:t xml:space="preserve">Example:</a:t></a:r><a:r><a:t> A teacher &amp; students.</a:t></a:r></a:p>',
      '<a:p/><a:p><a:r><a:t>Next paragraph</a:t></a:r></a:p>',
    ].join('');
    assert.deepEqual(drawingMlLines(xml), ['Heading', 'Explanation.', 'Example: A teacher & students.', 'Next paragraph']);
  });

  it('splits glued sentences and _x000B_ soft returns, but not abbreviations', () => {
    assert.deepEqual(textLines('Build relationships and trust.Share your background, skills, and interests.'), [
      'Build relationships and trust.',
      'Share your background, skills, and interests.',
    ]);
    assert.deepEqual(textLines('First line_x000B_Second line'), ['First line', 'Second line']);
    assert.deepEqual(textLines('Use tools, e.g.The library at St.Mary school.'), ['Use tools, e.g.The library at St.Mary school.']);
    assert.deepEqual(textLines('KEY ELEMENTS OF AN EFFECTIVE\nSELF-INTRODUCTION'), ['KEY ELEMENTS OF AN EFFECTIVE', 'SELF-INTRODUCTION']);
  });

  // The self-introduction lesson came out with "- Build relationships and trust.Share your background…": two runs in
  // one bullet paragraph with no break between them.
  it('keeps every bullet of a slide on its own line, whatever joins them in the XML', async () => {
    const pptx = new PptxGenJS();
    pptx.addSlide().addText(
      ['Introduce yourself clearly.', 'Build relationships and trust.', 'Encourage meaningful communication.', 'Last one.'].map((text) => ({
        text,
        options: { bullet: true, breakLine: true },
      })),
      { x: 0.5, y: 1, w: 9, h: 3 },
    );
    const zip = await JSZip.loadAsync(await pptx.write({ outputType: 'nodebuffer' }));
    let xml = await zip.file('ppt/slides/slide1.xml').async('string');
    // bullet 2 + "Share…" as a second run with no break; bullet 3 + "Starts…" after an <a:br>; bullet 4 with a _x000B_
    xml = xml.replace('trust.</a:t></a:r>', 'trust.</a:t></a:r><a:r><a:t>Share your background.</a:t></a:r>');
    xml = xml.replace('communication.</a:t></a:r>', 'communication.</a:t></a:r><a:br/><a:r><a:t>Starts conversations.</a:t></a:r>');
    xml = xml.replace('Last one.', 'Last one._x000B_Shows professionalism.');
    assert.ok(xml.includes('Share your background'));
    zip.file('ppt/slides/slide1.xml', xml);
    const { text } = await extractText(await zip.generateAsync({ type: 'nodebuffer' }), '.pptx');
    assert.deepEqual(text.split('\n'), [
      '- Introduce yourself clearly.',
      '- Build relationships and trust.',
      '- Share your background.',
      '- Encourage meaningful communication.',
      'Starts conversations.',
      '- Last one.',
      '- Shows professionalism.',
    ]);
  });
});

describe('pptx: SmartArt', () => {
  it('appends SmartArt text to the slide that links to it, decoding entities', async () => {
    const base = await makePptx([{ title: 'Intro' }, { title: 'Process of Research' }, { title: 'Wrap up' }]);
    const buf = await addSmartArt(base, 2, ['Ask a question', 'Collect data &amp; analyse it', 'Process of Research']);
    const { text } = await extractText(buf, '.pptx');
    assert.deepEqual(blocks(text), [
      'Intro',
      // the repeated title is not duplicated
      'Process of Research\nAsk a question\nCollect data & analyse it',
      'Wrap up',
    ]);
  });

  it('does not repeat text the slide already has as a list, even with a typed bullet or list prefix', async () => {
    const base = await makePptx([{ title: 'Research', bullets: ['• Begins with a problem', 'Guided by questions'] }]);
    const buf = await addSmartArt(base, 1, ['• Begins with a problem', 'Guided by questions', '• Cyclical process']);
    const { text } = await extractText(buf, '.pptx');
    assert.deepEqual(text.split('\n'), ['Research', '- Begins with a problem', '- Guided by questions', '- Cyclical process']);
  });

  it('keeps SmartArt before the slide notes', async () => {
    const base = await makePptx([{ title: 'Methods', notes: 'Teacher says hello.' }]);
    const { text } = await extractText(await addSmartArt(base, 1, ['Case study']), '.pptx');
    assert.equal(text, 'Methods\nCase study\nNotes:\nTeacher says hello.');
  });
});

describe('pptx: slide order', () => {
  it('follows the deck order, not the slide file numbers, and keeps SmartArt on the right slide', async () => {
    const base = await makePptx([{ title: 'ALPHA' }, { title: 'BRAVO' }, { title: 'CHARLIE' }]);
    const withArt = await addSmartArt(base, 1, ['alpha diagram']); // slide1.xml is ALPHA
    const { text } = await extractText(await reverseDeckOrder(withArt), '.pptx');
    assert.deepEqual(blocks(text), ['CHARLIE', 'BRAVO', 'ALPHA\nalpha diagram']);
  });
});

describe('word count and warning use the final combined text', () => {
  let db;
  let server;
  let base;
  const upload = async (buffer, name) => {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: PPTX_MIME }), name);
    return (await fetch(`${base}/api/lessons`, { method: 'POST', body: form })).json();
  };

  before(async () => {
    db = openDb(':memory:');
    runMigrations(db);
    seedTestLogin(db);
    const app = createApp(db, { maxUploadBytes: 5 * 1024 * 1024, adminPin: TEST_PIN }, { runner: { enqueue() {} } });
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  it('seeds include_speaker_notes = true', () => {
    assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'include_speaker_notes'").get().value, 'true');
  });

  it('counts notes and SmartArt words, and drops the low-text warning because of them', async () => {
    const buf = await addSmartArt(await makePptx([{ title: 'Thin slide', notes: words(180) }]), 1, [words(5, 'diagram')]);
    const { lesson, warning } = await upload(buf, 'notes-heavy.pptx');
    assert.equal(lesson.word_count, 2 + 5 + 1 + 180, 'title + SmartArt + "Notes:" label + notes');
    assert.equal(warning, null);
    const { raw_text } = (await (await fetch(`${base}/api/lessons/${lesson.id}`)).json()).lesson;
    assert.equal(countWords(raw_text), lesson.word_count);
  });

  it('honours include_speaker_notes = false and warns again', async () => {
    db.prepare("UPDATE settings SET value = 'false' WHERE key = 'include_speaker_notes'").run();
    const { lesson, warning } = await upload(await makePptx([{ title: 'Thin slide', notes: words(180) }]), 'no-notes.pptx');
    assert.equal(lesson.word_count, 2);
    assert.match(warning, /Very little text/);
    const { raw_text } = (await (await fetch(`${base}/api/lessons/${lesson.id}`)).json()).lesson;
    assert.doesNotMatch(raw_text, /Notes:|lorem/);
  });
});

// ---- PDF reflow ---------------------------------------------------------------------------
// A line of exactly `n` characters made of words, so "typical width" is predictable.
// It has no terminal punctuation and starts with `seed`'s first letter.
const fullLine = (seed, n = 70) => `${Array(40).fill(`${seed}${seed}${seed}`).join(' ').slice(0, n - 1)}x`;

describe('pdf reflow', () => {
  it('joins wrapped lines into a paragraph that ends at the short last line', () => {
    const page = [fullLine('a'), fullLine('b'), 'and the last short line.', fullLine('c'), 'Another end.'].join('\n');
    const [block] = reflowPdfPages([page]);
    const paras = block.split('\n');
    assert.equal(paras.length, 2);
    assert.equal(paras[0], `${fullLine('a')} ${fullLine('b')} and the last short line.`);
    assert.equal(paras[1], `${fullLine('c')} Another end.`);
  });

  it('removes the line break at a hyphen but keeps the hyphen', () => {
    const page = ['The review of every submitted record took a long time and was time-', 'consuming for the team.', fullLine('z', 66)].join('\n');
    const [block] = reflowPdfPages([page]);
    assert.match(block, /was time-consuming for the team\./);
    assert.doesNotMatch(block, /time- consuming/);
  });

  it('splits inline bullet glyphs onto their own lines, including a marker at the end of a line', () => {
    const page = [
      'There are three main categories of human nonverbal communication here ok:',
      '» Briefs: the detachment of individual human words » Language: the',
      'joining of words or pictures to form sentences »',
      'Nonverbal communication:',
    ].join('\n');
    const [block] = reflowPdfPages([page]);
    assert.deepEqual(block.split('\n'), [
      'There are three main categories of human nonverbal communication here ok:',
      '» Briefs: the detachment of individual human words',
      '» Language: the joining of words or pictures to form sentences',
      '» Nonverbal communication:',
    ]);
  });

  it('keeps a short heading on its own line', () => {
    const page = ['Chapter 1 - INTRODUCING AI', fullLine('P'), fullLine('q'), 'End of it.'].join('\n');
    const [block] = reflowPdfPages([page]);
    assert.equal(block.split('\n')[0], 'Chapter 1 - INTRODUCING AI');
    assert.equal(block.split('\n').length, 2);
  });

  describe('page seams', () => {
    const page1 = [fullLine('m'), fullLine('n'), 'which was only possible after we could figure out'].join('\n');

    it('merges the next page\'s opening when it starts lowercase after an unterminated sentence', () => {
      const page2 = ['how', 'thinking and acting more human-like works.', fullLine('r'), 'The end.'].join('\n');
      const out = reflowPdfPages([page1, page2]);
      assert.equal(out.length, 2);
      const merged = out[0].split('\n').pop();
      assert.match(merged, /figure out how thinking and acting more human-like works\.$/, 'the stray "how" rejoins the sentence');
      assert.equal(out[1].split('\n')[0], `${fullLine('r')} The end.`, 'rest of page 2 stays on page 2');
    });

    it('does not merge when the next page starts with a capital', () => {
      const out = reflowPdfPages([page1, ['A new section starts here.', fullLine('s')].join('\n')]);
      assert.equal(out.length, 2);
      assert.doesNotMatch(out[0], /A new section/);
    });

    it('does not merge when the previous page ended its sentence', () => {
      const ended = [fullLine('m'), 'which ended properly.'].join('\n');
      const out = reflowPdfPages([ended, 'and then a lowercase start that is odd.']);
      assert.equal(out.length, 2);
    });

    it('does not run full-width pages together when every line ends in a period', () => {
      const line = (s) => `${s.padEnd(69, 'x')}.`;
      const out = reflowPdfPages([[line('a'), line('b')].join('\n'), [line('c'), line('d')].join('\n')]);
      assert.equal(out.length, 2);
    });
  });
});

describe('pdf: time budget', () => {
  const TOPICS = ['Glaciers', 'Volcanoes', 'Deserts', 'Rivers', 'Forests'];
  const make = async (pages) => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pages; i += 1) pdf.addPage([612, 792]).drawText(`${TOPICS[i % TOPICS.length]} is the subject of page ${i + 1}.`, { x: 50, y: 700, size: 11, font });
    return Buffer.from(await pdf.save());
  };

  it('reads a normal PDF well inside the default budget', async () => {
    const { text, pageCount } = await extractPdf(await make(3));
    assert.equal(pageCount, 3);
    assert.match(text, /Volcanoes is the subject of page 2/);
  });

  it('gives up with a 422 when the budget is spent (best effort: it is checked between pages)', async () => {
    await assert.rejects(extractPdf(await make(5), { budgetMs: 1 }), (err) => err.status === 422 && /took too long/.test(err.message));
  });

  it('shows that message to the uploader instead of the generic one', async () => {
    const { extractText: extract } = await import('../src/services/extract.js');
    await assert.rejects(extract(await make(5), '.pdf', { pdfBudgetMs: 1 }), (err) => err.status === 422 && /took too long/.test(err.message));
  });
});

describe('pdf: end to end', () => {
  it('reflows a generated PDF, fixes the hyphen, and merges the page seam', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const draw = (lines) => {
      const page = pdf.addPage([612, 792]);
      lines.forEach((l, i) => page.drawText(l, { x: 50, y: 700 - i * 18, size: 11, font }));
    };
    draw([
      'Reviewing every record by hand is slow, repetitive and very time-',
      'consuming for a small team of volunteers working part time on it.',
      'Automation helps, because the same checks run on every single record and',
      'it never gets tired, and it can explain which rule failed on each one so that',
      'people can fix it. This second paragraph ends mid-thought and carries on over',
    ]);
    draw([
      'to the next page where it finishes here.',
      'A brand new paragraph starts afterwards, with enough words in it to span a',
      'full line of text on the page for the width estimate to be sensible.',
    ]);
    const { text } = await extractText(Buffer.from(await pdf.save()), '.pdf');
    assert.match(text, /very time-consuming for a small team/);
    assert.match(text, /carries on over to the next page where it finishes here\./, 'seam merged');
    const [page1, page2] = blocks(text);
    assert.match(page1, /finishes here\./, 'merged paragraph stays on the page it starts on');
    assert.match(page2, /^A brand new paragraph starts afterwards/);
  });
});

// ---- equations ----------------------------------------------------------------------------
describe('equations survive extraction', () => {
  it('reads Word equations as Unicode text, between the words around them', async () => {
    const doc = new Document({
      sections: [{
        children: [
          new Paragraph({
            children: [
              new TextRun('The area is '),
              new Math({ children: [new MathRun('A='), new MathRun('π'), new MathSuperScript({ children: [new MathRun('r')], superScript: [new MathRun('2')] })] }),
              new TextRun(' for a circle.'),
            ],
          }),
          new Paragraph({ children: [new TextRun('Half is '), new Math({ children: [new MathFraction({ numerator: [new MathRun('1')], denominator: [new MathRun('2')] })] }), new TextRun(' of it.')] }),
        ],
      }],
    });
    const { text } = await extractText(await Packer.toBuffer(doc), '.docx');
    assert.match(text, /The area is A=πr² for a circle\./);
    assert.match(text, /Half is \(?1\/2\)? of it\./);
    assert.ok(text.indexOf('The area is') < text.indexOf('Half is'));
    assert.doesNotMatch(text, /\\/);
    assert.equal(blocks(text).length, 2, 'every paragraph is still its own block');
  });

  it('reads a PowerPoint equation as the exact latexToText output, once', async () => {
    const pptx = new PptxGenJS();
    const slide = pptx.addSlide();
    slide.addText('Kinetic energy', { x: 0.5, y: 0.2, w: 9, h: 0.8, fontSize: 28 });
    slide.addText('MATHHERE', { x: 0.5, y: 1.1, w: 9, h: 0.6 });
    const zip = await JSZip.loadAsync(await pptx.write({ outputType: 'nodebuffer' }));
    // the equation as PowerPoint writes it: a14:m inside mc:AlternateContent, a sibling of the runs
    const r = (t) => `<m:r><m:t>${t}</m:t></m:r>`;
    const omml = `<m:oMath>${r('KE=')}<m:f><m:num>${r('1')}</m:num><m:den>${r('2')}</m:den></m:f>${r('m')}<m:sSup><m:e>${r('v')}</m:e><m:sup>${r('2')}</m:sup></m:sSup></m:oMath>`;
    const equation = `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" Requires="a14"><a14:m><m:oMathPara xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">${omml}</m:oMathPara></a14:m></mc:Choice><mc:Fallback/></mc:AlternateContent>`;
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    const patched = xml.replace(/<a:r>(?:(?!<\/a:r>)[\s\S])*MATHHERE[\s\S]*?<\/a:r>/, `<a:r><a:t>Energy: </a:t></a:r>${equation}`);
    assert.notEqual(patched, xml, 'the fixture was patched');
    zip.file('ppt/slides/slide1.xml', patched);
    const { text } = await extractText(await zip.generateAsync({ type: 'nodebuffer' }), '.pptx');
    assert.equal(text.split('\n')[1], `Energy: ${latexToText('KE=\\frac{1}{2}mv^{2}')}`);
    assert.equal(text.split('\n')[1], 'Energy: KE=(1/2)mv²');
    assert.equal(text.match(/KE=/g).length, 1, 'the equation is not repeated');
    assert.doesNotMatch(text, /\\/);
  });

  it('converts LaTeX typed into a PDF', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage([612, 792]).drawText('The square is x^{2} here.', { x: 50, y: 700, size: 11, font });
    const { text } = await extractText(Buffer.from(await pdf.save()), '.pdf');
    assert.match(text, /The square is x² here\./);
  });
});

// ---- superscripts and subscripts in a PDF ---------------------------------------------------------
// Each piece is [text, { size, dy }]: drawn straight after the one before it, dy points above (or below) the baseline.
async function scriptPdf(pieces, { pageSize = 12 } = {}) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  let x = 60;
  for (const [text, { size = pageSize, dy = 0 } = {}] of pieces) {
    page.drawText(text, { x, y: 700 + dy, size, font });
    x += font.widthOfTextAtSize(text, size);
  }
  return Buffer.from(await pdf.save());
}

describe('pdf: superscripts and subscripts', () => {
  const small = { size: 8, dy: 5 };
  const low = { size: 8, dy: -3 };

  it('writes a raised exponent as Unicode, never as a bare 1023', async () => {
    const { text } = await extractText(await scriptPdf([["Avogadro's number is 6.022 × 10"], ['23', small], [' particles per mole.']]), '.pdf');
    assert.match(text, /6\.022 × 10²³ particles per mole\./);
    assert.doesNotMatch(text, /1023/);
  });

  it('writes x², a negative exponent and a trailing charge', async () => {
    const { text } = await extractText(await scriptPdf([['Area x'], ['2', small], [' and 10'], ['-3', small], [' and Ca'], ['2+', small], [' ok']]), '.pdf');
    assert.match(text, /Area x² and 10⁻³ and Ca²⁺ ok/);
  });

  it('writes a clearly lowered digit after a letter as a subscript', async () => {
    const { text } = await extractText(await scriptPdf([['Water is H'], ['2', low], ['O and CO'], ['2', low], [' is a gas.']]), '.pdf');
    assert.match(text, /Water is H₂O and CO₂ is a gas\./);
  });

  it('follows the text rise operator (Ts) as well as a moved baseline', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([612, 792]);
    const fontKey = page.node.newFontDictionary(font.name, font.ref);
    page.pushOperators(
      beginText(), moveText(60, 700),
      setFontAndSize(fontKey, 12), showText(font.encodeText('Speed is 3 × 10')),
      setFontAndSize(fontKey, 8), setTextRise(5), showText(font.encodeText('8')),
      setFontAndSize(fontKey, 12), setTextRise(0), showText(font.encodeText(' m/s.')),
      endText(),
    );
    const { text } = await extractText(Buffer.from(await pdf.save()), '.pdf');
    assert.match(text, /Speed is 3 × 10⁸ m\/s\./);
  });

  it('leaves doubtful cases unchanged', async () => {
    const same = await extractText(await scriptPdf([['Room 10'], ['23', { dy: 5 }], [' is open.']]), '.pdf');
    assert.match(same.text, /Room 1023 is open\./, 'a raised digit at the normal size is not a script');
    const barely = await extractText(await scriptPdf([['Room 10'], ['23', { size: 8, dy: 1 }], [' is open.']]), '.pdf');
    assert.match(barely.text, /Room 1023 is open\./, 'a small digit hardly raised is not a script');
    const word = await extractText(await scriptPdf([['Page 4 of 9 in volume'], ['12', small]]), '.pdf');
    assert.match(word.text, /volume¹²/, 'sanity: attached to a word it is a script');
    const spaced = await extractText(await scriptPdf([['Room '], ['23', small], [' is open.']]), '.pdf');
    assert.match(spaced.text, /Room 23 is open\./, 'after a space it is not attached');
    const letters = await extractText(await scriptPdf([['A ratio of 3'], ['x', small]]), '.pdf');
    assert.match(letters.text, /3x/, 'only digits, signs and n are converted');
    const subAfterDigit = await extractText(await scriptPdf([['Total 10'], ['2', low]]), '.pdf');
    assert.match(subAfterDigit.text, /Total 102/, 'a subscript needs a letter before it');
  });

  it('extracts a plain PDF exactly as before', async () => {
    const { text } = await extractText(await scriptPdf([['H2O has 1023 particles and x2 is here.']]), '.pdf');
    assert.equal(text, 'H2O has 1023 particles and x2 is here.');
  });
});
