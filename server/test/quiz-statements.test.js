import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lessonWords, wordsNotIn } from '../src/quiz/leaks.js';
import { ABSOLUTES, checkPair, MAX_STATEMENT_WORDS, splitChange, trueProblems, twinProblems } from '../src/quiz/statements.js';

const rules = (problems) => problems.map((p) => p.rule);

const EN_TEXT =
  'A compiler translates source code into machine code. An interpreter runs source code line by line. A linker joins object files into one program. Marketing campaigns advertise a product to customers.';
const EN = lessonWords(EN_TEXT);
const EN_CARD = {
  front: 'What does a compiler translate source code into?',
  back: 'machine code',
  evidence: 'A compiler translates source code into machine code.',
};
const EN_T = 'A compiler translates source code into machine code.';

const FIL_TEXT =
  'Ang wika ay ginagamit ng tao sa komunikasyon. Ang bokabularyo ay binubuo ng mga salita. Ang gramatika ay ang mga tuntunin ng wika.';
const FIL = lessonWords(FIL_TEXT);
const FIL_CARD = {
  front: 'Ano ang ginagamit ng tao sa komunikasyon?',
  back: 'wika',
  evidence: 'Ang wika ay ginagamit ng tao sa komunikasyon.',
};
const FIL_T = 'Ang wika ay ginagamit ng tao sa komunikasyon.';

const MARKETING_CARD = {
  front: 'How do marketing campaigns reach customers?',
  back: 'advertise a product',
  evidence: 'Marketing campaigns advertise a product to customers.',
};
const MARKETING_T = 'Marketing campaigns advertise a product to customers.';

const opts = { lessonWords: EN, otherAnswers: ['runs line by line'] };
const twin = (falseText, card = EN_CARD, trueText = EN_T, o = opts) => twinProblems(card, trueText, falseText, o);

describe('wordsNotIn', () => {
  it('returns the content words with no exact match in the source', () => {
    assert.deepEqual(wordsNotIn('The compiler builds optimized code', 'A compiler builds code'), ['optimiz']);
    assert.deepEqual(wordsNotIn('compilers', 'a compiler'), []);
    // "data" is not "database"
    assert.deepEqual(wordsNotIn('data', 'a database'), ['data']);
  });
});

describe('splitChange', () => {
  it('strips the common prefix and suffix', () => {
    const c = splitChange(EN_T, 'A compiler translates source code into object files.');
    assert.deepEqual(c.removed.tokens, ['machine', 'code']);
    assert.deepEqual(c.added.tokens, ['object', 'files']);
    assert.equal(c.removed.text, 'machine code');
    assert.equal(c.added.text, 'object files');
    assert.equal(c.frame.text, 'a compiler translates source code into');
  });

  it('never lets the prefix and suffix overlap', () => {
    const c = splitChange('a b a', 'a b a b a');
    assert.equal(c.removed.tokens.length + c.frame.tokens.length, 3);
    assert.deepEqual(c.removed.tokens, []);
  });
});

describe('statements: good pairs', () => {
  it('an English pair passes', () => {
    const r = checkPair(EN_CARD, { true_statement: EN_T, false_statement: 'A compiler translates source code into object files.' }, opts);
    assert.deepEqual(r, { ok: true, problems: [] });
  });

  it('a Filipino pair passes', () => {
    const r = checkPair(FIL_CARD, { true_statement: FIL_T, false_statement: 'Ang bokabularyo ay ginagamit ng tao sa komunikasyon.' }, { lessonWords: FIL, otherAnswers: ['gramatika'] });
    assert.deepEqual(r, { ok: true, problems: [] });
  });

  it('accepts the stored field names', () => {
    const r = checkPair(EN_CARD, { true_text: EN_T, false_text: 'A compiler translates source code into object files.' }, opts);
    assert.equal(r.ok, true);
  });

  it('an inflected word of the question or answer is still grounded', () => {
    assert.deepEqual(trueProblems(EN_CARD, 'A compiler translates source code into machine code.'), []);
    assert.deepEqual(trueProblems(EN_CARD, 'Compilers translate source code into machine code.'), []);
  });
});

describe('statements: the TRUE sentence', () => {
  it('rejects a new content word', () => {
    const p = trueProblems(EN_CARD, 'A compiler translates source code into optimized machine code.');
    assert.ok(rules(p).includes('s'));
    assert.match(p.find((x) => x.rule === 's').detail, /not in the card/);
  });

  it('rejects a sentence missing an answer word', () => {
    const p = trueProblems(EN_CARD, 'A compiler translates source code.');
    assert.ok(p.some((x) => x.rule === 's' && /does not state the answer/.test(x.detail)));
  });

  it('rejects a negative the card does not make, and accepts one the card makes', () => {
    assert.ok(rules(trueProblems(EN_CARD, 'A compiler never translates source code into machine code.')).includes('e'));
    const negCard = { front: 'What does a pure function not have?', back: 'side effects', evidence: '' };
    assert.deepEqual(trueProblems(negCard, 'A pure function does not have side effects.'), []);
  });

  it('rejects an absolute word the card does not use', () => {
    for (const w of ['always', 'only', 'every']) {
      const p = trueProblems(EN_CARD, `A compiler ${w} translates source code into machine code.`);
      assert.ok(p.some((x) => x.rule === 'e' && /absolute/.test(x.detail)), w);
    }
    assert.ok(rules(trueProblems(FIL_CARD, 'Ang wika ay palaging ginagamit ng tao sa komunikasyon.')).includes('e'));
    assert.ok(ABSOLUTES.has('lahat') && ABSOLUTES.has('always'));
  });

  it('rejects another language than the answer', () => {
    const card = { front: 'What does a compiler produce?', back: 'the machine code', evidence: '' };
    const p = trueProblems(card, 'Ang compiler ay nagsasalin ng source code sa machine code.');
    assert.ok(p.some((x) => x.rule === 'e' && /another language/.test(x.detail)));
  });

  it('rejects a sentence of fewer than 5 words, and accepts one of exactly 5', () => {
    const card = { front: 'What does a compiler produce?', back: 'machine code', evidence: '' };
    const p = trueProblems(card, 'A compiler produces machine code.');
    assert.deepEqual(p, []);
    const short = trueProblems(card, 'Compiler produces machine code.');
    assert.ok(short.some((x) => x.rule === 's' && /fewer than 5/.test(x.detail)));
    assert.ok(trueProblems(card, 'machine code').some((x) => /fewer than 5/.test(x.detail)));
  });

  it('rejects the bare answer: no word of the question besides the answer', () => {
    const card = { front: 'Which term names the divisor of a fraction?', back: 'the complex conjugate of the denominator', evidence: '' };
    const bare = trueProblems(card, 'The complex conjugate of the denominator is the complex conjugate of the denominator.');
    assert.ok(bare.some((x) => x.rule === 's' && /without the subject/.test(x.detail)));
    assert.deepEqual(trueProblems(card, 'The term for the divisor of a fraction is the complex conjugate of the denominator.'), []);
  });

  it('rejects a digits-only or formula-only sentence', () => {
    const card = { front: 'What is the value?', back: '2x + 3 = 7', evidence: '' };
    const p = trueProblems(card, '2x + 3 = 7 2x + 3 = 7');
    assert.ok(p.some((x) => x.rule === 's' && /only digits or a formula/.test(x.detail)));
    assert.deepEqual(trueProblems(card, 'The value is 2x + 3 = 7.'), []);
  });

  it('rejects no text, a question mark and more than 45 words', () => {
    assert.ok(rules(trueProblems(EN_CARD, '')).includes('s'));
    assert.ok(trueProblems(EN_CARD, 'A compiler translates source code into machine code?').some((x) => /question mark/.test(x.detail)));
    const long = `${EN_T.slice(0, -1)} ${Array(MAX_STATEMENT_WORDS).fill('code').join(' ')}.`;
    assert.ok(trueProblems(EN_CARD, long).some((x) => new RegExp(`more than ${MAX_STATEMENT_WORDS}`).test(x.detail)));
  });
});

describe('statements: the FALSE twin', () => {
  it('rejects "not" inserted, and "does not build" in place of "builds"', () => {
    assert.ok(rules(twin('A compiler does not translate source code into machine code.')).length > 0);
    const inserted = twin('A compiler translates source code into not machine code.');
    assert.ok(rules(inserted).includes('e'));
    const p = twin('A compiler does not translate source code into machine code.');
    assert.ok(p.some((x) => x.rule === 'e'));
    assert.ok(p.some((x) => x.rule === 's' && /does not replace the answer/.test(x.detail)));
  });

  it('rejects "only" or "always" added', () => {
    for (const w of ['only', 'always']) {
      const p = twin(`A compiler translates source code ${w} into machine code.`);
      assert.ok(p.some((x) => x.rule === 'e' && /only adds or drops/.test(x.detail)), w);
    }
  });

  it('rejects an absolute word swapped in for the answer', () => {
    const p = twin('A compiler translates source code into always machine code and nothing else.');
    assert.ok(rules(p).length > 0);
    const q = twin('A compiler translates source code into only linkers.');
    assert.ok(q.some((x) => x.rule === 'e' && /absolute/.test(x.detail)));
  });

  it('rejects the subject swapped instead of the answer', () => {
    const p = twin('An interpreter translates source code into machine code.');
    assert.ok(p.some((x) => x.rule === 's' && /does not replace the answer/.test(x.detail)));
  });

  it('rejects a twin that still holds the answer', () => {
    const p = twin('A compiler translates machine code into machine code.');
    assert.ok(rules(p).includes('a'));
  });

  it('rejects a reordered or re-inflected change', () => {
    const p = twin('A compiler translated source code into machine code.');
    assert.ok(p.some((x) => x.rule === 'e' && /re-inflected/.test(x.detail)));
  });

  it('rejects a number swapped for a word, or a word for a number, and accepts a number for a number', () => {
    const card = { front: 'How wide is a word?', back: '16 bits', evidence: '' };
    const t = 'A word is 16 bits wide.';
    const o = { lessonWords: lessonWords('A word is 16 bits wide. A long word is 32 bits wide. A nibble is narrow.'), otherAnswers: [] };
    assert.deepEqual(twinProblems(card, t, 'A word is 32 bits wide.', o), []);
    const wordForNumber = twinProblems(card, t, 'A word is nibble bits wide.', o);
    assert.ok(wordForNumber.some((x) => x.rule === 'f' && /number vs word/.test(x.detail)));
    const textCard = { front: 'What does a compiler translate source code into?', back: 'machine code', evidence: '' };
    const numberForWord = twinProblems(textCard, EN_T, 'A compiler translates source code into 8 code.', opts);
    assert.ok(numberForWord.some((x) => x.rule === 'f' && /number vs word/.test(x.detail)));
  });

  it('rejects a span that is not in the lesson', () => {
    const p = twin('A compiler translates source code into banana peels.');
    assert.ok(p.some((x) => x.rule === 'f' && /not in the lesson/.test(x.detail)));
  });

  it('rejects another card\'s answer as the span', () => {
    const p = twin('A compiler translates source code into object files.', EN_CARD, EN_T, { lessonWords: EN, otherAnswers: ['object files'] });
    assert.ok(p.some((x) => x.rule === 'f' && /another card/.test(x.detail)));
    assert.deepEqual(twin('A compiler translates source code into object files.', EN_CARD, EN_T, { lessonWords: EN, otherAnswers: [] }), []);
  });

  it('rejects a reworded span ("promote" for "advertise")', () => {
    const o = { lessonWords: EN, otherAnswers: [] };
    assert.deepEqual(twin('Marketing campaigns reserve a product to customers.', MARKETING_CARD, MARKETING_T, o).map((x) => x.rule), ['f']);
    const p = twin('Marketing campaigns promote a product to customers.', MARKETING_CARD, MARKETING_T, o);
    assert.deepEqual(rules(p), ['f']);
    assert.match(p[0].detail, /promote/);
    // the same change passes when the lesson uses the word
    const wide = lessonWords(`${EN_TEXT} Some firms promote their brands.`);
    assert.deepEqual(twin('Marketing campaigns promote a product to customers.', MARKETING_CARD, MARKETING_T, { lessonWords: wide, otherAnswers: [] }), []);
  });

  it('rejects a language mismatch', () => {
    const card = { front: 'What does a compiler produce?', back: 'the machine code', evidence: '' };
    const p = twinProblems(card, 'A compiler translates source code into the machine code.', 'A compiler translates source code into ang mga bagay ng sa.', opts);
    assert.ok(p.some((x) => x.rule === 'e' && /another language/.test(x.detail)));
    assert.ok(p.some((x) => x.rule === 'f' && /another language/.test(x.detail)));
  });

  it('rejects a question mark and more than 45 words', () => {
    assert.ok(twin('A compiler translates source code into object files?').some((x) => /question mark/.test(x.detail)));
    const long = `A compiler translates source code into object files ${Array(MAX_STATEMENT_WORDS).fill('linker').join(' ')}.`;
    assert.ok(twin(long, EN_CARD, `${long.replace('object files', 'machine code')}`).some((x) => new RegExp(`more than ${MAX_STATEMENT_WORDS}`).test(x.detail)));
  });

  it('rejects a length outside 0.6-1.6x the original and more than 4 words apart', () => {
    const p = twin('A compiler translates source code into object files from the linker and the interpreter.');
    assert.ok(p.some((x) => x.rule === 'c' && /length/.test(x.detail)));
    // within 4 words of the original, a longer span is fine
    assert.ok(!twin('A compiler translates source code into object files from linkers.').some((x) => x.rule === 'c'));
  });

  it('rejects a change that only repeats the rest of the sentence', () => {
    const p = twin('A compiler translates source code into compiler source.', EN_CARD, EN_T, { lessonWords: EN });
    assert.ok(p.some((x) => /only repeats/.test(x.detail)));
  });

  it('without a lesson the lesson checks are skipped', () => {
    assert.deepEqual(twin('A compiler translates source code into banana peels.', EN_CARD, EN_T, {}), []);
  });
});

describe('checkPair', () => {
  it('collects the problems of both sentences, with where they came from', () => {
    const r = checkPair(EN_CARD, { true_statement: 'A compiler translates source code.', false_statement: 'A compiler only translates source code?' }, opts);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.detail.startsWith('true statement: ')));
    assert.ok(r.problems.some((p) => p.detail.startsWith('false twin: ')));
  });

  it('a missing pair is not ok', () => {
    assert.equal(checkPair(EN_CARD, {}, opts).ok, false);
    assert.equal(checkPair(EN_CARD, null, opts).ok, false);
  });
});
