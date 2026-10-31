import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractPdf } from '../src/services/pdf.js';
import { applyStrays, findStrays } from '../src/services/pdf-strays.js';

const SIZE = 6.48;
const item = (str, x, width, { y = 397.45, size = SIZE } = {}) => ({ str, transform: [size, 0, 0, size, x, y], width, hasEOL: false });

describe('pdf strays: findStrays', () => {
  // the shape of a lecture slide: three letters lost from one line, listed on their own, the line left with a space for each
  it('places each loose letter at the space it belongs in', () => {
    const line = item('Th nk carefu y about how each force affects an ob ect.', 100, 154.36);
    const found = findStrays([item('i', 107.5, 1.44), item('ll', 136, 2.9), item('j', 224.5, 1.44), line]);
    assert.deepEqual(found, [
      { stray: 0, host: 3, at: 2 }, // "Th nk"
      { stray: 1, host: 3, at: 12 }, // "carefu y"
      { stray: 2, host: 3, at: 43 }, // "ob ect"
    ]);
  });

  it('skips a letter with no lowercase neighbour', () => {
    assert.deepEqual(findStrays([item('c', 110, 3), item('O X Y', 100, 40)]), []);
  });

  it('skips a modifier circumflex (not a cased letter)', () => {
    assert.deepEqual(findStrays([item('y', 112, 3), item('the ^ end', 100, 40)]), []);
  });

  it('skips a letter where the host has no space gap', () => {
    assert.deepEqual(findStrays([item('θ', 118, 3), item('sec(x) = 1/cos(x)', 100, 80)]), []);
  });

  it('skips a letter 30% smaller than the host', () => {
    const small = item('i', 111, 1.4, { size: SIZE * 0.7 });
    assert.deepEqual(findStrays([small, item('Th nk about it', 100, 60)]), []);
  });

  it('skips a letter 2 points off the baseline', () => {
    assert.deepEqual(findStrays([item('i', 111, 1.4, { y: 399.45 }), item('Th nk about it', 100, 60)]), []);
  });

  it('skips a duplicate (a bold glyph drawn twice)', () => {
    assert.deepEqual(findStrays([item('is', 118, 4), item('this is', 100, 30)]), []);
  });
});

describe('pdf strays: applyStrays', () => {
  it('writes the letters into their gaps and empties the strays (the findStrays fixture, with the places given)', () => {
    const line = item('Th nk carefu y about how each force affects an ob ect.', 100, 154.36);
    const items = [item('i', 107.5, 1.44), item('ll', 136, 2.9), item('j', 224.5, 1.44), line];
    const out = applyStrays(items, [
      { stray: 0, host: 3, at: 2 },
      { stray: 1, host: 3, at: 12 },
      { stray: 2, host: 3, at: 49 },
    ]);
    assert.equal(out[3].str, 'Think carefully about how each force affects an object.');
    assert.deepEqual([out[0].str, out[1].str, out[2].str], ['', '', '']);
    assert.equal(line.str, 'Th nk carefu y about how each force affects an ob ect.'); // the input is not changed
  });

  it('keeps the line break of a placed letter', () => {
    const line = item('Think carefully ab ut how each force affects an object.', 100, 154.36);
    const stray = { ...item('o', 0, 3), hasEOL: true };
    const out = applyStrays([stray, line], [{ stray: 0, host: 1, at: 18 }]);
    assert.equal(out[1].str, 'Think carefully about how each force affects an object.');
    assert.equal(out[0].str, '');
    assert.equal(out[0].hasEOL, true);
    assert.equal(line.str, 'Think carefully ab ut how each force affects an object.'); // the input is not changed
  });

  it('joins several letters at one gap in x order, and fills the highest gap first', () => {
    const line = item('Th nk carefu y', 100, 60);
    const items = [item('l', 150, 1), item('l', 140, 1), item('i', 110, 1), line];
    const out = applyStrays(items, [
      { stray: 0, host: 3, at: 12 },
      { stray: 1, host: 3, at: 12 },
      { stray: 2, host: 3, at: 2 },
    ]);
    assert.equal(out[3].str, 'Think carefully');
  });

  it('leaves everything alone with no placements', () => {
    const items = [item('i', 110, 1), item('Th nk', 100, 20)];
    assert.equal(applyStrays(items, []), items);
  });
});

describe('pdf strays: extractPdf', () => {
  it('counts the loose letters in a PDF that drew them apart from their line', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([612, 792]);
    // each line is the text before a gap, the letters that belong in it, the text after; the letters are drawn first
    const lines = [
      ['Th', 'i', 'nk carefu', 'll', 'y about how each force affects an ob', 'j', 'ect.'],
      ['Next Master', 'i', 'ng Phys', 'i', 'cs dead', 'li', 'ne ', 'i', 's next Monday.'],
      ['Work done by a force ', 'i', 's not a vector quant', 'i', 'ty.'],
    ];
    let y = 700;
    for (const parts of lines) {
      let before = '';
      let host = '';
      parts.forEach((part, k) => {
        if (k % 2 === 0) {
          before += part;
          host += part;
        } else {
          page.drawText(part, { x: 60 + font.widthOfTextAtSize(before, 12), y, size: 12, font });
          host += ' ';
        }
      });
      page.drawText(host, { x: 60, y, size: 12, font });
      y -= 30;
    }
    const result = await extractPdf(Buffer.from(await pdf.save()));
    assert.equal(result.strays, 9);
    assert.match(result.text, /Think carefully about how each force affects an object\./);
    assert.match(result.text, /Mastering Physics/);
    const textLines = result.text.split('\n').filter((l) => l.trim());
    assert.ok(!textLines.some((l) => /^[a-z]{1,3}$/.test(l.trim())), 'no line made only of stray letters');
  });

  it('changes nothing when every candidate is rejected', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([612, 792]);
    page.drawText('sec(x) = 1/cos(x)', { x: 60, y: 700, size: 12, font });
    page.drawText('c', { x: 66, y: 700, size: 12, font }); // lands in the host but nowhere with a space gap
    page.drawText('O X Y', { x: 60, y: 660, size: 12, font });
    page.drawText('y', { x: 70, y: 660, size: 12, font }); // no lowercase neighbour
    const { text, strays } = await extractPdf(Buffer.from(await pdf.save()));
    assert.equal(strays, 0);
    assert.equal(text, 'sec(x) = 1/cos(x)c O X Yy'); // as it reads with the loose letters left alone
  });

  it('leaves a clean PDF alone when a short label sits over a longer line', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([612, 792]);
    page.drawText('The cell membrane controls what enters the cell.', { x: 60, y: 700, size: 12, font });
    page.drawText('A', { x: 60 + font.widthOfTextAtSize('The', 12) + 1, y: 700, size: 12, font }); // a diagram label over the first space
    const { text, strays } = await extractPdf(Buffer.from(await pdf.save()));
    assert.equal(strays, 1); // it looks like a loose letter, but one in the whole document is not damage
    assert.equal(text, 'The cell membrane controls what enters the cell.A'); // so "TheAcell" is not written
  });

  it('gives none for a PDF without loose letters', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage([612, 792]).drawText('Thinking carefully about how each force affects an object.', { x: 60, y: 700, size: 12, font });
    const { text, strays } = await extractPdf(Buffer.from(await pdf.save()));
    assert.equal(strays, 0);
    assert.equal(text, 'Thinking carefully about how each force affects an object.');
  });
});

describe('pdf strays: findStrays, edge cases', () => {
  it('rejects a mirrored stray or host (it reads the other way)', () => {
    const mirrored = (it) => ({ ...it, transform: [-SIZE, 0, 0, SIZE, it.transform[4], it.transform[5]] });
    const stray = item('i', 107.5, 1.44);
    const line = item('Th nk about it', 100, 60);
    assert.equal(findStrays([stray, line]).length, 1);
    assert.deepEqual(findStrays([mirrored(stray), line]), []);
    assert.deepEqual(findStrays([stray, mirrored(line)]), []);
  });

  it('does not move the next letters by the width of one that was skipped', () => {
    const line = item('Th nk about it', 100, 60);
    const skipped = item('Q', 102, 8); // too far from any space to be placed
    const found = findStrays([skipped, item('i', 107.5, 1.44), line]);
    assert.deepEqual(found, [{ stray: 1, host: 2, at: 2 }]);
  });

  it('finds the first host on the page, as a scan of every item would', () => {
    const near = item('Th nk about it', 100, 60, { y: 397.8 }); // 0.35 off the stray's baseline, within the tolerance
    const exact = item('Th nk about it', 100, 60);
    assert.deepEqual(findStrays([item('i', 107.5, 1.44), near, exact]), [{ stray: 0, host: 1, at: 2 }]);
    assert.deepEqual(findStrays([item('i', 107.5, 1.44), exact, near]), [{ stray: 0, host: 1, at: 2 }]);
  });

  it('stays fast on a page of 5000 items', () => {
    const items = [];
    for (let line = 0; line < 100; line += 1) {
      const y = 780 - line * 7;
      items.push(item('Th nk about it and carefu y again', 20, 400, { y }));
      for (let k = 0; k < 49; k += 1) items.push(item(k % 2 ? 'of' : 'A', 25 + k * 8, 4, { y }));
    }
    assert.equal(items.length, 5000);
    const started = performance.now();
    findStrays(items);
    assert.ok(performance.now() - started < 100, 'findStrays took too long');
  });
});
