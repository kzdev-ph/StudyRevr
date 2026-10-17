import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/flashcards/scheduler.js';
import { buildQuiz, normalizeTrailing, quizCandidates, reshuffle } from '../src/quiz/build.js';

const seeded = (seed = 1) => createRng(seed);

describe('trailing punctuation never tells options apart', () => {
  it('takes the full stop off every text when only some end in one', () => {
    assert.deepEqual(normalizeTrailing(['Hypotheses.', 'Attitudes', 'Opinions', 'Behaviors']), ['Hypotheses', 'Attitudes', 'Opinions', 'Behaviors']);
    assert.deepEqual(normalizeTrailing(['Attitudes', 'Opinions.', 'Behaviors.', 'Hypotheses']), ['Attitudes', 'Opinions', 'Behaviors', 'Hypotheses']);
  });

  it('leaves texts alone when they all agree', () => {
    const stops = ['Numerical data.', 'Opinions.', 'Behaviors.', 'Records.'];
    const none = ['Numerical data', 'Opinions', 'Behaviors', 'Records'];
    assert.deepEqual(normalizeTrailing(stops), stops);
    assert.deepEqual(normalizeTrailing(none), none);
  });

  it('handles a lone ellipsis or colon the same way, and each mark on its own', () => {
    assert.deepEqual(normalizeTrailing(['Waiting…', 'Opinions', 'Behaviors', 'Records']), ['Waiting', 'Opinions', 'Behaviors', 'Records']);
    assert.deepEqual(normalizeTrailing(['Waiting...', 'Opinions', 'Behaviors', 'Records']), ['Waiting', 'Opinions', 'Behaviors', 'Records']);
    assert.deepEqual(normalizeTrailing(['The causes:', 'Opinions', 'Behaviors', 'Records']), ['The causes', 'Opinions', 'Behaviors', 'Records']);
    // a stop on one and an ellipsis on another are two different disagreements: both marks go
    assert.deepEqual(normalizeTrailing(['One.', 'Two…', 'Three', 'Four']), ['One', 'Two', 'Three', 'Four']);
    // a stop only on the others leaves a lone colon's agreeing group alone
    assert.deepEqual(normalizeTrailing(['One:', 'Two:', 'Three:', 'Four:']), ['One:', 'Two:', 'Three:', 'Four:']);
  });

  it('keeps an inner full stop and an ellipsis is not a full stop', () => {
    assert.deepEqual(normalizeTrailing(['Use e.g. surveys.', 'Interviews', 'Archives', 'Notes']), ['Use e.g. surveys', 'Interviews', 'Archives', 'Notes']);
    assert.deepEqual(normalizeTrailing(['Wait...', 'Rest…', 'Stop.', 'Go']), ['Wait', 'Rest', 'Stop', 'Go']);
  });

  it('does nothing when taking a mark off would make two different texts the same or leave nothing', () => {
    assert.deepEqual(normalizeTrailing(['Errors.', 'Errors', 'Bias', 'Noise']), ['Errors.', 'Errors', 'Bias', 'Noise']);
    assert.deepEqual(normalizeTrailing(['...', 'Opinions', 'Behaviors', 'Records']), ['...', 'Opinions', 'Behaviors', 'Records']);
  });

  // lesson 33, card "What do researchers check against collected data?": the right answer was the only option with a stop
  const hypotheses = { id: 1, kind: 'concept', front: 'What do researchers check against collected data?', back: 'Hypotheses.', evidence: 'Test hypotheses' };
  const others = [
    { id: 2, kind: 'concept', front: 'What do researchers arrive at using collected data?', back: 'Conclusions.', evidence: 'Draw conclusions' },
    { id: 3, kind: 'concept', front: 'What does data collection involve in research?', back: 'Gathering information from various sources.', evidence: 'It involves gathering information from various sources.' },
  ];
  const distractors = new Map([[1, ['Attitudes', 'Opinions', 'Behaviors']]]);
  const options = { distractors, extraTerms: [], lessonText: 'Test hypotheses\nDraw conclusions\nOpinions\nAttitudes\nBehaviors\nIt involves gathering information from various sources.' };
  const forms = (cards, random, opts = options) => buildQuiz({ cards, random, ...opts }).filter((q) => q.flashcard_id === 1);

  it('lesson 33: a multiple-choice question shows no full stop on the right answer, and the stored card keeps it', () => {
    const cards = [hypotheses, ...others];
    const before = JSON.parse(JSON.stringify({ cards, distractors: [...distractors] }));
    assert.equal(quizCandidates(cards, options)[0].mcClean.length, 3, 'the card is asked as multiple choice');
    let asked = 0;
    for (let seed = 1; seed <= 40; seed++) {
      for (const q of forms(cards, seeded(seed)).filter((x) => x.type === 'mc')) {
        asked++;
        assert.ok(q.choices.every((c) => !/\.$/.test(c)), q.choices.join(' | '));
        assert.equal(q.answer_text, 'Hypotheses');
        assert.equal(q.choices[q.answer_index], 'Hypotheses');
        assert.deepEqual([...q.choices].sort(), ['Attitudes', 'Behaviors', 'Hypotheses', 'Opinions']);
        // a retake keeps it
        const again = reshuffle([q], seeded(seed + 100))[0];
        assert.ok(again.choices.every((c) => !/\.$/.test(c)));
        assert.equal(again.choices[again.answer_index], 'Hypotheses');
      }
    }
    assert.ok(asked > 0);
    assert.deepEqual(JSON.parse(JSON.stringify({ cards, distractors: [...distractors] })), before, 'cards and saved wrong answers are unchanged');
  });

  it('lesson 33: a Yes/No statement, true or false, carries no stop either, and matches the stored answer when true', () => {
    // 'Hypotheses.' against 'Attitudes' etc.: force Yes/No by giving the card only two wrong answers
    const two = { ...options, distractors: new Map([[1, ['Attitudes', 'Opinions']]]) };
    const seen = new Set();
    for (let seed = 1; seed <= 60; seed++) {
      for (const q of forms([hypotheses, ...others], seeded(seed), two)) {
        assert.equal(q.type, 'tf');
        assert.ok(!/\.$/.test(q.statement), q.statement);
        assert.ok(!/\.$/.test(q.answer_text), q.answer_text);
        seen.add(q.answer_index === 0 ? 'true' : 'false');
        if (q.answer_index === 0) assert.equal(q.statement, q.answer_text);
        else assert.notEqual(q.statement, q.answer_text);
      }
    }
    assert.deepEqual([...seen].sort(), ['false', 'true']);
  });

  it('a question whose options already agree is built exactly as before', () => {
    const sentence = { ...hypotheses, back: 'Test hypotheses.' };
    const same = { ...options, distractors: new Map([[1, ['Attitudes.', 'Opinions.', 'Behaviors.']]]) };
    for (let seed = 1; seed <= 20; seed++) {
      for (const q of forms([sentence, ...others], seeded(seed), same).filter((x) => x.type === 'mc')) {
        assert.ok(q.choices.every((c) => /\.$/.test(c)), q.choices.join(' | '));
        assert.equal(q.answer_text, 'Test hypotheses.');
      }
    }
  });
});
