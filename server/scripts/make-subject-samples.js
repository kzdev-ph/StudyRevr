// Makes five small sample lessons (math, physics, chemistry, history, literature) in test-lessons/subjects/ (git-ignored),
// to see how each subject fares in the lesson pipeline. Run it from anywhere:
//
//   node server/scripts/make-subject-samples.js
//
// Then run each file, e.g.  npm run pipeline -- test-lessons/subjects/math-quadratics.docx --show-text --save=test-lessons/subjects/out/math-quadratics.db
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, Math as OfficeMath, MathFraction, MathRadical, MathRun, MathSuperScript, Packer, Paragraph, TextRun } from 'docx';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import PptxGenJS from 'pptxgenjs';

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test-lessons', 'subjects');
fs.mkdirSync(OUT_DIR, { recursive: true });
const write = (name, buffer) => {
  fs.writeFileSync(path.join(OUT_DIR, name), buffer);
  console.log(`Wrote ${path.join(OUT_DIR, name)}`);
};

// ---------- docx helpers ----------
const para = (text, opts = {}) => new Paragraph({ children: [new TextRun(text)], ...opts });
const heading = (text) => new Paragraph({ children: [new TextRun({ text, bold: true, size: 30 })], spacing: { before: 240, after: 120 } });
const run = (text) => new MathRun(text);
const sup = (base, exponent) => new MathSuperScript({ children: [run(base)], superScript: [run(exponent)] });
const equation = (...children) => new Paragraph({ children: [new OfficeMath({ children })] });

// ---------- 1. math-quadratics.docx ----------
async function makeMath() {
  const doc = new Document({
    numbering: {
      config: [{ reference: 'steps', levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: 'left' }] }],
    },
    sections: [
      {
        children: [
          heading('Quadratic Equations'),
          para('A quadratic equation is an equation that can be written in the standard form shown below, where a, b and c are real numbers and a is not zero. The highest power of the unknown x is 2.'),
          equation(run('a'), sup('x', '2'), run('+bx+c=0')),
          para('The roots of a quadratic equation are the values of x that make the equation true. A quadratic equation has at most two roots. Roots are also called solutions or zeros of the equation.'),
          para('The quadratic formula gives the roots of any quadratic equation in standard form:'),
          equation(
            run('x='),
            new MathFraction({
              numerator: [run('−b±'), new MathRadical({ children: [sup('b', '2'), run('−4ac')] })],
              denominator: [run('2a')],
            }),
          ),
          para('The discriminant is the expression under the square root sign. It is written D and it tells us how many real roots the equation has. If D is positive there are two different real roots, if D is zero there is one repeated root, and if D is negative there are no real roots.'),
          equation(run('D='), sup('b', '2'), run('−4ac')),
          heading('Solving by factoring'),
          para('Factoring is the fastest way to solve a quadratic equation when the numbers are small. Follow these steps.'),
          ...[
            'Move every term to the left side so that the right side is zero.',
            'Factor the left side into two brackets.',
            'Set each bracket equal to zero.',
            'Solve each of the two small equations to find the roots.',
          ].map((text) => para(text, { numbering: { reference: 'steps', level: 0 } })),
          heading('Worked example'),
          para('Solve the equation by factoring. The numbers 2 and 3 multiply to 6 and add to 5, so the equation factors as shown.'),
          equation(sup('x', '2'), run('−5x+6=0')),
          equation(run('(x−2)(x−3)=0')),
          equation(run('x=2 or x=3')),
          para('The roots of the equation are 2 and 3. Checking x = 2 gives 4 − 10 + 6 = 0, which is correct.'),
        ],
      },
    ],
  });
  write('math-quadratics.docx', await Packer.toBuffer(doc));
}

// ---------- 2. physics-newton.pptx ----------
const OMML = [
  '<m:r><m:t>KE=</m:t></m:r>',
  '<m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f>',
  '<m:r><m:t>m</m:t></m:r>',
  '<m:sSup><m:e><m:r><m:t>v</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup>',
].join('');
const ALTERNATE_CONTENT =
  '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" Requires="a14">' +
  `<a14:m><m:oMathPara xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:oMath>${OMML}</m:oMath></m:oMathPara></a14:m>` +
  '</mc:Choice><mc:Fallback/></mc:AlternateContent>';

async function makePhysics() {
  const pptx = new PptxGenJS();
  const slide = (title, lines, notes) => {
    const s = pptx.addSlide();
    s.addText(title, { x: 0.5, y: 0.3, w: 9, h: 0.8, fontSize: 28, bold: true });
    if (lines.length) s.addText(lines.map((text) => ({ text, options: { breakLine: true } })), { x: 0.5, y: 1.3, w: 9, h: 3.5, fontSize: 18 });
    if (notes) s.addNotes(notes);
    return s;
  };
  slide("Newton's Laws of Motion", ['Sir Isaac Newton described three laws of motion in 1687.', 'They explain how forces change the motion of objects.']);
  slide(
    "Newton's First and Second Laws",
    ['First law: an object stays at rest or moves at constant velocity unless a net force acts on it.', 'Second law: the net force on an object equals its mass times its acceleration.', 'F = ma', 'a = Δv/Δt'],
    'Stress that inertia is the tendency of an object to keep its state of motion. The first law is sometimes called the law of inertia.',
  );
  const s3 = slide('Energy of a Moving Object', ['Kinetic energy is the energy an object has because it is moving.']);
  s3.addText('EQ_PLACEHOLDER', { x: 0.5, y: 3.4, w: 9, h: 1, fontSize: 24 });
  slide('Units and Weight', ['Force is measured in newtons (N). Mass is measured in kilograms (kg). Acceleration is measured in metres per second squared (m/s²).', 'Weight is the force of gravity on an object: W = mg', 'On Earth g is about 9.8 m/s².'], 'Remind students that mass and weight are different things: mass is in kg, weight is in N.');
  slide('Worked Example', ['A box has a mass of 5 kg. It accelerates at 2 m/s².', 'Given: m = 5 kg, a = 2 m/s²', 'F = ma = 5 kg × 2 m/s² = 10 N', 'The net force on the box is 10 N.']);
  slide("Newton's Third Law", ['For every action there is an equal and opposite reaction.', 'When you push a wall, the wall pushes back on you with the same force.']);

  const zip = await JSZip.loadAsync(await pptx.write({ outputType: 'nodebuffer' }));
  const file = zip.file('ppt/slides/slide3.xml');
  const xml = await file.async('string');
  // the whole <a:r> that holds the placeholder (the nearest <a:r> before it up to the </a:r> after it)
  const start = xml.lastIndexOf('<a:r>', xml.indexOf('EQ_PLACEHOLDER'));
  const end = xml.indexOf('</a:r>', xml.indexOf('EQ_PLACEHOLDER')) + '</a:r>'.length;
  if (start < 0 || end < start + 6 || !xml.includes('EQ_PLACEHOLDER')) throw new Error('EQ_PLACEHOLDER run not found in slide3.xml');
  zip.file('ppt/slides/slide3.xml', xml.slice(0, start) + ALTERNATE_CONTENT + xml.slice(end));
  write('physics-newton.pptx', await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

// ---------- 3. chemistry-moles.pdf ----------
async function makeChemistry() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page;
  let y;
  const newPage = () => {
    page = pdf.addPage([595, 842]);
    y = 780;
  };
  const line = (text, { size = 12, f = font, gap = 20 } = {}) => {
    page.drawText(text, { x: 60, y, size, font: f });
    y -= gap;
  };
  const wrap = (text) => {
    const words = text.split(' ');
    let current = '';
    for (const word of words) {
      if (font.widthOfTextAtSize(`${current} ${word}`.trim(), 12) > 470) {
        line(current);
        current = word;
      } else current = `${current} ${word}`.trim();
    }
    if (current) line(current);
    y -= 6;
  };

  newPage();
  line('The Mole and Molar Mass', { size: 20, f: bold, gap: 32 });
  wrap('A mole is the amount of a substance that contains the same number of particles as there are atoms in 12 grams of carbon-12. The number of particles in one mole is called Avogadro\'s number.');
  // Avogadro's number with the exponent drawn as a separate, smaller, raised text, the way a real PDF stores it
  page.drawText('Avogadro\'s number is', { x: 60, y, size: 12, font });
  const startX = 60 + font.widthOfTextAtSize('Avogadro\'s number is ', 12);
  page.drawText('6.022 × 10', { x: startX, y, size: 12, font });
  const afterX = startX + font.widthOfTextAtSize('6.022 × 10', 12);
  page.drawText('23', { x: afterX + 1, y: y + 5, size: 8, font });
  page.drawText('particles per mole.', { x: afterX + 14, y, size: 12, font });
  y -= 32;
  wrap('The molar mass of a substance is the mass of one mole of it, measured in grams per mole (g/mol). The molar mass of an element in grams per mole is equal to its atomic mass.');
  line('Three things to remember about the mole:', { f: bold });
  line('1. One mole of any substance contains the same number of particles.', { gap: 18 });
  line('2. Molar mass is measured in g/mol.', { gap: 18 });
  line('3. Moles = mass in grams divided by molar mass.', { gap: 30 });

  newPage();
  line('Calculating Molar Mass', { size: 20, f: bold, gap: 32 });
  wrap('To find the molar mass of a compound, add the atomic masses of all the atoms in its formula.');
  line('Molar mass of H2O: 2 x 1.008 + 16.00 = 18.02 g/mol', { gap: 24 });
  line('Molar mass of CO2: 12.01 + 2 x 16.00 = 44.01 g/mol', { gap: 34 });
  line('Worked example', { size: 14, f: bold, gap: 26 });
  wrap('How many moles are in 88.02 g of CO2? The molar mass of CO2 is 44.01 g/mol, so the number of moles is 88.02 g divided by 44.01 g/mol, which is 2.000 mol.');
  wrap('Always write the unit in your answer. The unit of the answer here is mol.');
  write('chemistry-moles.pdf', Buffer.from(await pdf.save()));
}

// ---------- 4. history-katipunan.pptx ----------
async function makeHistory() {
  const pptx = new PptxGenJS();
  const slide = (title, lines, notes) => {
    const s = pptx.addSlide();
    s.addText(title, { x: 0.5, y: 0.3, w: 9, h: 0.8, fontSize: 28, bold: true });
    s.addText(lines.map((text) => ({ text, options: { breakLine: true } })), { x: 0.5, y: 1.3, w: 9, h: 3.5, fontSize: 18 });
    if (notes) s.addNotes(notes);
  };
  slide('The Katipunan', ['The Katipunan was a secret society founded in Manila on July 7, 1892.', 'Its full name was Kataastaasang Kagalanggalangang Katipunan ng mga Anak ng Bayan.', 'Its goal was independence from Spain by revolution.']);
  slide('Andres Bonifacio', ['Andres Bonifacio was born in Tondo, Manila, in 1863.', 'He was a founder of the Katipunan and became its Supremo.', 'He led the movement as the Katipunan grew in number.'], 'Bonifacio worked as a warehouse clerk and sold canes and fans. He had little formal schooling but read widely.');
  slide('The Cry of Pugad Lawin', ['In August 1896 the Spanish authorities discovered the Katipunan.', 'Katipuneros gathered at Pugad Lawin and tore up their cedulas as a sign of defiance.', 'This event, in 1896, is known as the Cry of Pugad Lawin and it started the Philippine Revolution.']);
  slide('Causes of the Revolution', ['Four causes of the Philippine Revolution:', '1. Abuses of the Spanish friars and the colonial government', '2. Unequal treatment of Filipinos under Spanish law', '3. The execution of Gomburza in 1872 and the Propaganda Movement', '4. Heavy taxes and forced labor']);
  slide('The Tejeros Convention', ['The Tejeros Convention was held on March 22, 1897 in Tejeros, Cavite.', 'The Katipuneros met to choose a revolutionary government.', 'Emilio Aguinaldo was elected president, and Bonifacio was given a lower post.'], 'The election at Tejeros led to the disagreement between the Magdalo and Magdiwang councils. Bonifacio was later arrested and executed in May 1897.');
  slide('Summary', ['The Katipunan was founded in 1892 to win independence from Spain.', 'The Cry of Pugad Lawin in 1896 began the revolution.', 'The Tejeros Convention in 1897 created a revolutionary government.']);
  write('history-katipunan.pptx', await pptx.write({ outputType: 'nodebuffer' }));
}

// ---------- 5. literature-poem.docx ----------
async function makeLiterature() {
  const poem = [
    'Two roads diverged in a yellow wood,',
    'And sorry I could not travel both',
    'And be one traveler, long I stood',
    'And looked down one as far as I could',
    'To where it bent in the undergrowth;',
    '',
    'Then took the other, as just as fair,',
    'And having perhaps the better claim,',
    'Because it was grassy and wanted wear;',
    'Though as for that the passing there',
    'Had worn them really about the same,',
    '',
    'And both that morning equally lay',
    'In leaves no step had trodden black.',
    'Oh, I kept the first for another day!',
    'Yet knowing how way leads on to way,',
    'I doubted if I should ever come back.',
    '',
    'I shall be telling this with a sigh',
    'Somewhere ages and ages hence:',
    'Two roads diverged in a wood, and I—',
    'I took the one less traveled by,',
    'And that has made all the difference.',
  ];
  const doc = new Document({
    sections: [
      {
        children: [
          heading('The Road Not Taken'),
          para('by Robert Frost (1916)'),
          ...poem.map((text) => para(text)),
          heading('Literary devices'),
          para('Imagery is language that appeals to the senses, helping the reader to see, hear, touch, taste or smell what is described.'),
          para('A metaphor is a figure of speech that describes one thing as if it were another, without using the words like or as.'),
          para('Symbolism is the use of an object, person or place to stand for a larger idea.'),
          para('Tone is the attitude of the writer toward the subject, shown through the choice of words.'),
          heading('Analysis'),
          para('The poem uses the imagery of a yellow wood and a grassy path to put the reader in an autumn forest. The two roads are a metaphor for the choices a person makes in life. The fork in the road is a symbol of a decision that cannot be undone.'),
          para('The tone is thoughtful and a little wistful. The speaker says that he will be telling the story with a sigh, which suggests that he is not sure the choice was as clear as he makes it sound.'),
        ],
      },
    ],
  });
  write('literature-poem.docx', await Packer.toBuffer(doc));
}

await makeMath();
await makePhysics();
await makeChemistry();
await makeHistory();
await makeLiterature();
