// The prompt rules from the second accuracy check of the self-introduction lesson (lesson 10): no causes or effects
// between listed items the lesson doesn't state, no rewording into a new meaning, quick checks only on what the lesson
// states (with a quote), and a reviewer that catches sets the right answer rules out and extreme caricatures.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  flashcardsPrompt,
  KEEP_MEANING,
  keyPointsPrompt,
  quickCheckReviewPrompt,
  quickChecksPrompt,
  quizReviewPrompt,
  regenerateCardPrompt,
  regenerateCardsPrompt,
  sectionsPrompt,
} from '../src/ai/prompts.js';

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

  it('a bare list item is described in plain words with the same meaning, never by its own words or its place in the list', () => {
    const { system } = flashcardsPrompt({ text: 'x', targetCards: 5 });
    assert.match(system, /When the lesson says nothing more about an item than the item itself, describe it in plain words with the same meaning, never with the item's own words/);
    assert.match(system, /Never ask by position in the list \("the first purpose", "the second element"\)/);
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

  it('keeps its flag names (the saved reviews and their hashes read them)', () => {
    for (const flag of ['card_reveals', 'not_in_lesson', 'vague', 'giveaway', 'two_correct', 'reversed', 'off_topic']) assert.match(system, new RegExp(`"${flag}"`));
  });
});
