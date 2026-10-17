import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/flashcards/scheduler.js';
import { buildQuiz, quizCandidates, usableCount } from '../src/quiz/build.js';
import { maskTerm } from '../src/quiz/leaks.js';
import { listGroups, siblingItems } from '../src/quiz/list-items.js';
import { relatedTerms, usableFamilies } from '../src/quiz/related.js';
import { SELF_INTRO_TERMS, SELF_INTRO_TEXT } from './fixtures/self-intro.js';
import { cardHash, readReview } from '../src/quiz/review-flags.js';

// The self-introduction lesson: "Self-Introduction" and its three kinds. A written self-introduction IS a
// self-introduction, so "Self-Introduction" must never be the wrong answer for the written kind's definition (the
// accuracy check found that marked wrong), and the kinds must never be wrong options for the general definition.
const term = (id, front, back) => ({ id, kind: 'term', front, back, evidence: `${front} quote` });
const SELF = term(1, 'Self-Introduction', 'A brief presentation of yourself that helps others know who you are.');
const WRITTEN = term(2, 'Written Self-Introduction', 'A presentation of yourself in written form.');
const ORAL = term(3, 'Oral Self-Introduction', 'A presentation of yourself spoken directly to an audience.');
const MULTI = 'Multimodal Self-Introduction'; // a key term without a card of its own
const CARDS = [SELF, WRITTEN, ORAL];
const EXTRA = ['Self-Introduction', 'Written Self-Introduction', 'Oral Self-Introduction', MULTI];
const UNRELATED = [term(4, 'Authentic Tone', 'Being honest and natural.'), term(5, 'Unique Value', 'What makes you different or what you can contribute.')];

const byId = (candidates, id) => candidates.find((p) => p.card.id === id);

describe('related terms', () => {
  it('a term and a term that holds it are related, in either order, ignoring case, hyphens and plurals', () => {
    assert.ok(relatedTerms('Self-Introduction', 'Written Self-Introduction'));
    assert.ok(relatedTerms('written self introductions', 'Self-Introduction'));
    assert.ok(relatedTerms('Cell', 'Cell membrane'));
  });

  it('sibling kinds and unrelated terms are not related by wording alone', () => {
    assert.ok(!relatedTerms('Written Self-Introduction', 'Oral Self-Introduction'));
    assert.ok(!relatedTerms('Independent variable', 'Dependent variable'));
    assert.ok(!relatedTerms('Self-Introduction', 'Authentic Tone'));
    assert.ok(!relatedTerms('Data', 'Database')); // whole words only
  });

  it('terms the AI review put in one family are related', () => {
    const families = [['Written Self-Introduction', 'Oral Self-Introduction', 'Multimodal Self-Introduction']];
    assert.ok(relatedTerms('Oral Self-Introduction', 'Multimodal Self-Introduction', families));
    assert.ok(!relatedTerms('Oral Self-Introduction', 'Authentic Tone', families));
  });
});

describe('quiz building leaves related terms out', () => {
  it('the general term is never a wrong option or false statement for one of its kinds, nor the kinds for it', () => {
    const candidates = quizCandidates(CARDS, { extraTerms: EXTRA });
    for (const kind of [WRITTEN, ORAL]) {
      const p = byId(candidates, kind.id);
      assert.ok(!p.mcWrong.includes('Self-Introduction'), `${kind.front}: Self-Introduction is not wrong`);
      assert.ok(!p.falseClean.includes(SELF.back), `${kind.front}: the general definition fits it too`);
      assert.ok(p.excluded.some((x) => x.rule === 'r' && x.text === 'Self-Introduction'));
    }
    const general = byId(candidates, SELF.id);
    assert.deepEqual(general.mcWrong, [], 'every other term here is a kind of self-introduction');
    assert.deepEqual(general.falseClean, []);
  });

  it('sibling kinds still face each other, including a key term without a card', () => {
    const p = byId(quizCandidates(CARDS, { extraTerms: EXTRA }), WRITTEN.id);
    assert.deepEqual(p.mcWrong.sort(), [MULTI, 'Oral Self-Introduction'].sort());
    assert.deepEqual(p.falseClean, [ORAL.back]);
  });

  it('with the AI family, siblings are left out too', () => {
    const termFamilies = [['Written Self-Introduction', 'Oral Self-Introduction', 'Multimodal Self-Introduction']];
    const p = byId(quizCandidates([...CARDS, ...UNRELATED], { extraTerms: EXTRA, termFamilies }), WRITTEN.id);
    assert.deepEqual(p.mcWrong.sort(), ['Authentic Tone', 'Unique Value']);
    assert.deepEqual(p.falseClean.sort(), [UNRELATED[0].back, UNRELATED[1].back].sort());
  });

  it('no quiz question ever offers a related term or a related definition as wrong', () => {
    const cards = [...CARDS, ...UNRELATED];
    for (let seed = 1; seed <= 40; seed++) {
      for (const q of buildQuiz({ cards, extraTerms: EXTRA, random: createRng(seed), count: 5 })) {
        const asked = cards.find((c) => c.id === q.flashcard_id);
        if (q.type === 'mc') {
          for (const choice of q.choices) if (choice !== asked.front) assert.ok(!relatedTerms(asked.front, choice), `${asked.front} offered ${choice}`);
        } else if (q.answer_index === 1) {
          const owner = cards.find((c) => maskTerm(c.back, c.front) === q.statement);
          assert.ok(owner && !relatedTerms(asked.front, owner.front), `${asked.front} used ${owner?.front}'s definition`);
        }
      }
    }
  });

  it('a blanked definition is never a Yes/No false statement (lesson 10: "This is presented in ___ form.")', () => {
    // lesson 10's term cards as made: only Written's definition names its own term
    const written = term(147, 'Written Self-Introduction', 'This is presented in written form.');
    const oral = term(152, 'Oral Self-Introduction', 'This is spoken directly to an audience.');
    const multi = term(157, 'Multimodal Self-Introduction', 'It combines different ways of communicating.');
    const cards = [term(142, 'Self-Introduction', 'It is a brief presentation of yourself that helps others know who you are.'), written, oral, multi];
    const candidates = quizCandidates(cards, { extraTerms: cards.map((c) => c.front) });
    for (const p of candidates) {
      for (const s of [...p.falsePool, ...p.falseClean, ...p.reviewable]) assert.ok(!s.includes('___'), `#${p.card.id} offered "${s}"`);
    }
    assert.deepEqual(byId(candidates, oral.id).falseClean, [multi.back]);
    assert.deepEqual(byId(candidates, multi.id).falseClean, [oral.back]);
    const w = byId(candidates, written.id);
    assert.equal(w.shown, 'This is presented in ___ form.', 'its own question still shows the blank');
    assert.deepEqual(w.falseClean.sort(), [oral.back, multi.back].sort(), 'it is still asked, against unblanked definitions');
    for (let seed = 1; seed <= 30; seed++) {
      for (const q of buildQuiz({ cards, extraTerms: cards.map((c) => c.front), random: createRng(seed), count: 4 })) {
        if (q.type === 'tf' && q.answer_index === 1) assert.ok(!q.statement.includes('___'), `seed ${seed}: "${q.statement}"`);
      }
    }
  });

  it('a lesson of only related terms asks none of them rather than a question with two right answers', () => {
    assert.equal(usableCount([SELF, WRITTEN], { extraTerms: ['Self-Introduction', 'Written Self-Introduction'] }), 0);
  });
});

describe('quiz building reads the AI review', () => {
  const concept = { id: 20, kind: 'concept', front: 'Which key element of a self-introduction means being honest and natural?', back: 'Authentic tone', evidence: 'Authentic Tone' };
  const distractors = new Map([[20, ['Speaking volume', 'Relevant information', 'Unique value', 'Clear and concise language']]]);
  const review = (fields) =>
    new Map([[20, readReview({ card_hash: cardHash(concept), card_flags: '[]', set_flags: '[]', true_flags: '[]', option_flags: '{}', round: 1, ...fields })]]);

  it('a flagged wrong option is not shown', () => {
    const reviews = review({ option_flags: JSON.stringify({ 'Speaking volume': [{ flag: 'giveaway', why: 'a caricature' }] }) });
    const p = quizCandidates([concept], { distractors, reviews })[0];
    assert.ok(!p.mcClean.includes('Speaking volume'));
    assert.deepEqual(p.mcClean, [], 'a set holds 3 wrong answers: with one flagged it is asked as Yes/No until the review remakes it');
    assert.ok(p.falseClean.length > 0 && !p.falseClean.includes('Speaking volume'));
    assert.ok(p.excluded.some((x) => x.rule === 'ai' && x.text === 'Speaking volume'));
  });

  it('a flagged card is not asked at all', () => {
    const reviews = review({ card_flags: JSON.stringify([{ flag: 'not_in_lesson', why: 'adds a word' }]) });
    assert.equal(usableCount([concept], { distractors, reviews }), 0);
  });

  it('a flagged set is not multiple choice and a flagged true statement is not Yes/No', () => {
    const set = quizCandidates([concept], { distractors, reviews: review({ set_flags: JSON.stringify([{ flag: 'giveaway' }]) }) })[0];
    assert.deepEqual(set.mcClean, []);
    assert.ok(set.falseClean.length > 0);
    const tf = quizCandidates([concept], { distractors, reviews: review({ true_flags: JSON.stringify([{ flag: 'giveaway' }]) }) })[0];
    assert.deepEqual(tf.falseClean, []);
    assert.equal(tf.mcClean.length, 3);
  });

  it('a review of the card’s old text is ignored once the card is written again', () => {
    const reviews = review({ card_flags: JSON.stringify([{ flag: 'vague' }]) });
    const rewritten = { ...concept, back: 'An authentic tone' };
    assert.equal(usableCount([rewritten], { distractors, reviews }), 1);
  });
});

describe('list-item cards', () => {
  const concept = (id, front, back) => ({ id, kind: 'concept', front, back, evidence: back });
  const groups = listGroups(SELF_INTRO_TEXT);

  it('reads each slide list (3 items or more, bullets only, not the dash sub-lines or the notes)', () => {
    assert.equal(groups.length, 3);
    assert.deepEqual(groups[0], ['Introduce yourself clearly.', 'Create a positive first impression.', 'Build relationships and trust.', 'Share your background, skills, and interests.', 'Encourage meaningful communication.']);
    assert.deepEqual(groups[2], ['Clear and Concise Language', 'Relevant Information', 'Authentic Tone', 'Unique Value']);
    assert.deepEqual(siblingItems(groups, 'authentic tone'), ['Clear and Concise Language', 'Relevant Information', 'Unique Value'], 'case and a full stop ignored');
    assert.equal(siblingItems(groups, 'Being authentic'), null, 'no fuzzy match');
  });

  it('a list item is asked with the other items of its list as options, and none of them is AI-made', () => {
    const cards = [
      concept(11, 'Which key element of an effective self-introduction means being honest and natural?', 'Authentic Tone'),
      concept(12, 'Which key element of an effective self-introduction means sharing what makes you different?', 'Unique Value'),
      concept(13, 'Which purpose of a self-introduction helps establish connection and reliability with others?', 'Build relationships and trust.'),
    ];
    const distractors = new Map([[11, ['Genuine voice', 'Sincere expression', 'Real attitude']]]);
    const candidates = quizCandidates(cards, { distractors, lessonText: SELF_INTRO_TEXT });
    const tone = byId(candidates, 11);
    assert.deepEqual(tone.mcClean.sort(), ['Clear and Concise Language', 'Relevant Information', 'Unique Value'], 'the saved AI options are not used');
    assert.ok(tone.falseClean.includes('Unique Value'), 'another item is a fair "No" (it is also the answer of another card)');
    const trust = byId(candidates, 13);
    assert.equal(trust.mcClean.length, 3);
    assert.ok(trust.mcClean.every((o) => groups[0].includes(o)));
    for (let seed = 1; seed <= 20; seed++) {
      for (const q of buildQuiz({ cards, distractors, lessonText: SELF_INTRO_TEXT, random: createRng(seed) })) {
        assert.ok(![...q.choices, q.statement].includes('Genuine voice'), `seed ${seed}`);
      }
    }
  });
});

describe('term families from the review', () => {
  const names = SELF_INTRO_TERMS.map((t) => t.term);
  it('drops a term grouped with its own kinds, and kinds of one thing grouped together', () => {
    assert.deepEqual(usableFamilies([names]), [], 'what the reviewer returned for this lesson');
    assert.deepEqual(usableFamilies([names.slice(1)]), [], 'Written / Oral / Multimodal mean different things');
    assert.deepEqual(usableFamilies([['Authentic Tone', 'Genuine Voice']]), [['Authentic Tone', 'Genuine Voice']], 'synonyms stay');
  });
  it('so the kinds stay wrong options for each other', () => {
    const cards = [WRITTEN, ORAL, term(6, 'Multimodal Self-Introduction', 'A presentation of yourself that combines different ways of communicating.'), ...UNRELATED];
    const families = usableFamilies([names]);
    const written = byId(quizCandidates(cards, { termFamilies: families }), 2);
    assert.ok(written.mcWrong.includes('Oral Self-Introduction') && written.mcWrong.includes('Multimodal Self-Introduction'));
  });
});
