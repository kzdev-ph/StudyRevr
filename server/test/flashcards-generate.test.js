import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chunkLesson } from '../src/ai/chunk.js';
import { flashcardsPrompt } from '../src/ai/prompts.js';
import { comparable } from '../src/pipeline/evidence.js';
import {
  dedupeCards, generateConceptCards, generateFlashcards, interleave, isDuplicate, listItems, shortDefinition, targetCardCount, termCards, uncoveredItems,
} from '../src/pipeline/flashcards.js';
import { SELF_INTRO_TERMS, SELF_INTRO_TEXT } from './fixtures/self-intro.js';

const LESSON = [
  'Research Hypothesis\nA hypothesis is a testable prediction about the relationship between two or more variables.\nNotes:\nThe teacher says a good hypothesis can be proven wrong by data.',
  'Variables\nThe independent variable is the factor the researcher changes on purpose.\nThe dependent variable is the outcome that is measured after the change.',
  'Sampling\nRandom sampling gives every member of the population an equal chance to be chosen.\nIt reduces bias in the results of the study.',
].join('\n\n');

const KEY_TERMS = [
  { term: 'Hypothesis', definition: 'A testable prediction about how variables relate.', evidence: 'A hypothesis is a testable prediction about the relationship between two or more variables.' },
  { term: 'Independent variable', definition: 'The factor the researcher changes on purpose.', evidence: 'The independent variable is the factor the researcher changes on purpose.' },
];

// Scripted model: `reply(label, user)` -> the raw JSON value, validated with the caller's schema like the real client.
function fakeAi(reply) {
  const calls = [];
  return {
    calls,
    async generateJSON({ system, user, schema, label, maxTokens }) {
      calls.push({ system, user, label, maxTokens });
      return schema.parse(await reply(label, user, calls.length));
    },
  };
}

const concept = (question, answer, evidence) => ({ question, answer, evidence });

describe('card count', () => {
  it('is about one card per 50 words, at least 5 and at most the setting', () => {
    assert.equal(targetCardCount(100, 30), 5);
    assert.equal(targetCardCount(1000, 30), 20);
    assert.equal(targetCardCount(5000, 30), 30);
    assert.equal(targetCardCount(5000, 12), 12);
    assert.equal(targetCardCount(0, 3), 3, 'the cap wins over the minimum');
  });
});

describe('term cards', () => {
  it('turn grounded key terms into term -> definition cards', () => {
    const cards = termCards(KEY_TERMS, { sourceKey: comparable(LESSON) });
    assert.deepEqual(cards.map((c) => [c.kind, c.front, c.back]), [
      ['term', 'Hypothesis', 'A testable prediction about how variables relate.'],
      ['term', 'Independent variable', 'The factor the researcher changes on purpose.'],
    ]);
    assert.ok(cards.every((c) => comparable(LESSON).includes(comparable(c.evidence))));
  });

  it('drop a term whose evidence is missing or not in the lesson, and report it', () => {
    const drops = [];
    const cards = termCards(
      [{ term: 'Old', definition: 'No quote saved.', evidence: null }, { term: 'Made up', definition: 'x', evidence: 'This sentence is not in the lesson at all.' }],
      { sourceKey: comparable(LESSON), onDrop: (d) => drops.push(d) },
    );
    assert.equal(cards.length, 0);
    assert.deepEqual(drops, [
      { front: 'Old', reason: 'no evidence quote' },
      { front: 'Made up', reason: 'evidence not found in the lesson text' },
    ]);
  });

  it('shorten a long definition to its first sentence so it can be recalled', () => {
    const long = 'A sample is the part of the population that is studied. It is chosen so that the results can say something about everyone in the population without asking every single member.';
    assert.equal(shortDefinition(long), 'A sample is the part of the population that is studied.');
    assert.equal(shortDefinition('Short and sweet.'), 'Short and sweet.');
  });
});

describe('de-duplication', () => {
  const term = { kind: 'term', front: 'Hypothesis', back: 'A testable prediction.' };

  it('treats "What is a hypothesis?" as the same card as the term card', () => {
    assert.ok(isDuplicate(term, { kind: 'concept', front: 'What is a hypothesis?', back: 'A prediction that can be tested.' }));
    assert.ok(isDuplicate({ kind: 'term', front: 'Variable', back: 'A factor.' }, { kind: 'concept', front: 'Define variables.', back: 'Factors.' }), 'plural and "define"');
  });

  it('catches near-identical questions and cards whose question and answer mostly overlap', () => {
    const a = { front: 'Why does random sampling reduce bias?', back: 'Every member has an equal chance to be chosen.' };
    assert.ok(isDuplicate(a, { front: 'Why does random sampling reduce bias in a study?', back: 'Equal chance.' }));
    assert.ok(isDuplicate(a, { front: 'How does random sampling reduce bias?', back: 'It gives every member an equal chance to be chosen.' }));
  });

  it('keeps cards that ask different things about the same topic', () => {
    const a = { front: 'What does the independent variable do?', back: 'It is the factor the researcher changes.' };
    const b = { front: 'What does the dependent variable measure?', back: 'The outcome after the change.' };
    assert.ok(!isDuplicate(a, b));
  });

  it('keeps the first of each group, so term cards win over concept cards that repeat them', () => {
    const { kept, dropped } = dedupeCards([term, { kind: 'concept', front: 'What is a hypothesis?', back: 'x' }, { kind: 'concept', front: 'Why sample at random?', back: 'To reduce bias.' }]);
    assert.deepEqual(kept.map((c) => c.front), ['Hypothesis', 'Why sample at random?']);
    assert.equal(dropped[0].duplicateOf, term);
  });

  it('treats cards that quote the same evidence as duplicates, and keeps the term card', () => {
    const quote = 'Random sampling gives every member of the population an equal chance to be chosen.';
    const concept = { kind: 'concept', front: 'Why is random sampling fair?', back: 'Everyone has the same chance.', evidence: quote };
    const termCard = { kind: 'term', front: 'Random sampling', back: 'Choosing so all members have equal odds.', evidence: `"${quote.toUpperCase()}  "` };
    assert.ok(isDuplicate(concept, termCard), 'case, spacing and quotes ignored');
    const { kept, dropped } = dedupeCards([concept, termCard]);
    assert.deepEqual(kept, [termCard], 'term card wins even when the concept card comes first');
    assert.equal(dropped[0].card, concept);
    const other = { ...concept, front: 'What reduces bias?', evidence: 'It reduces bias in the results of the study.' };
    assert.ok(!isDuplicate(other, { kind: 'concept', front: 'What does the dependent variable measure?', back: 'The outcome.', evidence: quote }));
  });
});

describe('concept cards (mocked AI)', () => {
  const chunks = chunkLesson(LESSON, { maxTokens: 80, numbers: [1, 2, 3] });

  it('one call per chunk, each card checked against the text of its own chunk', async () => {
    assert.equal(chunks.length, 3);
    const ai = fakeAi((label) => {
      if (label.includes('part 1')) {
        return {
          cards: [
            concept('Why must a hypothesis be testable?', 'So that data can prove it wrong.', 'a good hypothesis can be proven wrong by data'),
            concept('What is the dependent variable?', 'The measured outcome.', 'The dependent variable is the outcome that is measured'), // from chunk 2: not in this chunk
          ],
        };
      }
      if (label.includes('part 2')) return { cards: [concept('What does the researcher change on purpose?', 'The independent variable.', 'The independent variable is the factor the researcher changes on purpose.')] };
      return { cards: [concept('What does random sampling reduce?', 'Bias in the results.', 'It reduces bias in the results of the study.')] };
    });
    const drops = [];
    const cards = await generateConceptCards({ ai, chunks, target: 6, onDrop: (d) => drops.push(d) });
    assert.deepEqual(cards.map((c) => c.front), ['Why must a hypothesis be testable?', 'What does the researcher change on purpose?', 'What does random sampling reduce?']);
    assert.ok(cards.every((c) => c.kind === 'concept' && c.evidence));
    assert.deepEqual(drops, [{ front: 'What is the dependent variable?', reason: 'evidence not found in the lesson text' }]);
    assert.deepEqual(ai.calls.map((c) => c.label), ['the flashcards (part 1 of 3)', 'the flashcards (part 2 of 3)', 'the flashcards (part 3 of 3)']);
  });

  it('drops answers too long to recall, missing evidence and evidence that only repeats the question', async () => {
    const [chunk] = chunkLesson(LESSON);
    const ai = fakeAi(() => ({
      cards: [
        concept('What is a hypothesis?', `${'word '.repeat(45)}end`, 'A hypothesis is a testable prediction about the relationship between two or more variables.'),
        concept('What reduces bias?', 'Random sampling.', ''),
        { question: 'What is sampling?', answer: 'Choosing members.' }, // no evidence field at all
        concept('What is random sampling?', 'Giving everyone an equal chance.', 'Random sampling'),
        concept('Why sample at random?', 'It reduces bias.', 'It reduces bias in the results of the study.'),
      ],
    }));
    const drops = [];
    const cards = await generateConceptCards({ ai, chunks: [chunk], target: 5, onDrop: (d) => drops.push(d) });
    assert.deepEqual(cards.map((c) => c.front), ['Why sample at random?']);
    assert.deepEqual(drops.map((d) => d.reason), ['answer too long to recall', 'no evidence quote', 'no evidence quote', 'evidence is only the term or a title']);
  });

  it('drops cards that give their own answer away (English and Filipino), before the evidence check', async () => {
    const [chunk] = chunkLesson(LESSON);
    const ai = fakeAi(() => ({
      cards: [
        concept('Why does random sampling reduce bias in the results?', 'It reduces bias in the results.', 'It reduces bias in the results of the study.'), // g
        concept('Is a hypothesis testable?', 'Yes, data can prove it wrong.', 'a good hypothesis can be proven wrong by data'), // i
        concept('Nagbabago ba ang wika?', 'Oo, kasabay ng kultura.', 'x'), // i (Filipino)
        concept('Paano nagbabago ang wika sa kultura?', 'Nagbabago ang wika sa kultura.', 'x'), // g / k (Filipino)
        concept('Why sample at random?', 'It reduces bias.', 'It reduces bias in the results of the study.'),
      ],
    }));
    const drops = [];
    const cards = await generateConceptCards({ ai, chunks: [chunk], target: 5, onDrop: (d) => drops.push(d) });
    assert.deepEqual(cards.map((c) => c.front), ['Why sample at random?']);
    assert.deepEqual(drops.map((d) => /^gives its answer away \((\w):/.exec(d.reason)?.[1]), ['g', 'i', 'i', 'g']);
  });

  it('asks each chunk for its share of the target, by length', async () => {
    const ai = fakeAi(() => ({ cards: [] }));
    await generateConceptCards({ ai, chunks, target: 12 });
    const asked = ai.calls.map((c) => Number(/Give about (\d+) cards/.exec(c.system)[1]));
    assert.equal(asked.length, 3);
    assert.ok(asked.every((n) => n >= 2));
    assert.ok(asked.reduce((a, b) => a + b, 0) >= 12, 'a little extra is asked for, since some cards get dropped');
  });

  it('makes no call when no concept cards are needed', async () => {
    const ai = fakeAi(() => ({ cards: [] }));
    assert.deepEqual(await generateConceptCards({ ai, chunks, target: 0 }), []);
    assert.equal(ai.calls.length, 0);
  });
});

describe('the whole set', () => {
  it('mixes term cards in among the concept cards, keeping both orders', () => {
    assert.deepEqual(interleave(['T1', 'T2'], ['C1', 'C2', 'C3', 'C4']), ['T1', 'C1', 'C2', 'T2', 'C3', 'C4']);
    assert.deepEqual(interleave([], ['C1']), ['C1']);
    assert.deepEqual(interleave(['T1'], []), ['T1']);
  });

  it('seeds term cards from key terms, drops repeats of them, and caps the total', async () => {
    const chunks = chunkLesson(LESSON);
    const ai = fakeAi(() => ({
      cards: [
        concept('What is a hypothesis?', 'A testable prediction.', 'A hypothesis is a testable prediction about the relationship between two or more variables.'),
        concept('Why must a hypothesis be testable?', 'So data can prove it wrong.', 'a good hypothesis can be proven wrong by data'),
        concept('What is measured after the change?', 'The dependent variable.', 'The dependent variable is the outcome that is measured after the change.'),
        concept('Why sample at random?', 'It reduces bias.', 'It reduces bias in the results of the study.'),
        concept('Who gets a chance in random sampling?', 'Every member of the population, equally.', 'Random sampling gives every member of the population an equal chance to be chosen.'),
      ],
    }));
    const drops = [];
    const cards = await generateFlashcards({ ai, chunks, lessonText: LESSON, keyTerms: KEY_TERMS, wordCount: 80, maxCards: 5, onDrop: (d) => drops.push(d) });
    assert.equal(cards.length, 5, 'about one card per 50 words, at least 5');
    assert.deepEqual(cards.map((c) => c.kind), ['term', 'concept', 'concept', 'term', 'concept']);
    assert.ok(!cards.some((c) => c.front === 'What is a hypothesis?'));
    assert.ok(drops.some((d) => d.front === 'What is a hypothesis?' && /duplicate of "Hypothesis"/.test(d.reason)));

    const { system, user } = ai.calls[0];
    assert.match(system, /Hypothesis; Independent variable/, 'the model is told which terms already have cards');
    assert.match(user, /<review>|<lesson_text>/);
  });

  it('drops a concept card whose question holds another card’s answer', async () => {
    const chunks = chunkLesson(LESSON);
    const ai = fakeAi(() => ({
      cards: [
        concept('What does random sampling reduce?', 'Bias in the results of the study.', 'It reduces bias in the results of the study.'),
        concept('How does sampling lower bias in the results of the study?', 'Every member gets an equal chance.', 'Random sampling gives every member of the population an equal chance to be chosen.'),
        concept('Why must a hypothesis be testable?', 'So data can prove it wrong.', 'a good hypothesis can be proven wrong by data'),
      ],
    }));
    const drops = [];
    const cards = await generateFlashcards({ ai, chunks, lessonText: LESSON, wordCount: 300, maxCards: 30, onDrop: (d) => drops.push(d) });
    assert.deepEqual(cards.map((c) => c.front), ['What does random sampling reduce?', 'Why must a hypothesis be testable?']);
    assert.match(drops.find((d) => d.front.startsWith('How does sampling')).reason, /gives another card's answer away/);
  });

  it('term cards take at most half, unless there are too few concept cards to fill the set', async () => {
    const chunks = chunkLesson(LESSON);
    const names = ['Ant', 'Bee', 'Cat', 'Dog', 'Eel', 'Fox', 'Gnu', 'Hen'];
    const quotes = LESSON.split('\n').filter((line) => line.split(' ').length >= 6); // a different evidence quote per term
    const many = names.map((name, i) => ({ term: name, definition: `${name} stands for idea ${name.toLowerCase()}word.`, evidence: quotes[i % quotes.length] }));
    const none = await generateFlashcards({ ai: fakeAi(() => ({ cards: [] })), chunks, lessonText: LESSON, keyTerms: many, wordCount: 300, maxCards: 30 });
    assert.equal(none.length, 6, 'no concept cards: terms fill the set (target 6)');
    assert.ok(none.every((c) => c.kind === 'term'));
  });

  it('passes the review sections of the chunk as a guide', async () => {
    const chunks = chunkLesson(LESSON, { numbers: [1, 2, 3] });
    const ai = fakeAi(() => ({ cards: [] }));
    const sections = [
      { title: 'Hypotheses', content: 'A hypothesis predicts how variables relate.', sources: [1] },
      { title: 'Elsewhere', content: 'Not from this lesson part.', sources: [9] },
    ];
    await generateFlashcards({ ai, chunks, lessonText: LESSON, sections, wordCount: 300, maxCards: 30 });
    assert.match(ai.calls[0].user, /<review>\nHypotheses\nA hypothesis predicts how variables relate\.\n<\/review>/);
    assert.doesNotMatch(ai.calls[0].user, /Elsewhere/);
  });
});

describe('every list item and key term gets a card (the self-introduction lesson)', () => {
  it('counts the bullet items on the slides, not the notes, each once', () => {
    const items = listItems(SELF_INTRO_TEXT);
    assert.equal(items.length, 14, items.join(' | '));
    assert.ok(items.includes('Share your background, skills, and interests.'));
    assert.ok(items.includes('Authentic Tone'));
    assert.ok(!items.some((i) => /Speak or write simply/.test(i)), 'an en-dash explanation line is not an item');
    assert.deepEqual(listItems('Title\n- one\nNotes:\n- spoken aside'), ['one']);
  });

  it('the target makes room for every key term and list item', () => {
    assert.equal(targetCardCount(276, 30, { terms: 4, items: 14 }), 18, 'the old target was 6');
    assert.equal(targetCardCount(276, 12, { terms: 4, items: 14 }), 12, 'the setting still caps it');
  });

  it('an item counts as covered when a card quotes it or holds most of its words', () => {
    const cards = [
      { kind: 'concept', front: 'Which key element of a self-introduction means being honest and natural?', back: 'Authentic tone', evidence: 'Authentic Tone – Be honest and natural.' },
      { kind: 'concept', front: 'What does a self-introduction help people do?', back: 'Remember you.', evidence: 'Helps people remember you.' },
    ];
    const left = uncoveredItems(['Authentic Tone', 'Helps people remember you.', 'Builds confidence.'], cards);
    assert.deepEqual(left, ['Builds confidence.']);
  });

  it('asks ONE more call for the items no card covers, and puts those cards beside their list', async () => {
    const chunks = chunkLesson(SELF_INTRO_TEXT);
    const ai = fakeAi((label) =>
      label.includes('list items')
        ? {
            cards: [
              concept('What does giving a self-introduction build in the speaker?', 'Confidence.', 'Builds confidence.'),
              concept('Which purpose of a self-introduction is about the first impression you make?', 'Creating a positive first impression.', 'Create a positive first impression.'),
            ],
          }
        : {
            cards: [
              concept('What should you share instead of your entire life story?', 'Information that is appropriate for the situation.', 'you only share information that is appropriate for the situation'),
              concept('Which key element of a self-introduction means being honest and natural?', 'Authentic tone', 'Authentic Tone'),
            ],
          },
    );
    const cards = await generateFlashcards({ ai, chunks, lessonText: SELF_INTRO_TEXT, keyTerms: SELF_INTRO_TERMS, wordCount: 276, maxCards: 30 });
    assert.deepEqual(ai.calls.map((c) => c.label), ['the flashcards', 'the flashcards for list items without a card']);
    const asked = ai.calls[1].system;
    assert.match(asked, /Builds confidence\./);
    assert.doesNotMatch(asked, /\d+\. Authentic Tone/, 'a covered item is not asked again');
    assert.equal(cards.filter((c) => c.kind === 'term').length, 4, 'every key term has a card, Multimodal included');
    const concepts = cards.filter((c) => c.kind === 'concept').map((c) => c.front);
    assert.deepEqual(concepts, [
      'What should you share instead of your entire life story?',
      'Which purpose of a self-introduction is about the first impression you make?',
      'What does giving a self-introduction build in the speaker?',
      'Which key element of a self-introduction means being honest and natural?',
    ]);
  });

  it('keeps a card for every list item when the target is full (the lesson 9 run: two key elements were cut)', async () => {
    // 3 key terms + 14 items = a target of 17; the first call covers 12 items and adds two cards outside the lists, the
    // coverage call the last two key elements. The final trim used to keep the first 17 in lesson order, cutting those two.
    const items = listItems(SELF_INTRO_TEXT);
    const first = items.filter((i) => !/Authentic|Unique/.test(i));
    const ai = fakeAi((label) =>
      label.includes('list items')
        ? {
            cards: [
              concept('Which key element of an effective self-introduction means being honest and natural?', 'Authentic Tone', 'Authentic Tone'),
              concept('Which key element of an effective self-introduction explains what makes you different?', 'Unique Value', 'Unique Value'),
            ],
          }
        : {
            cards: [
              concept('What should you avoid telling during a self-introduction?', 'Your entire life story.', "It doesn't mean telling your entire life story."),
              concept('What kind of information should you share in a self-introduction?', 'Information that is appropriate for the situation.', 'you only share information that is appropriate for the situation'),
              ...first.map((item, n) => concept(`Which listed point of a self-introduction is number ${n + 1} on its slide?`, item, item)),
            ],
          },
    );
    const keyTerms = SELF_INTRO_TERMS.slice(0, 3);
    const cards = await generateFlashcards({ ai, chunks: chunkLesson(SELF_INTRO_TEXT), lessonText: SELF_INTRO_TEXT, keyTerms, wordCount: 278, maxCards: 30 });
    assert.deepEqual(uncoveredItems(items, cards), []);
    assert.ok(cards.some((c) => c.back === 'Your entire life story.'), 'the cards outside the lists stay');
    assert.equal(cards.filter((c) => c.kind === 'term').length, 3);
    assert.equal(cards.length, 19);
    const at = (c) => SELF_INTRO_TEXT.indexOf(c.evidence.replace(/^It doesn't mean /, ''));
    const concepts = cards.filter((c) => c.kind === 'concept');
    assert.deepEqual(concepts.map(at), [...concepts.map(at)].sort((a, b) => a - b), 'still in lesson order');
  });

  it('under the card limit, a card that is the only one for a list item wins over the others', async () => {
    const lesson = 'Topic\nPlants need light to make their food.\nNotes:\nRoots take in water from the soil.\n\nNeeds\n- Light from the bright sun\n- Water from the wet soil\n- Air around the green leaves';
    const ai = fakeAi(() => ({
      cards: [
        concept('What do plants need light for?', 'To make their food.', 'Plants need light to make their food.'),
        concept('What do roots take in?', 'Water from the soil.', 'Roots take in water from the soil.'),
        concept('Which need of a plant comes from the sun?', 'Light.', 'Light from the bright sun'),
        concept('Which need of a plant is around the leaves?', 'Air.', 'Air around the green leaves'),
      ],
    }));
    const cards = await generateFlashcards({ ai, chunks: chunkLesson(lesson), lessonText: lesson, wordCount: 30, maxCards: 3 });
    assert.equal(cards.length, 3);
    assert.deepEqual(uncoveredItems(listItems(lesson), cards), []);
    assert.ok(!cards.some((c) => c.front === 'What do plants need light for?'), 'the card outside the list gives way');
  });

  it('makes no coverage call when every item has a card', async () => {
    const lesson = 'Types\n- Alpha kind of thing\n- Beta kind of thing';
    const ai = fakeAi(() => ({ cards: [concept('Which type is the first?', 'Alpha.', 'Alpha kind of thing'), concept('Which type is the second?', 'Beta.', 'Beta kind of thing')] }));
    await generateFlashcards({ ai, chunks: chunkLesson(lesson), lessonText: lesson, wordCount: 10, maxCards: 30 });
    assert.equal(ai.calls.length, 1);
  });
});

describe('flashcards prompt', () => {
  it('keeps the lesson-only and Notes: rules, asks for short grounded answers and bans trivia', () => {
    const { system, user } = flashcardsPrompt({ text: 'Slide text', keyTerms: ['Hypothesis'], index: 0, total: 2, targetCards: 7 });
    assert.match(system, /Use ONLY the lesson text/);
    assert.match(system, /exactly "Notes:"[^]*teacher's spoken explanation of that slide/);
    assert.match(system, /at most 25 words/);
    assert.match(system, /copied EXACTLY, word for word/);
    assert.match(system, /never ask about slide titles, slide or page numbers, the author/);
    assert.match(system, /Give about 7 cards/);
    assert.match(system, /already have their own "term -> definition" cards: Hypothesis/);
    assert.match(system, /Never a yes\/no question and never an either\/or question/);
    assert.match(system, /must not contain the answer or its key words/);
    assert.match(system, /never just repeat the question's words/);
    assert.match(user, /^This is part 1 of 2 of the lesson\.\n\n<lesson_text>\nSlide text\n<\/lesson_text>$/);
  });

  it('the reply schema accepts a bare array and treats a missing evidence as empty', () => {
    // generateConceptCards' schema is internal; exercise it through a call that returns a bare array.
    const ai = fakeAi(() => [concept('Why sample at random?', 'It reduces bias.', 'It reduces bias in the results of the study.')]);
    return generateConceptCards({ ai, chunks: chunkLesson(LESSON), target: 3 }).then((cards) => assert.equal(cards.length, 1));
  });
});
