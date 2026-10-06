import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bestLine, elapsed, formatDuration, lessonQuizLine, percent, questionLead, questionText, quizKeyAction, scoreLine } from '../src/lib/quiz.js';

const key = (k, extra = {}) => ({ key: k, target: { tagName: 'BODY' }, ...extra });

describe('quiz keys', () => {
  it('1-4 pick an option while a question is open, only up to the number of options', () => {
    assert.equal(quizKeyAction(key('1'), { phase: 'question', optionCount: 4 }), 0);
    assert.equal(quizKeyAction(key('4'), { phase: 'question', optionCount: 4 }), 3);
    assert.equal(quizKeyAction(key('3'), { phase: 'question', optionCount: 2 }), null, 'true / false has two');
    assert.equal(quizKeyAction(key('0'), { phase: 'question', optionCount: 4 }), null);
  });
  it('numbers do nothing once answered; Enter goes on', () => {
    assert.equal(quizKeyAction(key('2'), { phase: 'feedback', optionCount: 4 }), null);
    assert.equal(quizKeyAction(key('Enter'), { phase: 'feedback' }), 'next');
    assert.equal(quizKeyAction(key('Enter'), { phase: 'question', optionCount: 4 }), null);
    assert.equal(quizKeyAction(key('Enter'), { phase: 'results' }), null);
  });
  it('leaves Enter on a focused button to the browser, and ignores form fields and modifiers', () => {
    assert.equal(quizKeyAction(key('Enter', { target: { tagName: 'BUTTON' } }), { phase: 'feedback' }), null);
    assert.equal(quizKeyAction(key('1', { target: { tagName: 'INPUT' } }), { phase: 'question', optionCount: 4 }), null);
    assert.equal(quizKeyAction(key('1', { ctrlKey: true }), { phase: 'question', optionCount: 4 }), null);
    assert.equal(quizKeyAction(key('1', { target: { tagName: 'BUTTON' } }), { phase: 'question', optionCount: 4 }), 0, 'a number still answers with an option focused');
  });
});

describe('quiz wording', () => {
  it('says what kind of question it is', () => {
    assert.equal(questionLead({ type: 'mc', kind: 'term' }), 'Which term matches this description?');
    assert.equal(questionLead({ type: 'mc', kind: 'concept' }), 'Choose the best answer');
    assert.equal(questionLead({ type: 'tf', kind: 'concept' }), 'True or false?');
  });
  it('spells a true / false question out in one sentence', () => {
    assert.equal(questionText({ type: 'tf', kind: 'term', question: 'Sample', statement: 'Part of the population.' }), 'Sample means: Part of the population.');
    assert.equal(questionText({ type: 'tf', kind: 'concept', question: 'Why sample?', statement: 'To save time.' }), 'Why sample? Answer: To save time.');
    assert.equal(questionText({ type: 'mc', kind: 'concept', question: 'Why sample?' }), 'Why sample?');
  });
  it('scores and durations', () => {
    assert.equal(scoreLine(8, 10), '8 of 10 right');
    assert.equal(percent(2, 3), 67);
    assert.equal(percent(0, 0), 0);
    assert.equal(formatDuration(44_600), '45 s');
    assert.equal(formatDuration(125_000), '2 min 5 s');
    assert.equal(formatDuration(120_000), '2 min');
    assert.equal(formatDuration(-5), '0 s');
  });
  it('compares with the best earlier score', () => {
    assert.equal(bestLine(70, null), 'Your first score on this lesson.');
    assert.equal(bestLine(90, 80), 'New best! Your previous best was 80%.');
    assert.equal(bestLine(80, 80), 'Your best on this lesson: 80%.');
  });
  it('describes a lesson row', () => {
    assert.equal(lessonQuizLine({ attempts: 0, questions: 10 }), '10 questions · not taken yet');
    assert.equal(lessonQuizLine({ attempts: 0, questions: 1 }), '1 question · not taken yet');
    assert.equal(lessonQuizLine({ attempts: 0, questions: 0 }), '');
    assert.equal(lessonQuizLine({ attempts: 3, best: { score: 8, total: 10, percent: 80 } }), 'Best 8/10 (80%) · 3 attempts');
  });
});

describe('quiz timing', () => {
  it('measures time on a question from a fake clock, never negative', () => {
    let now = 1_000;
    const clock = () => now;
    const shown = clock();
    now += 4_250.4;
    assert.equal(elapsed(shown, clock()), 4250);
    assert.equal(elapsed(5_000, 4_000), 0);
  });
});
