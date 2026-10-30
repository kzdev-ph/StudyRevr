import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isMathAnswer, latexToText, looksMathy, mathKey, mathText, mathTextDeep, sameValue } from '../src/services/math-text.js';

const check = (cases) => {
  for (const [input, expected] of cases) assert.equal(latexToText(input), expected, input);
};

describe('latexToText', () => {
  it('converts the exact strings from the plan', () => {
    check([
      ['x=\\frac{-b\\pm\\sqrt{b^{2}-4ac}}{2a}', 'x=(-b±√(b²-4ac))/2a'],
      ['KE=\\frac{1}{2}mv^{2}', 'KE=(1/2)mv²'],
      ['F=ma', 'F=ma'],
    ]);
  });

  it('unescapes what officeparser escapes', () => {
    check([
      ['50\\% of \\$5 \\# a\\_b \\{x\\} \\&', '50% of $5 # a_b {x} &'],
      ['a\\textbackslash{}b', 'a\\b'],
      ['a\\textasciitilde{}b', 'a~b'],
      ['a\\textasciicircum{}b', 'a^b'],
    ]);
  });

  it('writes fractions as a/b or (a)/(b)', () => {
    check([
      ['\\frac{a}{b}', 'a/b'],
      ['\\dfrac{1}{2}', '1/2'],
      ['\\tfrac{x}{y}', 'x/y'],
      ['\\frac{a+b}{c}', '(a+b)/c'],
      ['\\frac{a+b}{c-d}', '(a+b)/(c-d)'],
      ['\\frac{(a+b)}{2}', '(a+b)/2'],
      ['\\frac{1}{2}\\sqrt{x}', '(1/2)√x'],
      ['\\frac{1}{2}(x)', '(1/2)(x)'],
      ['\\frac{1}{2}\\pi', '(1/2)π'],
      ['\\frac{1}{2}=x', '1/2=x'],
    ]);
  });

  it('uses superscript characters when every character has one', () => {
    check([
      ['x^{2}', 'x²'],
      ['x^2', 'x²'],
      ['x^{n+1}', 'xⁿ⁺¹'],
      ['10^{-3}', '10⁻³'],
      ['e^{-x}', 'e⁻ˣ'],
      ['x^{q}', 'x^(q)'],
      ['x^{\\alpha}', 'x^(α)'],
      ['30^{\\circ}', '30°'],
    ]);
  });

  it('uses subscript characters when every character has one', () => {
    check([
      ['v_{0}', 'v₀'],
      ['H_2O', 'H₂O'],
      ['a_{ij}', 'aᵢⱼ'],
      ['x_{b}', 'x_(b)'],
      ['\\log_{10}x', 'log₁₀x'],
    ]);
  });

  it('converts roots', () => {
    check([
      ['\\sqrt{x}', '√x'],
      ['\\sqrt{2}', '√2'],
      ['\\sqrt{x+1}', '√(x+1)'],
      ['\\sqrt[3]{8}', '³√(8)'],
      ['\\sqrt[n]{x}', 'ⁿ√(x)'],
    ]);
  });

  it('converts Greek letters', () => {
    check([
      ['\\alpha+\\beta', 'α+β'],
      ['\\varepsilon', 'ε'],
      ['\\theta', 'θ'],
      ['\\Omega', 'Ω'],
      ['\\Delta t', 'Δ t'],
      ['\\varphi', 'φ'],
    ]);
  });

  it('converts symbols', () => {
    check([
      ['a\\times b\\div c\\cdot d\\pm e\\mp f', 'a×b÷c·d±e∓f'],
      ['a\\le b\\leq c\\ge d\\geq e\\ne f\\neq g\\approx h\\equiv i\\propto j', 'a≤b≤c≥d≥e≠f≠g≈h≡i∝j'],
      ['\\infty', '∞'],
      ['A\\to B\\rightarrow C\\leftarrow D\\Rightarrow E\\leftrightarrow F\\rightleftharpoons G', 'A→B→C←D⇒E↔F⇌G'],
      ['\\angle ABC \\perp DE \\parallel FG', '∠ ABC⊥DE∥FG'],
      ['\\triangle', '△'],
      ['\\partial f', '∂ f'],
      ['\\nabla g', '∇ g'],
      ['x\\in A', 'x∈A'],
      ['x\\notin A', 'x∉A'],
      ['A\\subset B\\subseteq C', 'A⊂B⊆C'],
      ['A\\cup B\\cap C', 'A∪B∩C'],
      ['\\emptyset', '∅'],
      ['\\forall x', '∀ x'],
      ['\\exists y', '∃ y'],
      ['a_1,\\ldots,a_n', 'a₁,…,aₙ'],
      ['1+\\cdots+n', '1+…+n'],
      ['a\\dots b', 'a… b'],
      ['f^{\\prime}', 'f′'],
      ['\\circ', '°'],
    ]);
  });

  it('turns function names into the plain word', () => {
    check([
      ['\\sin x', 'sin x'],
      ['\\sin^{2}\\theta', 'sin²θ'],
      ['\\cos x + \\tan y', 'cos x + tan y'],
      ['\\ln x', 'ln x'],
      ['\\exp(x)', 'exp(x)'],
      ['\\max(a,b)', 'max(a,b)'],
      ['\\min(a,b)', 'min(a,b)'],
      ['\\log x', 'log x'],
    ]);
  });

  it('writes limits on operators', () => {
    check([
      ['\\lim_{x\\to a} f(x)', 'lim(x→a) f(x)'],
      ['\\sum_{i=1}^{n} i', '∑(i=1 to n) i'],
      ['\\int_{a}^{b} f\\,dx', '∫(a to b) f dx'],
      ['\\sum_{i=1}^{n}', '∑(i=1 to n)'],
    ]);
  });

  it('drops \\left and \\right but keeps the delimiter', () => {
    check([
      ['\\left(\\frac{a}{b}\\right)^{2}', '(a/b)²'],
      ['\\left[x\\right]', '[x]'],
      ['\\left\\{x\\right\\}', '{x}'],
      ['\\left.x\\right|', 'x|'],
    ]);
  });

  it('replaces text wrappers with their content', () => {
    check([
      ['\\text{m/s}', 'm/s'],
      ['\\mathrm{kg}', 'kg'],
      ['\\mathbf{F}=m\\mathbf{a}', 'F=ma'],
      ['\\mathit{v}', 'v'],
      ['\\operatorname{rank}', 'rank'],
    ]);
  });

  it('adds accents', () => {
    check([
      ['\\bar{x}', 'x\u0304'],
      ['\\bar x', 'x\u0304'],
      ['\\overline{x}', 'x\u0304'],
      ['\\overline{AB}', '‾(AB)'],
      ['\\hat{i}', 'i\u0302'],
      ['\\vec{F}', 'F\u20D7'],
      ['\\dot{x}', 'x\u0307'],
    ]);
  });

  it('handles spacing commands', () => {
    check([
      ['a\\,b', 'a b'],
      ['a\\;b', 'a b'],
      ['a\\:b', 'a b'],
      ['a\\!b', 'ab'],
      ['a\\quad b', 'a b'],
      ['a\\qquad b', 'a b'],
      ['a~b', 'a b'],
    ]);
  });

  it('converts matrices and row breaks', () => {
    check([
      ['\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}', '[a, b; c, d]'],
      ['\\begin{bmatrix} 1 & 0 \\\\ 0 & 1 \\end{bmatrix}', '[1, 0; 0, 1]'],
      ['a\\\\b', 'a; b'],
    ]);
  });

  it('keeps the name of unknown commands and removes leftover braces', () => {
    check([
      ['a\\foo b', 'afoo b'],
      ['\\foo', 'foo'],
      ['{a}{b}', 'ab'],
      ['{{x}}', 'x'],
      ['a   b', 'a b'],
      ['a+b-c', 'a+b-c'],
    ]);
  });
});

describe('mathText', () => {
  it('converts clear LaTeX', () => {
    assert.equal(mathText('$x^{2}$'), 'x²');
    assert.equal(mathText('$$x^{2}+y^{2}$$'), 'x²+y²');
    assert.equal(mathText('\\(x^{2}\\)'), 'x²');
    assert.equal(mathText('\\[\\frac{a}{b}\\]'), 'a/b');
    assert.equal(mathText('So $a_{1}$ is first.'), 'So a₁ is first.');
    assert.equal(mathText('The area is \\frac{1}{2}bh.'), 'The area is (1/2)bh.');
    assert.equal(mathText('speed v^{2} here'), 'speed v² here');
    assert.equal(mathText('an \\alpha particle'), 'an α particle');
  });

  it('leaves ordinary text identical', () => {
    for (const text of ['F=ma', 'It costs $5 and $10.', 'x^2 plain', 'file_name here', 'a $b\nc$ d', '$x$', '\\unknown cmd', '']) {
      assert.equal(mathText(text), text);
    }
    assert.equal(mathText(null), null);
    assert.equal(mathText(5), 5);
  });

  it('still converts a real $..$ after a dollar amount', () => {
    assert.equal(mathText('It costs $5 and $x^2$'), 'It costs $5 and x²');
  });

  it('mathTextDeep converts every string in a JSON value', () => {
    const input = { a: '$x^{2}$', b: ['\\alpha', 3, null], c: { d: 'plain' } };
    assert.deepEqual(mathTextDeep(input), { a: 'x²', b: ['α', 3, null], c: { d: 'plain' } });
    assert.equal(mathTextDeep(7), 7);
  });
});

const ENGLISH = 'Photosynthesis is the process by which plants make their own food. The leaves take in carbon dioxide from the air and water from the soil. '
  + 'Using light from the sun, they turn these into sugar and oxygen. This happens mostly in the leaves, which is why they are green.';
const FILIPINO = 'Ang photosynthesis ay ang proseso kung saan gumagawa ang mga halaman ng sariling pagkain. Kumukuha sila ng tubig mula sa lupa at ng carbon dioxide mula sa hangin. '
  + 'Gamit ang liwanag ng araw, ginagawa nila itong asukal at oxygen. Karamihan nito ay nangyayari sa mga dahon kaya berde ang mga ito.';
const PHYSICS = 'Newton\'s second law\nF = ma\nv = 12 m/s, a = 3 m/s²\nKE = (1/2)mv² where m = 4 kg';

describe('looksMathy', () => {
  it('is false for English and Filipino prose, which also come back unchanged', () => {
    for (const text of [ENGLISH, FILIPINO]) {
      assert.equal(mathText(text), text);
      assert.equal(looksMathy(text), false);
    }
  });

  it('is true for physics slide text', () => {
    assert.equal(looksMathy(PHYSICS), true);
    assert.equal(looksMathy('x² + y² = r²'), true);
  });

  it('needs at least 3 hits', () => {
    assert.equal(looksMathy('v = 5 m/s'), false);
    assert.equal(looksMathy(''), false);
    assert.equal(looksMathy('Pagkatapos ng 3 oras'), false);
  });
});

describe('isMathAnswer', () => {
  it('accepts short answers made of numbers, equations or symbols', () => {
    assert.equal(isMathAnswer('12 m/s'), true);
    assert.equal(isMathAnswer('F = ma'), true);
    assert.equal(isMathAnswer('x²+1'), true);
    assert.equal(isMathAnswer('The force is 10 N'), true);
  });

  it('rejects prose, long answers and empty text', () => {
    assert.equal(isMathAnswer('The speed is twelve meters per second'), false);
    assert.equal(isMathAnswer('The car moved with a speed of 12 m/s in the east'), false);
    assert.equal(isMathAnswer('1 2 3 4 5 6 7 8 9 10 11 12 13'), false);
    assert.equal(isMathAnswer(''), false);
  });
});

describe('mathKey and sameValue', () => {
  it('normalizes numbers, signs and fractions', () => {
    assert.equal(mathKey('10²'), '10^2');
    assert.equal(mathKey('1,000'), '1000');
    assert.equal(mathKey('10.0'), '10');
    assert.equal(mathKey('½'), '0.5');
    assert.equal(mathKey('3/4'), '0.75');
    assert.equal(mathKey('A − B'), 'a-b');
    assert.equal(mathKey('2×3'), '2*3');
    assert.equal(mathKey('2·3'), '2*3');
    assert.equal(mathKey('x₁'), 'x_1');
    assert.equal(mathKey('10.0 N.'), '10n');
  });

  it('compares values', () => {
    assert.equal(sameValue('10 N', '10.0 N.'), true);
    assert.equal(sameValue('10 N', '12 N'), false);
    assert.equal(sameValue('0.5', '1/2'), true);
    assert.equal(sameValue('10² m', '102 m'), false);
    assert.equal(sameValue('abc', 'abc'), false);
  });
});
