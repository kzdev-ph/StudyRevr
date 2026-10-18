// The prompt rules from the second accuracy check of the self-introduction lesson (lesson 10): no causes or effects
// between listed items the lesson doesn't state, no rewording into a new meaning, quick checks only on what the lesson
// states (with a quote), and a reviewer that catches sets the right answer rules out and extreme caricatures.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASK_BY_MEANING,
  flashcardsPrompt,
  distractorsPrompt,
  KEEP_MEANING,
  keyPointsPrompt,
  keyTermsPrompt,
  NO_OBJECTIVES,
  NO_POSITION,
  quickCheckReviewPrompt,
  quickChecksPrompt,
  quizReviewPrompt,
  regenerateCardPrompt,
  regenerateCardsPrompt,
  sectionsPrompt,
} from '../src/ai/prompts.js';
import { CHECK_FLAGS } from '../src/services/check-review.js';
import { CARD_FLAGS, OPTION_FLAGS } from '../src/quiz/review-flags.js';

const card = { kind: 'concept', front: 'Q?', back: 'A.', evidence: 'e' };

describe('prompts keep the lesson’s meaning', () => {
  it('KEEP_MEANING forbids unstated causes between listed items and new meanings', () => {
    assert.match(KEEP_MEANING, /Never connect things the lesson only lists with a cause, effect or purpose it does not state/);
    assert.match(KEEP_MEANING, /"because", "so that", "to …", "leads to" or "helps … by" only when the lesson itself says it/);
    assert.match(KEEP_MEANING, /Listed items stay separate items: .*never write "share your background to encourage meaningful communication"/);
    assert.match(KEEP_MEANING, /Plain synonyms that keep the meaning are fine, but never reword into a new idea \("workplace readiness" adds work to "professionalism"; "fostering confidence" is not "trust"\)/);
    // lesson 11: "keep the lesson's own key words" made every question about a bare list item name its answer (rule g)
    assert.ok(!/keep the lesson's own key words/.test(KEEP_MEANING));
  });

  it('is in the sections, flashcards, both card rewrites and the quick-check rewrite', () => {
    const systems = {
      sections: sectionsPrompt({ text: 'x', summaryLength: 'short' }).system,
      flashcards: flashcardsPrompt({ text: 'x', targetCards: 5 }).system,
      regenerateConcept: regenerateCardPrompt({ card, text: 'x' }).system,
      regenerateTerm: regenerateCardPrompt({ card: { ...card, kind: 'term', front: 'Term' }, text: 'x' }).system,
      regenerateCards: regenerateCardsPrompt({ cards: [{ n: 1, ...card, problems: [] }], text: 'x' }).system,
      quickChecks: quickChecksPrompt({ checks: [{ n: 1, section: 'S', content: 'c', question: 'q', answer: 'a', evidence: 'e', why: 'w' }], text: 'x' }).system,
    };
    for (const [name, system] of Object.entries(systems)) assert.ok(system.includes(KEEP_MEANING), name);
  });

  it('key points: only a cause and effect the text states, never two listed items merged with an invented link', () => {
    const { system } = keyPointsPrompt({ text: 'x', index: 0, total: 1 });
    assert.match(system, /a cause and effect the text states/);
    assert.match(system, /Never merge two listed items into one point that joins them with a cause or purpose the text does not state/);
    assert.match(system, /never "workplace readiness" for "professionalism"/);
  });

  it('flashcards ask "why" only when the lesson gives the reason', () => {
    const { system } = flashcardsPrompt({ text: 'x', targetCards: 5 });
    assert.match(system, /a cause and effect the lesson states/);
    assert.match(system, /"why" only when the lesson gives the reason/);
    assert.ok(!/Ask "why", "how", "what"/.test(system));
  });

  it('a bare list item is split (verb in the question, the rest in the answer), never described by synonyms or its place in the list', () => {
    const { system } = flashcardsPrompt({ text: 'x', targetCards: 5 });
    assert.match(system, /When the lesson says nothing more about an item than its name, never describe it with synonyms/);
    assert.match(system, /Split the item instead: keep its verb or frame in the question and put the rest in the answer \("What does the collected data help researchers test\?" -> "Hypotheses"\)/);
    assert.ok(!/describe it in plain words with the same meaning/.test(system));
    assert.match(system, /Never ask by position in the list \("the first purpose", "the second element"\)/);
  });

  it('a "Name — description" line asks the description, the whole lesson is covered, and four made-up examples show it (Gemini audit)', () => {
    const { system } = flashcardsPrompt({ text: 'x', targetCards: 5, keyTerms: ['Term'] });
    assert.match(system, /When a lesson line is "Name — what it means"[^]*answer with the description[^]*never the reverse/);
    assert.match(system, /Cover the whole lesson: every slide that teaches something gets at least one card/);
    assert.match(system, /Never ask two cards about the same fact\.\n\nExamples of good and bad cards \(made-up topics, not this lesson\):/);
    assert.equal((system.match(/^- (?:Lesson|Bad)/gm) ?? []).length, 4);
    assert.match(ASK_BY_MEANING, /plus a word of the answer or a synonym of it/);
    // the examples are for writing cards, not for the single-card rewrites
    assert.ok(!regenerateCardPrompt({ card: { kind: 'concept', front: 'Q?', back: 'A.', evidence: 'e' }, text: 'x' }).system.includes('Examples of good and bad cards'));
  });
});

describe('quick checks', () => {
  it('the sections prompt asks only what the lesson states, with a quote per check', () => {
    const { system } = sectionsPrompt({ text: 'x', summaryLength: 'short' });
    assert.match(system, /quick questions whose answer this section's lesson text states itself/);
    assert.match(system, /Ask "why" or "how does X cause Y" only when the lesson states that reason or way in its own words/);
    assert.match(system, /"evidence": one sentence or phrase copied EXACTLY, word for word, from the lesson text/);
    assert.match(system, /"check_questions":\[\{"question":"...","answer":"...","evidence":"..."\}\]/);
    assert.ok(!/\(why \/ how \/ what\)/.test(system));
  });

  it('the review prompt lists each section’s checks with their quotes and the three flags', () => {
    const { system, user } = quickCheckReviewPrompt({ sections: [{ n: 1, title: 'Importance', content: 'line one\nline two', checks: [{ q: 1, question: 'Q?', answer: 'A.', evidence: 'quote' }] }], text: 'lesson' });
    for (const flag of ['not_in_lesson', 'not_answered', 'vague']) assert.match(system, new RegExp(`"${flag}"`));
    assert.match(system, /a reason, cause, effect or purpose connecting things the lesson only lists/);
    assert.match(user, /\[1\] Section: Importance\n {4}Section text: line one \/ line two\n {4}q1: Question: Q\?\n {8}Answer: A\.\n {8}From the lesson: "quote"/);
    assert.match(user, /<lesson_text>\nlesson\n<\/lesson_text>/);
  });
});

describe('the exam reviewer', () => {
  const { system } = quizReviewPrompt({ items: [], text: 'x' });

  it('flags a set the right answer rules out by itself, and extreme caricatures', () => {
    assert.match(system, /or the right answer rules the others out by itself \(it says "relevant" or "brief" and they say "all details" or "everything"\)/);
    assert.match(system, /a silly caricature or extreme that nobody would pick \("all details", "everything", "always", "as long as possible", "loudly and formally"\)/);
  });

  it('allows a one-word echo of the question (rule b), and widens not_in_lesson to invented causes and new meanings', () => {
    assert.match(system, /The right answer repeating ONE word of the question is allowed: never flag a set for that alone\./);
    assert.match(system, /a cause, effect or purpose connecting things the lesson only lists, or a rewording with a new meaning \("workplace readiness" for "professionalism"\)/);
  });

  it('teaches two_correct by meaning with invented examples, and keeps the sibling-item exemption', () => {
    assert.match(system, /Judge by meaning, not by words/);
    assert.match(system, /would a student who knows the lesson be wrong to pick this\?/);
    for (const example of [/Thermograph[^]*"Data logger"[^]*two_correct/, /compost help a garden[^]*improves the soil[^]*two_correct/, /drawback of cycling[^]*take longer[^]*two_correct/]) assert.match(system, example);
    assert.match(system, /never flag it as "off_topic" or "two_correct" only because it is in the lesson or about the same subject/);
    // the lessons we grade stay unseen: none of their words in the prompt
    for (const word of ['RSCH2120', 'Longitudinal', 'Panel Studies', 'Cross-Sectional', 'GNMT', 'translat', 'everyday lives', 'Nature of Inquiry', 'interlingua']) assert.ok(!system.includes(word), word);
  });

  it('never calls an option off_topic when its text is in the lesson', () => {
    assert.match(system, /An option whose text appears in the lesson \(even word for word\) is NEVER "off_topic"/);
  });

  it('keeps its flag names (the saved reviews and their hashes read them)', () => {
    for (const flag of ['card_reveals', 'not_in_lesson', 'vague', 'giveaway', 'two_correct', 'reversed', 'off_topic']) assert.match(system, new RegExp(`"${flag}"`));
  });
});

describe('leftover fixes from the lesson 12 check', () => {
  const cards = [{ id: 1, kind: 'concept', front: 'Q?', back: 'A.', evidence: 'e', wordCount: 1, language: 'en' }];

  it('no prompt that writes a question lets it ask by place in a list', () => {
    assert.match(NO_POSITION, /Never ask by position in a list/);
    const prompts = {
      sections: sectionsPrompt({ text: 'x', summaryLength: 'short' }).system,
      checks: quickChecksPrompt({ checks: [{ n: 1, title: 'T', question: 'Q?', answer: 'A.', why: 'w' }], text: 'x' }).system,
      regenerate: regenerateCardPrompt({ card, problems: [], text: 'x' }).system,
      regenerateMany: regenerateCardsPrompt({ cards: [{ n: 1, ...card, problems: [] }], text: 'x' }).system,
      distractors: distractorsPrompt({ cards }).system,
    };
    for (const [name, system] of Object.entries(prompts)) assert.ok(system.includes(NO_POSITION), name);
  });

  it('both reviewers flag a question that asks by place in a list as vague', () => {
    assert.match(quizReviewPrompt({ items: [], text: 'x' }).system, /place in a list/);
    assert.match(quickCheckReviewPrompt({ sections: [], text: 'x' }).system, /place in a list/);
  });

  it('wrong answers and the reviewer both rule out the opposite of the right answer', () => {
    assert.match(distractorsPrompt({ cards }).system, /Never the opposite or mirror image of the correct answer[^]*"Builds confidence", "Creates anxiety"/);
    assert.match(quizReviewPrompt({ items: [], text: 'x' }).system, /given the opposite meaning, even with no negative word/);
  });

  it('quotes end where a sentence or clause ends: 25 words for cards, 40 for quick checks', () => {
    assert.match(sectionsPrompt({ text: 'x', summaryLength: 'short' }).system, /at most 40 words, ending where a sentence or clause ends, never in the middle of a phrase/);
    assert.match(quickChecksPrompt({ checks: [], text: 'x' }).system, /at most 40 words/);
    assert.match(regenerateCardPrompt({ card, problems: [], text: 'x' }).system, /at most 25 words, ending where a sentence or clause ends/);
    assert.match(flashcardsPrompt({ text: 'x', review: [], targetCards: 5, index: 1, total: 1 }).system, /at most 25 words, ending where a sentence or clause ends/);
  });

  it('the card reviewer must answer for every item', () => {
    assert.match(quizReviewPrompt({ items: [], text: 'x' }).system, /exactly one entry for EVERY item[^]*Do not leave an item out/);
  });
});

describe('prompts never build questions from learning objectives', () => {
  const cards = [{ n: 1, question: 'Q?', answer: 'A.', evidence: 'e', wordCount: 1, language: 'en' }];
  it('every prompt that writes a question, card, key point, term or wrong answer carries NO_OBJECTIVES (the rewrites keep to the card’s own evidence)', () => {
    assert.match(NO_OBJECTIVES, /learning objectives/);
    assert.match(NO_OBJECTIVES, /at the end of this lesson/);
    assert.match(NO_OBJECTIVES, /outline/);
    assert.match(NO_OBJECTIVES, /agenda/);
    for (const [name, system] of Object.entries({
      sections: sectionsPrompt({ text: 'x', summaryLength: 'short' }).system,
      keyPoints: keyPointsPrompt({ text: 'x', index: 0, total: 1 }).system,
      keyTerms: keyTermsPrompt({ text: 'x', index: 0, total: 1, maxTerms: 5 }).system,
      flashcards: flashcardsPrompt({ text: 'x', index: 0, total: 1, targetCards: 5 }).system,
      distractors: distractorsPrompt({ cards }).system,
      quickChecks: quickChecksPrompt({ checks: [], text: 'x' }).system,
    })) {
      assert.match(system, /learning objectives/, name);
    }
  });

  it('card-writing prompts tell the model to ask by meaning, not by a "regarding" tail', () => {
    assert.match(ASK_BY_MEANING, /regarding \/ related to \/ concerning/);
    assert.match(flashcardsPrompt({ text: 'x', index: 0, total: 1, targetCards: 5, items: ['A'] }).system, /regarding \/ related to \/ concerning/);
    assert.match(regenerateCardPrompt({ card, text: 'x' }).system, /regarding \/ related to \/ concerning/);
  });

  it('the distractor prompt forbids synonym rewordings and absolute words', () => {
    assert.match(distractorsPrompt({ cards }).system, /swapping words for synonyms/);
    assert.match(distractorsPrompt({ cards }).system, /absolute word/);
  });

  it('both reviewers flag a question made from objectives as off_topic', () => {
    assert.match(quizReviewPrompt({ items: [], text: 'x' }).system, /"off_topic": the card is made from the lesson's learning objectives/);
    assert.match(quickCheckReviewPrompt({ sections: [], text: 'x' }).system, /"off_topic": the question is made from the lesson's learning objectives/);
    assert.ok(CARD_FLAGS.includes('off_topic'));
    assert.ok(CHECK_FLAGS.includes('off_topic'));
    assert.ok(OPTION_FLAGS.includes('off_topic'));
  });
});
