import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { textDamage, damageReason } from '../src/services/text-damage.js';

const repeat = (s, n) => Array.from({ length: n }, () => s).join('\n');

const GARBLED = repeat('Th nk carefu y abut how each force affects an ob ect. Don t forget the ang e factor and ntegra n Work.\n'
  + 'Next Master ng Phys cs dead ne s next Monday. Exam #2 s next Fr day at 10 am.', 5);

const ENGLISH = repeat('Photosynthesis is the process by which green plants use sunlight to turn water and carbon dioxide into sugar and oxygen. '
  + 'The reaction happens inside the chloroplasts, where chlorophyll absorbs light from the sun. '
  + 'Students should compare this process with cellular respiration and explain why the two are connected. '
  + 'Remember to describe the inputs, the outputs, and the place where each step takes place in the cell.', 2);

const FILIPINO = repeat('Ang kwento ng mga Anak ng Bayan ay isinulat ni Jose para sa mga mag-aaral sa ating paaralan. '
  + 'Pwede ninyong basahin ang aralin sa bahay o sa silid-aklatan, tsaka isulat ang sagot sa kuwaderno. '
  + 'Si Maria ay nagtanong kung ano ang ibig sabihin ng salita, at sinagot ito ng guro sa harap ng klase. '
  + 'Ang mga bata ay masayang nakinig sa kuwento ng kanilang lola tungkol sa ating mga bayani.', 2);

const TAGLISH = repeat('Ang photosynthesis ay ang proseso kung saan ginagawang pagkain ng halaman ang sikat ng araw. '
  + 'Pakiusap, i-review ninyo ang notes bago ang quiz, tsaka basahin ulit ang chapter. '
  + 'Sa Monday po ang deadline ng project, kaya mag-submit na kayo sa group chat. '
  + 'Ang mga bata ay gumawa ng reviewer para sa exam at nag-share ng files sa class.', 2);

const MATH = 'In the equation y = mx + b, ang m ay ang slope at ang b ay ang y-intercept ng linya. Here we say where m is the slope.\n'
  + ENGLISH;

const ALGEBRA = repeat('Let x be a real number and let y be the output of the line. Here m is the slope and b is the y-intercept, so y = mx + b. '
  + 'Where n is the number of terms, p is a prime and k is an integer, we say that a and b are equal when x is zero. '
  + 'If c is positive then t is the time and r is the rate, so d = rt. Solve for x by moving b across, then divide by m.', 2);

const STATS = repeat('Let n be the sample size and p the proportion of successes. The sample mean x-bar is the sum of x divided by n. '
  + 'Here s is the sample standard deviation and z is the score, where n is large and p is near one half. '
  + 'We use t when n is small, and r is the correlation between x and y. Then k is the number of groups and q is one minus p.', 2);

const TEXT_SPEAK = repeat('d ko alam kung bakit lng kasi hindi pa daw tlga ok kc busy sya. '
  + 'Sabi ni Ana kc may quiz tlga bukas lng pala, d ko pa nabasa ang notes kc wala akong time. '
  + 'Hindi lng yan, d ko rin alam kung saan ang reviewer kc tlga nawala sa bag, lng ang natira. '
  + 'Pwede ba d tayo magkita tlga bukas kc d ko alam ang sagot lng, ok lng ba yan sa iyo.', 2);

describe('textDamage', () => {
  it('flags garbled text with dropped letters as broken_words', () => {
    const stats = textDamage(GARBLED);
    assert.ok(stats.words >= 100, `words ${stats.words}`);
    assert.ok(stats.share > 0.07, `share ${stats.share}`);
    assert.equal(damageReason(stats), 'broken_words');
  });

  it('leaves clean English alone', () => {
    const stats = textDamage(ENGLISH);
    assert.ok(stats.words >= 120, `words ${stats.words}`);
    assert.ok(stats.share < 0.02, `share ${stats.share}`);
    assert.equal(damageReason(stats), null);
  });

  it('does not count Filipino words', () => {
    const stats = textDamage(FILIPINO);
    assert.ok(stats.words >= 100, `words ${stats.words}`);
    assert.equal(stats.broken, 0);
    assert.equal(damageReason(stats), null);
  });

  it('does not count Taglish words', () => {
    const stats = textDamage(TAGLISH);
    assert.ok(stats.words >= 100, `words ${stats.words}`);
    assert.equal(stats.broken, 0);
    assert.equal(damageReason(stats), null);
  });

  it('does not count math prose with single-letter variables', () => {
    const stats = textDamage(MATH);
    assert.ok(stats.words >= 100, `words ${stats.words}`);
    assert.equal(damageReason(stats), null);
  });

  it('does not flag a full math paragraph full of single-letter variables', () => {
    const stats = textDamage(ALGEBRA);
    assert.ok(stats.words >= 150, `words ${stats.words}`);
    assert.ok(stats.share > 0.07, `lone variables still show in the share: ${stats.share}`);
    assert.ok(stats.multi < 8, `multi ${stats.multi}`);
    assert.equal(damageReason(stats), null);
  });

  it('does not flag statistics prose with n, p and x-bar', () => {
    const stats = textDamage(STATS);
    assert.ok(stats.words >= 120, `words ${stats.words}`);
    assert.equal(stats.multi, 0);
    assert.equal(damageReason(stats), null);
  });

  it('does not flag Taglish text-speak (lng, kc, tlga, d ko alam)', () => {
    const stats = textDamage(TEXT_SPEAK);
    assert.ok(stats.words >= 120, `words ${stats.words}`);
    assert.equal(stats.multi, 0);
    assert.equal(damageReason(stats), null);
  });

  it('needs 8 broken words of 2+ letters, not just lone consonants, to flag', () => {
    const lone = { words: 200, broken: 40, multi: 7, share: 0.2, replacement: 0 };
    assert.equal(damageReason(lone), null);
    assert.equal(damageReason({ ...lone, multi: 8 }), 'broken_words');
  });

  it('never counts names, acronyms, symbols, units or accented words', () => {
    const stats = textDamage('DNA KKK Cl Mg mmHg Niño señor café 42 x2');
    assert.equal(stats.broken, 0);
  });

  it('never flags fewer than 80 words', () => {
    const stats = textDamage(repeat('Th nk carefu y abut ob ect ntegra n Fr day', 5));
    assert.ok(stats.words < 80);
    assert.ok(stats.broken >= 12);
    assert.equal(damageReason(stats), null);
  });

  it('flags stray letters by count and density', () => {
    const clean = textDamage(ENGLISH);
    assert.equal(damageReason(clean, { strays: 5, wordCount: 1000 }), 'stray_letters');
    assert.equal(damageReason(clean, { strays: 4, wordCount: 1000 }), null);
    assert.equal(damageReason(clean, { strays: 5, wordCount: 2000 }), null);
  });

  it('flags replacement characters by count and share', () => {
    const few = { words: 844, broken: 0, share: 0, replacement: 26 };
    const many = { words: 500, broken: 0, share: 0, replacement: 50 };
    assert.equal(damageReason(few), null);
    assert.equal(damageReason(many), 'replacement_characters');
  });

  it('counts U+FFFD characters', () => {
    assert.equal(textDamage('ab �� cd').replacement, 2);
  });

  it('handles empty and missing text', () => {
    assert.deepEqual(textDamage(''), { words: 0, broken: 0, multi: 0, share: 0, replacement: 0 });
    assert.equal(textDamage(undefined).words, 0);
  });
});
