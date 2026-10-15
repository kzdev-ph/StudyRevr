import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  answerInQuestion,
  cardLeaks,
  contentWords,
  falseStatementProblems,
  isNegative,
  language,
  lessonWords,
  maskTerm,
  optionSetProblems,
  questionLeaks,
  stem,
  termInText,
  wrongOptionProblems,
} from '../src/quiz/leaks.js';
import { EN_LESSON, FIL_LESSON } from './fixtures/leak-lessons.js';

const rules = (problems) => problems.map((p) => p.rule);
const card = (lesson, id) => lesson.cards.find((c) => c.id === id);

describe('leak checks: words', () => {
  it('Filipino forms reduce to one stem (linker, prefixes, infixes, reduplication, suffixes)', () => {
    assert.equal(stem('wikang'), 'wika');
    for (const w of ['nagbabago', 'pagbabago', 'magbago']) assert.equal(stem(w), 'bago');
    for (const w of ['ginagamit', 'ginamit', 'gamit']) assert.equal(stem(w), 'gamit');
    assert.equal(stem('pag-unlad'), 'unlad');
    assert.equal(stem('pambansang'), 'bansa');
    assert.equal(stem('kumain'), 'kain');
  });

  it('English plurals and -ing reduce in an English text, and stopwords of both languages are dropped', () => {
    assert.deepEqual(contentWords('The variables are changing'), ['variable', 'chang']);
    assert.deepEqual(contentWords('Ano ang mga epekto ng wika sa bansa?'), ['epekto', 'wika', 'bansa']);
  });

  it('tells English from Filipino, and says nothing for a bare list', () => {
    assert.equal(language('The plant releases oxygen into the air.'), 'en');
    assert.equal(language('Ginagamit ito sa pagbibigay ng impormasyon.'), 'fil');
    assert.equal(language('Nobela, tula, sanaysay'), null);
  });

  it('spots negative and reversed statements in both languages', () => {
    for (const t of ['It never changes.', 'Plants do not need light.', 'It prevents the spread of words.', 'It hides the data.', 'Hindi ito nagbabago.', 'Upang itago ang mga konsepto.', 'Ginagamit ito upang limitahan ang komunikasyon.', 'Nawala ang mga salita.', 'Pinipigilan nito ang pagkalat.', 'Upang mahirapan ang mga mag-aaral.', 'Binura ang mga tala.', 'Bilang hadlang sa pagkakaisa.'])
      assert.ok(isNegative(t), t);
    for (const t of ['It slows down because less carbon dioxide enters.', 'Ginagamit ito sa edukasyon.', 'Upang palitan ang mga aklat ng mga lumang salita.']) assert.ok(!isNegative(t), t);
  });

  it('topic words that only start like a negative are not negative (English, Filipino and Taglish)', () => {
    const neutral = [
      // English
      'It reduces stress levels.',
      'The reduction of oxygen in the cell.',
      'Harmony between the melody and the chords.',
      'A blockchain keeps a shared ledger.',
      'Building blocks of a sentence.',
      'The hidden layer of the network.',
      'Law No. 7 sets the national language.',
      'A number (no.) written before the count.',
      // Filipino and Taglish
      'Nabawasan ang oras ng paglalakbay.',
      'Ang unang burador ng sanaysay.',
      'Ang paghihirap ng mga magsasaka noong digmaan.',
      'Ang pag-alis ng mga Espanyol sa bansa.',
      'Nakatago ang enerhiya sa asukal.',
      'Ang blockchain ay ginagamit sa pagbabayad.',
      'Mahalaga ang harmony sa awit.',
      'Ayon sa Batas No. 7 ng Komonwelt.',
      'Ang hidden layer ng network.',
    ];
    for (const t of neutral) assert.ok(!isNegative(t), t);
    // so a positive right answer with "reduces" next to positive wrong ones is a fair set
    assert.deepEqual(optionSetProblems('What does exercise do to stress?', 'It reduces stress levels.', ['It raises stress levels.', 'It moves stress to the muscles.', 'It turns stress into energy.']), []);
    assert.deepEqual(rules(wrongOptionProblems('Ang unang burador ng sanaysay.', 'Ang huling bersyon ng sanaysay.')), []);
  });

  it('a short phrase the language check can’t place is compared under both stemmers (rules a, d, f)', () => {
    assert.equal(language('Pattern matching'), null);
    // a: "matching" in an English question is the answer's "matching"
    assert.ok(answerInQuestion('What is finding a pattern by matching text called?', 'Pattern matching'));
    assert.ok(answerInQuestion('Ano ang tawag sa pagtutugma ng pattern sa matching?', 'Pattern matching'));
    // d: every form termInText finds is blanked, also when the term holds an English marker word
    assert.deepEqual(termInText('Law of marketing', 'Marketing is the process of selling a product.'), ['market']);
    assert.equal(maskTerm('Marketing is the process of selling a product.', 'Law of marketing'), '___ is the process of selling a product.');
    assert.equal(termInText('Law of marketing', maskTerm('Marketing is the process of selling a product.', 'Law of marketing')), null);
    assert.equal(maskTerm('Ginagamit ang marketing sa negosyo.', 'Marketing'), 'Ginagamit ang ___ sa negosyo.');
    // f: an option about the lesson's own words is not "about nothing in the lesson"
    const en = lessonWords('Marketing is the process of selling a product. Matching ads to buyers helps the business.');
    assert.deepEqual(wrongOptionProblems('Marketing campaigns', 'Selling products', { lessonWords: en, lengths: false }), []);
    assert.deepEqual(wrongOptionProblems('Matching buyers', 'Selling products', { lessonWords: en, lengths: false }), []);
    const fil = lessonWords('Mahalaga ang marketing sa negosyo upang makilala ang produkto ng mga mamimili.');
    assert.deepEqual(wrongOptionProblems('Marketing ng produkto', 'Pagbebenta ng produkto', { lessonWords: fil, lengths: false }), []);
  });
});

describe('leak checks: quiz rules a-f', () => {
  it('a: the question holds the answer or most of its words (English and Filipino)', () => {
    assert.ok(answerInQuestion(card(EN_LESSON, 7).front, card(EN_LESSON, 7).back));
    assert.ok(answerInQuestion('Bakit tinatawag na dinamiko ang wika na patuloy na nagbabago?', 'Dahil patuloy itong nagbabago.'));
    assert.equal(answerInQuestion(card(EN_LESSON, 4).front, card(EN_LESSON, 4).back), null);
    assert.equal(answerInQuestion(card(FIL_LESSON, 15).front, card(FIL_LESSON, 15).back), null);
  });

  it('a: a one-word answer counts only as a whole word or stem, not inside another word', () => {
    assert.equal(answerInQuestion('Where is a database stored?', 'Data'), null);
    assert.equal(answerInQuestion('Why is the mitochondrion an excellent energy source?', 'Cell'), null);
    assert.ok(answerInQuestion('What is the smallest unit of life, the cell, made of?', 'Cell'));
    assert.ok(answerInQuestion('Ano ang tawag sa mga salitang hiram sa wikang Espanyol?', 'Hiram'));
  });

  it('b: only the right option repeats two or more of the question’s words, the topic aside', () => {
    // every option shares the lesson's common word ("wika"), but only the right one repeats the key words
    assert.match(optionSetProblems('Ano ang kinakatawan ng mga ugat at mga sanga ng wika?', 'Ang ugat ay ang katutubong wika at ang mga sanga ay ang mga impluwensiya.', ['Nagmula ang wika sa mga dayuhan.', 'Binubuo ang wika ng mga katutubong salita.', 'Nagbago ang wika dahil sa teknolohiya.'])[0].detail, /\(ugat, sanga\)/);
    const green = ['Why are plants green?', 'Plants are green because chlorophyll reflects green light.', ['Because the soil gives them color.', 'Because rain washes their surface.', 'Because the sun paints the leaves.']];
    assert.match(optionSetProblems(...green)[0].detail, /\(plant, green\)/);
    // one echoed word is not enough: a fair answer naturally repeats the thing asked about
    assert.deepEqual(optionSetProblems('What do plants release through the stomata?', 'Oxygen through the stomata.', ['Glucose through the leaves.', 'Water through the roots.', 'Sugar through the stems.']), []);
    assert.deepEqual(optionSetProblems('How do plants use the stomata?', 'Plants open the stomata to take in carbon dioxide.', ['Plants store sugar in the roots.', 'Plants release water through the leaves.', 'Plants make glucose in the stroma.']), []);
    assert.deepEqual(optionSetProblems('Paano ginagamit ang wika sa midya?', 'Ginagamit ito upang maabot ang mas maraming tao.', ['Upang magbenta ng produkto.', 'Para sa libangan lamang.', 'Upang turuan ang mga dayuhan.']), []);
    // the question's topic (the word the lesson uses most) doesn't count: "plants" in a lesson about plants
    assert.deepEqual(optionSetProblems(...green, { lessonWords: lessonWords(EN_LESSON.text) }), []);
    // the same word, not a word that starts like it: "data" is not "database"
    assert.deepEqual(optionSetProblems('Why do researchers collect data from schools?', 'To build a database of schools for later study.', ['To sell the records to companies.', 'To grade the teachers each year.', 'To plan new roads in the town.']), []);
  });

  it('c: length, opening words, sentence shape and tone', () => {
    const six = card(EN_LESSON, 6);
    assert.deepEqual(rules(wrongOptionProblems('It stops.', six.back)), ['c']);
    assert.deepEqual(rules(wrongOptionProblems('Sa mga larangan.', 'Nabawasan ang paggamit ng Filipino sa negosyo, teknolohiya at siyensya at nanganganib mawala ang mga salita.')), ['c']);
    assert.deepEqual(wrongOptionProblems('It speeds up because more light arrives.', six.back), []);

    const sixteen = card(FIL_LESSON, 16);
    assert.match(optionSetProblems(sixteen.front, sixteen.back, FIL_LESSON.distractors[16]).map((p) => p.detail).join(), /opening/);
    assert.match(optionSetProblems('Why is the sky blue?', 'Air scatters short light waves more.', ['It is because of the ocean.', 'It is because of clouds.', 'It is because of dust.'])[0].detail, /opening/);
    assert.match(optionSetProblems('Why do leaves look green?', 'Chlorophyll reflects green light while absorbing red light.', ['Red pigment', 'Blue pigment', 'Yellow pigment']).map((p) => p.detail).join(), /sentence shape/);

    assert.match(wrongOptionProblems('Upang mahirapan ang mga mag-aaral.', card(FIL_LESSON, 14).back)[0].detail, /tone/);
    assert.match(wrongOptionProblems('Chlorophyll never reflects any light at all.', card(EN_LESSON, 5).back)[0].detail, /tone/);
    // a negative next to a negative right answer is fine
    assert.deepEqual(wrongOptionProblems('Kapag hindi ito ginagamit sa paaralan.', 'Kapag hindi naipapasa sa bagong henerasyon.'), []);
    // ...but a negative right answer among only positive wrong options stands out the other way
    const hamon = 'Nabawasan ang paggamit ng Filipino at nanganganib mawala ang ilang katutubong salita.';
    assert.match(optionSetProblems('Ano ang epekto ng mga hamon sa wika?', hamon, ['Lumalawak ang paggamit ng Filipino sa pamahalaan.', 'Dumarami ang mga bagong katutubong salita.', 'Napapaunlad ang paraan ng pakikipagkomunikasyon.']).map((p) => p.detail).join(), /only negative/);
    assert.match(optionSetProblems('What happens to photosynthesis in a drought?', 'It is reduced because carbon dioxide cannot enter.', ['It speeds up because more light arrives.', 'It moves to the roots of the plant.', 'It makes more oxygen at night.']).map((p) => p.detail).join(), /only negative/);
    assert.doesNotMatch(optionSetProblems('Ano ang epekto ng mga hamon sa wika?', hamon, ['Nawala ang mga aklat sa paaralan.', 'Dumarami ang mga bagong katutubong salita.', 'Napapaunlad ang paraan ng pakikipagkomunikasyon.']).map((p) => p.detail).join(), /only negative/);
  });

  it('d: a definition that holds its term (or a form of it) is found and blanked', () => {
    assert.deepEqual(termInText('Calvin cycle', card(EN_LESSON, 3).back), ['calv', 'cycle']);
    assert.equal(maskTerm(card(EN_LESSON, 3).back, 'Calvin cycle'), 'The ___ builds glucose from carbon dioxide in the stroma.');
    assert.ok(termInText('Wikang Pambansa', card(FIL_LESSON, 13).back));
    assert.equal(maskTerm(card(FIL_LESSON, 13).back, 'Wikang Pambansa'), 'Ang ___ na ginagamit sa buong ___.');
    assert.ok(termInText('Dinamiko', 'Ang pagiging dinamikong wika ay patuloy na pagbabago.'));
    assert.equal(termInText('Balarila', card(FIL_LESSON, 11).back), null);
    assert.equal(maskTerm(card(FIL_LESSON, 11).back, 'Balarila'), card(FIL_LESSON, 11).back);
  });

  it('e: a false Yes/No statement that is false from its wording', () => {
    assert.deepEqual(rules(falseStatementProblems('Upang itago ang mga konsepto sa mga mag-aaral.', card(FIL_LESSON, 14).back)), ['e']);
    assert.deepEqual(rules(falseStatementProblems('It is used to collect taxes from citizens.', card(FIL_LESSON, 16).back)), ['e']);
    assert.deepEqual(falseStatementProblems('Upang palitan ang mga aklat ng mga lumang salita.', card(FIL_LESSON, 14).back), []);
    assert.match(falseStatementProblems('Paraan ito ng pagkakaisa bilang simbolo ng kultura at identidad ng mga Pilipino.', 'Nagpapakita ito ng pagkakaisa bilang simbolo ng kultura at identidad ng mga Pilipino.')[0].detail, /right answer’s own words/);
    assert.match(falseStatementProblems('Plants turn sunlight into stored chemical energy.', 'Plants turn sunlight into chemical energy they store.')[0].detail, /right answer’s own words/);
    const tf = { type: 'tf', kind: 'term', question: 'Balarila', statement: 'Nagkaroon tayo ng mga salitang galing sa Espanyol.', choices: ['True', 'False'], answer_index: 1, answer_text: card(FIL_LESSON, 11).back, false_from: 'concept' };
    assert.deepEqual(rules(questionLeaks(tf)), ['e']);
    const own = { type: 'tf', kind: 'term', question: 'Calvin cycle', statement: card(EN_LESSON, 3).back, choices: ['True', 'False'], answer_index: 0, answer_text: card(EN_LESSON, 3).back };
    assert.deepEqual(rules(questionLeaks(own)), ['e'], 'a true statement that names its own term');
  });

  it('e: an English false statement that is negative or reversed', () => {
    assert.match(falseStatementProblems('Plants do not need sunlight to make food.', 'Plants use sunlight to make glucose.')[0].detail, /negative/);
    assert.match(falseStatementProblems('Chlorophyll never absorbs red light.', 'Chlorophyll absorbs red and blue light.')[0].detail, /negative/);
    assert.deepEqual(falseStatementProblems('Plants store sugar in the roots.', 'Plants use sunlight to make glucose.'), []);
  });

  it('f: near-duplicate wrong options, another language, off-topic', () => {
    assert.match(optionSetProblems('Where do the light reactions take place?', 'In the thylakoid membranes.', ['In the stroma of the cell.', 'In the cell stroma.', 'In the green pigment.']).map((p) => p.detail).join(), /near-duplicate/);
    assert.deepEqual(rules(wrongOptionProblems('The government uses it to make laws.', card(FIL_LESSON, 16).back)), ['f']);
    const lessonWords = new Set(contentWords(EN_LESSON.text));
    assert.match(wrongOptionProblems('In the mitochondria of animal cells.', card(EN_LESSON, 4).back, { lessonWords })[0].detail, /nothing in the lesson/);
    assert.deepEqual(wrongOptionProblems('In the stroma of the chloroplast.', card(EN_LESSON, 4).back, { lessonWords }), []);
    // a reworded right answer is a second right answer
    assert.match(wrongOptionProblems('Paraan ito ng pagkakaisa sa pamamagitan ng pagsisilbing simbolo ng kultura at identidad ng mga Pilipino.', 'Nagpapakita ito ng pagkakaisa sa pamamagitan ng pagsisilbing simbolo ng kultura at identidad ng mga Pilipino.').map((p) => p.detail).join(), /right answer’s own words/);
    assert.match(wrongOptionProblems('Chlorophyll reflects green light and absorbs red light.', card(EN_LESSON, 5).back).map((p) => p.detail).join(), /right answer’s own words/);
    const filWords = new Set(contentWords(FIL_LESSON.text));
    assert.match(wrongOptionProblems('Lumaki ang mga bundok at ilog sa kapuluan.', card(FIL_LESSON, 15).back, { lessonWords: filWords }).map((p) => p.detail).join(), /nothing in the lesson/);
    // another card's answer answers that other question, so it is matched away
    const govt = 'Ginagamit ito sa pagbibigay ng impormasyon at serbisyo sa mamamayan.';
    assert.match(wrongOptionProblems('Ginagamit ito sa pagbibigay ng impormasyon at serbisyo sa lahat ng mamamayan.', 'Ginagamit ito upang mas madaling maipaliwanag ang mga konsepto.', { otherAnswers: [govt] }).map((p) => p.detail).join(), /another card’s answer/);
    assert.match(wrongOptionProblems('Plants release oxygen into the air.', card(EN_LESSON, 6).back, { otherAnswers: ['Plants release oxygen into the air as a by-product.'] }).map((p) => p.detail).join(), /another card’s answer/);
    assert.deepEqual(wrongOptionProblems('Ginagamit ito sa pagsulat ng mga batas.', 'Ginagamit ito upang mas madaling maipaliwanag ang mga konsepto.', { otherAnswers: [govt] }), []);
  });

  it('a clean multiple-choice question breaks no rule (English and Filipino)', () => {
    const en = { type: 'mc', kind: 'concept', question: card(EN_LESSON, 8).front, choices: ['ATP and NADPH.', ...EN_LESSON.distractors[8]], answer_index: 0, answer_text: 'ATP and NADPH.' };
    assert.deepEqual(questionLeaks(en, { lessonWords: new Set(contentWords(EN_LESSON.text)) }), []);
    const fil = { type: 'mc', kind: 'concept', question: card(FIL_LESSON, 15).front, choices: [card(FIL_LESSON, 15).back, ...FIL_LESSON.distractors[15]], answer_index: 0, answer_text: card(FIL_LESSON, 15).back };
    assert.deepEqual(questionLeaks(fil, { lessonWords: new Set(contentWords(FIL_LESSON.text)) }), []);
  });
});

describe('leak checks: flashcard rules g-k', () => {
  it('g: the front holds the back', () => {
    assert.deepEqual(rules(cardLeaks(card(EN_LESSON, 7))), ['g']);
    assert.ok(rules(cardLeaks(card(FIL_LESSON, 17))).includes('g'));
  });

  it('h: a term card whose definition holds the term', () => {
    assert.deepEqual(rules(cardLeaks(card(EN_LESSON, 3))), ['h']);
    assert.deepEqual(rules(cardLeaks(card(FIL_LESSON, 13))), ['h']);
    assert.deepEqual(cardLeaks(card(FIL_LESSON, 12)), []);
    // every word of a two-word term, as whole words: "cell" alone is not "Cell membrane"
    assert.deepEqual(cardLeaks({ kind: 'term', front: 'Cell membrane', back: 'The thin layer that surrounds every cell and controls what enters it.' }), []);
    assert.deepEqual(rules(cardLeaks({ kind: 'term', front: 'Cell membrane', back: 'The cell membrane controls what enters.' })), ['h']);
  });

  it('i: yes/no and either/or questions, but not a Filipino "o" between two nouns', () => {
    assert.deepEqual(rules(cardLeaks({ kind: 'concept', front: 'Does chlorophyll absorb green light?', back: 'Mostly red and blue light.' })), ['i']);
    assert.deepEqual(rules(cardLeaks({ kind: 'concept', front: 'Nagbabago ba ang wika?', back: 'Oo, kasabay ng kultura.' })), ['i']);
    assert.deepEqual(rules(cardLeaks({ kind: 'concept', front: 'Katutubo ang wika o hindi?', back: 'Mula sa mga ninuno natin.' })), ['i']);
    assert.deepEqual(rules(cardLeaks({ kind: 'concept', front: 'Does it grow or not?', back: 'It grows in the light.' })), ['i']);
    assert.ok(rules(cardLeaks({ kind: 'concept', front: 'Is glucose made in the stroma or in the thylakoid?', back: 'In the stroma.' })).includes('i'));
    assert.deepEqual(cardLeaks({ kind: 'concept', front: 'Saang mga institusyon o larangan ginagamit ang Filipino?', back: 'Sa edukasyon, pamahalaan at midya.' }), []);
    // "ba" in a question that asks what / why is still an open question
    assert.deepEqual(cardLeaks({ kind: 'concept', front: 'Ano ba ang ibig sabihin ng barayti ng wika?', back: 'Ang iba’t ibang anyo nito sa bawat lugar.' }), []);
    assert.deepEqual(cardLeaks({ kind: 'concept', front: 'Bakit ba mahalaga ang wika sa bansa?', back: 'Pinag-iisa nito ang mga mamamayan.' }), []);
  });

  it('j: the front holds another card’s answer (English and Filipino)', () => {
    const a = { id: 1, kind: 'concept', front: 'Why does photosynthesis slow down when less carbon dioxide enters the leaf?', back: 'Because the stomata close on hot days.' };
    const b = { id: 2, kind: 'concept', front: 'What happens when the stomata close?', back: 'Less carbon dioxide enters the leaf.' };
    assert.ok(rules(cardLeaks(a, [a, b])).includes('j'));
    assert.ok(!rules(cardLeaks(b, [a, b])).includes('j'));
    const fa = { id: 3, kind: 'concept', front: 'Bakit ginagamit ang Filipino sa edukasyon, pamahalaan at midya?', back: 'Upang mas madaling maunawaan ng mamamayan.' };
    const fb = { id: 4, kind: 'concept', front: 'Saan ginagamit ang Wikang Filipino?', back: 'Sa edukasyon, pamahalaan at midya.' };
    assert.ok(rules(cardLeaks(fa, [fa, fb])).includes('j'));
    assert.ok(!rules(cardLeaks(fb, [fa, fb])).includes('j'));
  });

  it('k: the back only restates the front', () => {
    assert.ok(rules(cardLeaks(card(FIL_LESSON, 17))).includes('k'));
    assert.deepEqual(rules(cardLeaks({ kind: 'concept', front: 'How does light energy change in photosynthesis?', back: 'Light energy changes in photosynthesis.' })).sort(), ['g', 'k']);
  });

  it('g / k: a "Bakit mahalaga…" card whose answer repeats the topic but gives the reason is kept', () => {
    assert.deepEqual(cardLeaks({ kind: 'concept', front: 'Bakit mahalaga ang wika sa komunikasyon?', back: 'Mahalaga ang wika dahil ito ang daan sa komunikasyon.' }), []);
    assert.deepEqual(cardLeaks({ kind: 'concept', front: 'Why is water important to plants?', back: 'Water is important because plants use it to make glucose.' }), []);
  });

  it('every clean card of both lessons passes', () => {
    for (const lesson of [EN_LESSON, FIL_LESSON])
      for (const c of lesson.cards.filter((x) => ![3, 7, 13, 17].includes(x.id))) assert.deepEqual(cardLeaks(c, lesson.cards), [], `${lesson.title} #${c.id}`);
  });
});
