import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chunkLesson } from '../src/ai/chunk.js';
import { distractorsPrompt, MATH_OPTIONS } from '../src/ai/prompts.js';
import { checkEvidence, comparable } from '../src/pipeline/evidence.js';
import { generateConceptCards, listItems } from '../src/pipeline/flashcards.js';
import { answerInQuestion, falseStatementProblems, wrongOptionProblems } from '../src/quiz/leaks.js';
import { isFormulaLike, isFormulaOrQuantity, looksMathy, mathText } from '../src/services/math-text.js';

// Regressions the math support caused for lessons that are not about math (history, Filipino, coding, plain text):
// such text must behave exactly as before, and math handling must start only on real formula evidence.

const rules = (problems) => problems.map((p) => p.rule);

describe('1. the number check on concept cards leaves dates and counts alone', () => {
  const ask = async (lesson, answer, evidence) => {
    const drops = [];
    const ai = { async generateJSON({ schema }) { return schema.parse({ cards: [{ question: 'What is asked here?', answer, evidence }] }); } };
    const kept = await generateConceptCards({ ai, chunks: chunkLesson(lesson), target: 4, onDrop: (d) => drops.push(d) });
    return { kept, drops };
  };

  it('keeps a year taken from a full date', async () => {
    const quote = 'Independence was declared on June 12, 1898 in Kawit.';
    const { kept, drops } = await ask(`Philippine History\n${quote}`, '1898', 'Independence was declared on June 12, 1898');
    assert.equal(kept.length, 1);
    assert.deepEqual(drops, []);
  });

  it('keeps 1861 from "June 19, 1861", and 12 from a list of ages and counts', async () => {
    assert.equal((await ask('Rizal was born on June 19, 1861 in Calamba.', '1861', 'Rizal was born on June 19, 1861')).kept.length, 1);
    const ages = 'The survey took ages 12 to 15, 100 students from Manila.';
    assert.equal((await ask(ages, '12', 'ages 12 to 15, 100 students')).kept.length, 1);
    assert.equal((await ask(ages, '3 types', 'ages 12 to 15, 100 students')).kept.length, 1);
  });

  it('still drops an invented result on a math card', async () => {
    const lesson = 'Newton\'s Second Law\nF = ma = 10 N when m = 10 kg and a = 1 m/s².';
    const { kept, drops } = await ask(lesson, '12 N', 'F = ma = 10 N');
    assert.deepEqual(kept, []);
    assert.deepEqual(drops.map((d) => d.reason), ['a number in the answer is not in its quote']);
    assert.equal((await ask(lesson, '10.0 N', 'F = ma = 10 N')).kept.length, 1);
  });

  it('reads ½ and 1/2 as the same fraction', async () => {
    const lesson = 'Kinetic energy\nKE = ½mv² for a moving body.';
    assert.equal((await ask(lesson, 'KE = (1/2)mv²', 'KE = ½mv²')).kept.length, 1);
  });
});

describe('1b. a lone number in the question is a leak outside math', () => {
  it('flags a year the question already holds, as before', () => {
    assert.equal(answerInQuestion('Was 1898 the year independence was declared?', 'It was in 1898'), 'the question holds the answer word "1898"');
  });

  it('does not flag a worked result in a math question', () => {
    assert.equal(answerInQuestion('If m = 10 kg and a = 1 m/s², what is F?', '10 N'), null);
  });
});

describe('2. differentMath needs two formulas, not two digits', () => {
  const rejected = (wrong, correct) => rules(wrongOptionProblems(wrong, correct)).includes('f');

  it('still rejects reworded copies that only share a digit', () => {
    assert.ok(rejected('Phase 2 of mitosis', 'Mitosis phase 2'));
    assert.ok(rejected('In 1898', '1898'));
    assert.ok(rejected('The 1987 Constitution was ratified', 'The Constitution was ratified in 1987'));
    assert.ok(rejected('10 N force', '10 N'));
    assert.ok(rejected('Constitution Article 5 of the', 'Article 5 of the Constitution'));
  });

  it('the reworded-statement rule (e) also still applies to those', () => {
    assert.ok(rules(falseStatementProblems('In 1898', '1898')).includes('e'));
  });

  it('does not call two different formulas reworded', () => {
    const right = 'x=(−b±√(b²−4ac))/2a';
    for (const wrong of ['x=(b±√(b²+4ac))/2a', 'x=(−b±√(b²−4ac))/4a']) {
      assert.ok(!rules(wrongOptionProblems(wrong, right)).includes('f'), wrong);
    }
  });

  it('isFormulaLike: an operator or symbol counts, a digit alone does not', () => {
    for (const t of ['F = ma', 'x² − 5x + 6 = 0', 'A = πr²', '(1/2)mv²', '3 + 4', 'H₂O', '2 - 3']) assert.equal(isFormulaLike(t), true, t);
    for (const t of ['1998', 'Section 5', 'Phase 2 of mitosis', '10 N', 'K-12', '1898-1901', 'Plan → Do', 'Grade 10']) assert.equal(isFormulaLike(t), false, t);
    assert.equal(isFormulaLike('2H₂ + O₂ → 2H₂O'), true);
  });
});

describe('3 and 8. mathText leaves prices, code and paths alone', () => {
  const same = [
    'Tickets cost $5 for kids {under 12} and $10 for adults.',
    'Costs $5 for user_name and $10',
    '`Hello ${name}, you are ${age}`',
    'console.log(`Hello ${name}, you are ${age}`);',
    'cheap ($$) and fancy ($$$)',
    'Para one costs $$ to run.\n\nPara two costs $$ too.',
    'Use \\[ and later \\] in a regex',
    'regex \\d+ \\[abc\\] and \\(group\\)',
    'Folder C:\\Users\\Delta\\log.txt',
    'D:\\sum\\text',
    'Path C:\\new\\to\\left\\right',
    'C:\\Users\\alpha\\times\\pi',
    'Open \\\\server\\share\\int',
    'cost\\to be',
    'Use $HOME/x_y and $PATH_{1}',
    'file_{1}.txt and my_var_{x}',
  ];
  for (const text of same) {
    it(`unchanged: ${JSON.stringify(text)}`, () => assert.equal(mathText(text), text));
  }

  it('still converts real math', () => {
    assert.equal(mathText('$x^{2}$'), 'x²');
    assert.equal(mathText('$$\\frac{1}{2}mv^2$$'), '(1/2)mv²');
    assert.equal(mathText('\\(a_1+b\\)'), 'a₁+b');
    assert.equal(mathText('Costs $5 and then $x_1$ and $\\alpha$.'), 'Costs $5 and then x₁ and α.');
    assert.equal(mathText('$$\n\\frac{a}{b}\n$$'), 'a/b');
    assert.equal(mathText('Use \\frac{1}{2} and x \\times y'), 'Use 1/2 and x × y');
    assert.equal(mathText('\\[ \\sum_{i=1}^{n} i \\]'), '∑(i=1 to n) i');
  });
});

describe('4. the wrong-answer prompt changes only for math answers', () => {
  const prompt = (answer) => distractorsPrompt({ cards: [{ n: 1, question: 'Q?', answer, evidence: 'e' }] });

  it('is byte-identical to the one before the math support for a plain lesson (answer "1998")', () => {
    const md5 = (v) => createHash('md5').update(JSON.stringify(v)).digest('hex');
    assert.equal(md5(prompt('1998')), 'eaf33c911153c5d6c9b4dd5fe203a946'); // md5 of the prompt at HEAD (before the math work)
    assert.ok(!prompt('Builds confidence').system.includes('Math:'));
  });

  it('adds the math rules for a formula or a quantity', () => {
    for (const a of ['10 N', 'F = ma', 'x² − 5x + 6 = 0', '3.5 m/s']) {
      assert.ok(prompt(a).system.includes(MATH_OPTIONS), a);
    }
  });

  it('isFormulaOrQuantity', () => {
    assert.equal(isFormulaOrQuantity('1998'), false);
    assert.equal(isFormulaOrQuantity('10 N'), true);
    assert.equal(isFormulaOrQuantity('F = ma'), true);
  });
});

describe('5. looksMathy needs real math', () => {
  it('is false for a flow chart, comparisons and code', () => {
    assert.equal(looksMathy('Plan → Do\nDo → Check\nCheck → Act\nAct → Plan'), false);
    assert.equal(looksMathy('grade = 75\nscore < 75'), false);
    assert.equal(looksMathy('let x = 5;\nlet y = 6;\nlet z = x + y;'), false);
    assert.equal(looksMathy('Passing: grade = 75 or higher\nHonors: grade = 90\nFail: score < 75'), false);
  });

  it('is true for formulas', () => {
    assert.equal(looksMathy('Quadratic Equations\nax² + bx + c = 0\nx = (−b ± √(b² − 4ac)) / 2a\nD = b² − 4ac\nSolve x² − 5x + 6 = 0'), true);
    assert.equal(looksMathy('F = ma\nA = πr²\nKE=(1/2)mv²'), true);
    assert.equal(looksMathy('Solve x² − 5x + 6 = 0\n(x − 2)(x − 3) = 0\nx = 2 or x = 3'), true);
    assert.equal(looksMathy('A = πr²'), true);
    assert.equal(looksMathy('KE=(1/2)mv²\nPE = mgh\nv = 12 m/s'), true);
    assert.equal(looksMathy('F = ma\nv = d/t\na = F/m'), true);
    assert.equal(looksMathy('Use 10 N, 5 kg and 3 m/s'), true);
  });
});

describe('6. listItems skips only pure equation lines', () => {
  it('keeps short names, codes and ordinals', () => {
    const kept = ['Igneous', 'DNA', 'ATP', 'CO2', 'H2O', '4Ps', 'K-12', '3Rs', 'RA 9003', 'pH', 'Mn', '2nd', '5Ws and 1H'];
    assert.deepEqual(listItems(kept.map((t) => `- ${t}`).join('\n')), kept);
  });

  it('skips formulas and values', () => {
    assert.deepEqual(listItems('- x = 2\n- F = ma\n- 3.5 m/s\n- Igneous'), ['Igneous']);
  });
});

describe('7. evidence: a title with an arrow is not a formula', () => {
  const key = comparable('Photosynthesis → Respiration\nF = ma\nA = πr²\n2H₂ + O₂ → 2H₂O\nOther text here about cells.');
  const ok = (term, evidence) => checkEvidence({ term, evidence, sourceKey: key, minExplaining: 3 });

  it('rejects the arrow title as it did before', () => {
    assert.deepEqual(ok('Photosynthesis', 'Photosynthesis → Respiration'), { ok: false, reason: 'evidence is only the term or a title' });
  });

  it('a relation needs a letter or digit on both sides, so a stray sign is no formula', () => {
    const k = comparable('Title = \n= Heading');
    assert.equal(checkEvidence({ term: 'Title', evidence: 'Title =', sourceKey: k, minExplaining: 3 }).ok, false);
  });

  it('still accepts formulas and reactions', () => {
    assert.equal(ok('Force', 'F = ma').ok, true);
    assert.equal(ok('Circle area', 'A = πr²').ok, true);
    assert.equal(ok('Water', '2H₂ + O₂ → 2H₂O').ok, true);
  });
});
