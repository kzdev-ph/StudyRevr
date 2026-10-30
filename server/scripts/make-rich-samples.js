// Makes four richer sample lessons (physics, chemistry, history, math) in test-lessons/subjects/rich/ (git-ignored).
// Every key idea is a self-contained sentence ("X is ... because ..."), and each lesson has 8+ distinct concepts, so the
// Mock Quiz can find three plausible wrong options for its multiple-choice questions. Run it from anywhere:
//
//   node server/scripts/make-rich-samples.js
//
// Then run each file, e.g.  npm run pipeline -- test-lessons/subjects/rich/physics-forces.pptx --show-text --save=test-lessons/subjects/rich-out/physics-forces.db
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, Math as OfficeMath, MathFraction, MathRadical, MathRun, MathSuperScript, Packer, Paragraph, TextRun } from 'docx';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test-lessons', 'subjects', 'rich');
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
const bullet = (text) => para(text, { numbering: { reference: 'bullets', level: 0 } });
const numbered = (text) => para(text, { numbering: { reference: 'steps', level: 0 } });
const numbering = {
  config: [
    { reference: 'steps', levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: 'left' }] },
    { reference: 'bullets', levels: [{ level: 0, format: 'bullet', text: '•', alignment: 'left' }] },
  ],
};

// ---------- 1. physics-forces.pptx ----------
const KE_OMML = [
  '<m:r><m:t>KE=</m:t></m:r>',
  '<m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f>',
  '<m:r><m:t>m</m:t></m:r>',
  '<m:sSup><m:e><m:r><m:t>v</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup>',
].join('');
const ALTERNATE_CONTENT =
  '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" Requires="a14">' +
  `<a14:m><m:oMathPara xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:oMath>${KE_OMML}</m:oMath></m:oMathPara></a14:m>` +
  '</mc:Choice><mc:Fallback/></mc:AlternateContent>';

function slideMaker(pptx) {
  return (title, lines, notes) => {
    const s = pptx.addSlide();
    s.addText(title, { x: 0.5, y: 0.3, w: 9, h: 0.8, fontSize: 28, bold: true });
    if (lines.length) s.addText(lines.map((text) => ({ text, options: { breakLine: true } })), { x: 0.5, y: 1.3, w: 9, h: 3.8, fontSize: 18 });
    if (notes) s.addNotes(notes);
    return s;
  };
}

async function makePhysics() {
  const pptx = new PptxGenJS();
  const slide = slideMaker(pptx);
  slide('Forces and Motion', [
    'A force is a push or a pull on an object, and it is measured in newtons (N).',
    'Forces explain why objects speed up, slow down, change direction or stay still.',
  ], 'Sir Isaac Newton described three laws of motion in 1687, and they are still used today to design cars, bridges and rockets.');
  slide("Newton's First Law", [
    "Newton's first law says that an object stays at rest or keeps moving at a constant velocity unless a net force acts on it.",
    'Inertia is the tendency of an object to resist any change in its motion.',
  ], 'Inertia is why passengers lurch forward when a jeepney brakes suddenly: their bodies keep moving forward while the vehicle slows down. A heavier object has more inertia because it needs a bigger force to change its motion.');
  slide('Net Force', [
    'The net force is the total of all the forces on an object, taking their directions into account.',
    'Balanced forces give a net force of zero, so the motion of the object does not change.',
    'Unbalanced forces give a net force that is not zero, so the object accelerates.',
  ], 'In a tug of war, two teams pull with equal forces in opposite directions. The rope does not move because the net force on it is zero.');
  slide("Newton's Second Law", [
    "Newton's second law says that the acceleration of an object is directly proportional to the net force on it and inversely proportional to its mass.",
    'F = ma',
  ], 'In words, the net force equals the mass times the acceleration. An empty shopping cart speeds up quickly with a gentle push, but a full cart needs a much bigger push for the same acceleration because its mass is larger.');
  slide('Units of Force, Mass and Acceleration', [
    'Mass is the amount of matter in an object, and it is measured in kilograms (kg).',
    'Acceleration is the rate at which velocity changes, and it is measured in metres per second squared (m/s²).',
    'One newton is the force that gives a mass of 1 kg an acceleration of 1 m/s².',
  ]);
  slide("Newton's Third Law", [
    "Newton's third law says that when one object pushes on a second object, the second object pushes back on the first with an equal force in the opposite direction.",
  ], 'When a swimmer pushes the wall with her feet, the wall pushes her forward. The two forces act on different objects, which is why they do not cancel each other out.');
  slide('Weight and Mass', [
    'Weight is the force of gravity on an object, so it is measured in newtons, while mass is measured in kilograms.',
    'Weight is found with W = mg, where g is the acceleration due to gravity.',
    'On Earth g is about 9.8 m/s², so a student of mass 60 kg has a weight of 60 kg × 9.8 m/s² = 588 N.',
  ], 'Mass does not change from place to place, but weight does, because g is different on the Moon (about 1.6 m/s²). The same 60 kg student weighs only 96 N on the Moon.');
  const ke = slide('Kinetic Energy', ['Kinetic energy is the energy an object has because it is moving, and it is measured in joules (J).']);
  ke.addText('EQ_PLACEHOLDER', { x: 0.5, y: 2.6, w: 9, h: 1, fontSize: 24 });
  ke.addNotes('Kinetic energy equals one half times the mass times the speed squared. Doubling the speed makes the kinetic energy four times as large because the speed is squared. A 2 kg ball moving at 3 m/s has a kinetic energy of 9 J.');
  slide('Friction', [
    'Friction is a force that opposes the motion of two surfaces that slide, or try to slide, over each other.',
    'Friction acts in the direction opposite to the motion, so it slows moving objects down.',
    'Friction exists because surfaces are rough at a tiny scale, which is why ice is slippery and sandpaper is not.',
  ], 'Friction changes kinetic energy into heat, which is why rubbing your hands together warms them.');
  slide('Worked Example', [
    'A box has a mass of 5 kg and accelerates at 2 m/s². Find the net force on it.',
    'Step 1: Write what is given. m = 5 kg and a = 2 m/s².',
    "Step 2: Choose Newton's second law, F = ma.",
    'Step 3: Substitute the values. F = 5 kg × 2 m/s².',
    'Step 4: Calculate. F = 10 N.',
  ], 'The answer is in newtons because 1 N = 1 kg·m/s². The net force on the box is 10 N.');

  const zip = await JSZip.loadAsync(await pptx.write({ outputType: 'nodebuffer' }));
  const file = 'ppt/slides/slide8.xml';
  const xml = await zip.file(file).async('string');
  const at = xml.indexOf('EQ_PLACEHOLDER');
  const start = xml.lastIndexOf('<a:r>', at);
  const end = xml.indexOf('</a:r>', at) + '</a:r>'.length;
  if (at < 0 || start < 0) throw new Error(`EQ_PLACEHOLDER run not found in ${file}`);
  zip.file(file, xml.slice(0, start) + ALTERNATE_CONTENT + xml.slice(end));
  write('physics-forces.pptx', await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

// ---------- 2. chemistry-mole.docx ----------
async function makeChemistry() {
  const doc = new Document({
    numbering,
    sections: [
      {
        children: [
          heading('Atoms, Molecules and the Mole'),
          para('An atom is the smallest unit of an element that still has the chemical properties of that element. A molecule is a group of two or more atoms joined by chemical bonds. A water molecule has two hydrogen atoms and one oxygen atom, which is why its formula is H2O.'),
          heading('Kinds of matter'),
          bullet('An element is a pure substance made of only one kind of atom, so it cannot be broken down into simpler substances by chemical means. Oxygen and iron are elements.'),
          bullet('A compound is a pure substance made of two or more elements joined chemically in a fixed ratio. Water is a compound because it always has two hydrogen atoms for every oxygen atom.'),
          bullet('A mixture is made of two or more substances that are only physically combined, so each substance keeps its own properties. Air is a mixture of nitrogen, oxygen and other gases.'),
          bullet('A solution is a mixture that is the same throughout because one substance, the solute, is completely dissolved in another, the solvent. Salt water is a solution with salt as the solute and water as the solvent.'),
          heading('The mole'),
          para('A mole is the amount of a substance that contains 6.022 × 10²³ particles. Chemists use the mole because atoms are so small that even a tiny speck of matter holds an enormous number of them, so counting them one by one is impossible.'),
          para('Avogadro\'s number is 6.022 × 10²³, and it is the number of particles in one mole of any substance, whether the particles are atoms, molecules or ions. It is the same for every substance because the mole is defined by a number of particles.'),
          equation(run('N=6.022×'), sup('10', '23'), run(' particles per mole')),
          heading('Molar mass'),
          para('The molar mass of a substance is the mass of one mole of it, measured in grams per mole (g/mol). The molar mass of an element in g/mol is numerically equal to its atomic mass. The atomic mass of hydrogen is 1.008, of carbon is 12.01 and of oxygen is 16.00.'),
          para('To find the molar mass of a compound, add up the atomic masses of all the atoms in its formula.'),
          para('The molar mass of water, H2O, is 2 × 1.008 + 16.00 = 18.02 g/mol, because a water molecule has two hydrogen atoms and one oxygen atom.'),
          para('The molar mass of carbon dioxide, CO2, is 12.01 + 2 × 16.00 = 44.01 g/mol, because a carbon dioxide molecule has one carbon atom and two oxygen atoms.'),
          heading('Worked example'),
          para('How many moles are in 36.04 g of water, and how many molecules is that?'),
          numbered('The molar mass of water is 18.02 g/mol.'),
          numbered('The number of moles is the mass divided by the molar mass: 36.04 g ÷ 18.02 g/mol = 2.000 mol.'),
          numbered('The number of molecules is the moles times Avogadro\'s number: 2.000 mol × 6.022 × 10²³ per mole = 1.204 × 10²⁴ molecules.'),
          heading('Remember'),
          bullet('One mole of any substance contains 6.022 × 10²³ particles, because the mole is defined by a number of particles and not by a mass.'),
          bullet('The number of moles is the mass in grams divided by the molar mass in g/mol, because the molar mass is the mass of one mole.'),
          bullet('Every chemistry answer must include its unit, such as mol or g/mol, because a number without a unit has no meaning.'),
        ],
      },
    ],
  });
  write('chemistry-mole.docx', await Packer.toBuffer(doc));
}

// ---------- 3. history-revolution.pptx ----------
async function makeHistory() {
  const pptx = new PptxGenJS();
  const slide = slideMaker(pptx);
  slide('The Philippine Revolution', [
    'The Philippine Revolution was the armed struggle of Filipinos against Spanish colonial rule, and it began in August 1896.',
    'It happened because years of peaceful requests for reform had not ended the abuses of the colonial government.',
  ]);
  slide('Causes of the Revolution', [
    'Abuses by the friars and the colonial government angered Filipinos because the friars held great power over land, schools and parishes.',
    'Filipinos were treated unequally under Spanish law, because Spaniards received better positions and better treatment.',
    'Heavy taxes and forced labor burdened ordinary families.',
    'The execution of the priests Gomburza on February 17, 1872 shocked many Filipinos and made them demand change.',
  ], 'Gomburza stands for the three priests Mariano Gomez, Jose Burgos and Jacinto Zamora. They were accused of taking part in a mutiny in Cavite, and many Filipinos believed that they were innocent.');
  slide('The Propaganda Movement', [
    'The Propaganda Movement was a campaign by educated Filipinos in Spain who asked for peaceful reforms, not independence.',
    'Its leaders were Jose Rizal, Marcelo H. del Pilar and Graciano Lopez Jaena.',
    'La Solidaridad was the newspaper of the movement, and it printed articles that exposed the abuses in the Philippines.',
    'The movement failed to win reforms, which convinced many Filipinos that only a revolution could bring change.',
  ], 'Rizal wrote the novels Noli Me Tangere in 1887 and El Filibusterismo in 1891 to show the injustices of Spanish rule.');
  slide('The Katipunan', [
    'The Katipunan was a secret society founded in Tondo, Manila, on July 7, 1892 by Andres Bonifacio and his companions.',
    'Its goal was independence from Spain through an armed revolution, and it also taught unity among Filipinos.',
    'A Katipunero was a member of the Katipunan.',
    'Kalayaan was the newspaper of the Katipunan.',
  ], 'The full name of the society was Kataastaasang Kagalanggalangang Katipunan ng mga Anak ng Bayan. It spread quickly through Manila and nearby provinces in the years after 1892.');
  slide('Key People', [
    'Andres Bonifacio was the Supremo, or supreme leader, of the Katipunan, because he founded it and guided its members.',
    'Emilio Jacinto was called the Brains of the Katipunan, because he wrote its Kartilya, the code of conduct for its members.',
    'Gregoria de Jesus was the Lakambini, or muse, of the Katipunan, because she kept its records and documents safe.',
    'Emilio Aguinaldo was a leader from Cavite who later became the head of the revolutionary government.',
  ]);
  slide('Discovery and the Cry of Pugad Lawin', [
    'In August 1896 the Spanish authorities discovered the Katipunan, because Teodoro Patino told a friar about the secret society.',
    'The Cry of Pugad Lawin was the event in which Katipuneros tore up their cedulas as a sign of defiance, and it began the revolution.',
    'A cedula was a personal tax certificate that every adult Filipino had to carry, so tearing it meant rejecting Spanish rule.',
  ], 'On December 30, 1896 the Spanish authorities executed Jose Rizal, who was not a member of the Katipunan. His death made him a martyr and made many more Filipinos join the revolution.');
  slide('The Tejeros Convention', [
    'The Tejeros Convention was a meeting held on March 22, 1897 in Tejeros, Cavite, to choose a revolutionary government.',
    'Emilio Aguinaldo was elected president, and Bonifacio was given a lower post, which he refused to accept.',
    'The dispute led to the arrest of Bonifacio, who was executed in May 1897 by the order of the Aguinaldo government.',
  ]);
  slide('Effects of the Revolution', [
    'The Pact of Biak-na-Bato was an agreement in December 1897 that paused the fighting, and Aguinaldo went into exile in Hong Kong.',
    'Independence was proclaimed on June 12, 1898 in Kawit, Cavite, after the war between Spain and the United States began.',
    'In the Treaty of Paris of December 1898, Spain gave up the Philippines to the United States, and this led to a new war against American rule.',
  ]);
  write('history-revolution.pptx', await pptx.write({ outputType: 'nodebuffer' }));
}

// ---------- 4. math-quadratics.docx ----------
async function makeMath() {
  const doc = new Document({
    numbering,
    sections: [
      {
        children: [
          heading('Quadratic Equations'),
          para('A quadratic equation is an equation that can be written in the standard form below, where a, b and c are real numbers and a is not zero. It is called quadratic because the highest power of the unknown x is 2.'),
          equation(run('a'), sup('x', '2'), run('+bx+c=0')),
          para('The roots of a quadratic equation are the values of x that make the equation true. A quadratic equation has at most two roots, which are also called its solutions or zeros.'),
          para('The graph of a quadratic equation is a parabola, a U-shaped curve, and the roots are the points where the parabola crosses the x-axis.'),
          heading('Method 1: Factoring'),
          para('Factoring is the fastest way to solve a quadratic equation when the numbers are small, because it turns one equation into two simple ones.'),
          numbered('To solve by factoring, first move every term to the left side so that the right side is zero.'),
          numbered('Second, factor the left side into two brackets.'),
          numbered('Third, set each bracket equal to zero, because a product is zero only when one of its factors is zero.'),
          numbered('Fourth, solve the two small equations to find the roots.'),
          para('Example 1: Solve the equation below. The numbers 3 and 4 multiply to 12 and add to 7, so the left side factors into two brackets.'),
          equation(sup('x', '2'), run('+7x+12=0')),
          equation(run('(x+3)(x+4)=0')),
          para('Setting each bracket to zero gives x = −3 or x = −4, so the roots of this equation are −3 and −4. Checking x = −3 gives 9 − 21 + 12 = 0, which is correct.'),
          heading('Method 2: The quadratic formula'),
          para('The quadratic formula gives the roots of any quadratic equation in standard form, even when the equation cannot be factored easily.'),
          equation(
            run('x='),
            new MathFraction({
              numerator: [run('−b±'), new MathRadical({ children: [sup('b', '2'), run('−4ac')] })],
              denominator: [run('2a')],
            }),
          ),
          para('Example 2: Solve 2x² − 3x − 2 = 0. Here a = 2, b = −3 and c = −2. Then b² − 4ac = 9 + 16 = 25, and the square root of 25 is 5. So x = (3 ± 5) ÷ 4, which gives x = 2 or x = −1/2. The roots of this equation are therefore 2 and −1/2.'),
          heading('The discriminant'),
          para('The discriminant is the expression under the square root sign in the quadratic formula. It is written D, and it tells us how many real roots the equation has without solving it.'),
          equation(run('D='), sup('b', '2'), run('−4ac')),
          bullet('If D is positive, there are two different real roots, because the square root of a positive number is real and the ± sign gives two different results.'),
          bullet('If D is zero, there is one repeated root, because adding or subtracting zero gives the same value.'),
          bullet('If D is negative, there are no real roots, because a negative number has no real square root.'),
          para('For example, the discriminant of x² + 2x + 5 = 0 is D = 4 − 20 = −16, so this equation has no real roots because D is negative.'),
          heading('Sum and product of roots'),
          para('For a quadratic equation in standard form, the sum of the roots is −b/a and the product of the roots is c/a. In Example 1 the roots are −3 and −4, whose sum is −7 and whose product is 12, which match −b/a and c/a.'),
        ],
      },
    ],
  });
  write('math-quadratics.docx', await Packer.toBuffer(doc));
}

await makePhysics();
await makeChemistry();
await makeHistory();
await makeMath();
