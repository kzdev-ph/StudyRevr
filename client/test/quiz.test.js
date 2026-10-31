import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as quiz from '../src/lib/quiz.js';
import { bestLine, capitalFirst, elapsed, formatDuration, lessonQuizLine, lowerFirst, percent, questionLead, questionText, quizKeyAction, scoreLine, tfStatement } from '../src/lib/quiz.js';

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
    assert.equal(questionLead({ type: 'tf', kind: 'term' }), 'True or False');
    assert.equal(questionLead({ type: 'tf', kind: 'concept' }), 'True or False');
  });
  it('writes a true / false question as one statement', () => {
    assert.equal(tfStatement({ type: 'tf', kind: 'term', question: 'Sampling', statement: 'Picking part of a population to study' }), 'Sampling means picking part of a population to study.');
    assert.equal(tfStatement({ type: 'tf', kind: 'concept', question: 'Why sample?', statement: 'to save time' }), 'Why sample? To save time.');
    assert.equal(questionText({ type: 'tf', kind: 'term', question: 'Sample', statement: 'The part of the population.' }), 'Sample means the part of the population.');
    const tf = { type: 'tf', kind: 'concept', question: 'Why sample?', statement: 'to save time' };
    assert.equal(questionText(tf), tfStatement(tf));
  });
  it('shows an AI sentence pair (statement form) as the sentence alone, not joined to the card question', () => {
    const q = { type: 'tf', kind: 'concept', form: 'statement', question: 'Why sample?', statement: 'sampling saves time' };
    assert.equal(tfStatement(q), 'Sampling saves time.');
    assert.equal(tfStatement({ ...q, statement: 'Sampling saves time!' }), 'Sampling saves time!');
    assert.equal(questionText(q), 'Sampling saves time.');
  });
  it('lowers the first letter only after a common opener or an -ing word', () => {
    assert.equal(lowerFirst('The sample.'), 'the sample.');
    assert.equal(lowerFirst('Picking a sample.'), 'picking a sample.');
    assert.equal(lowerFirst('DNA is a molecule.'), 'DNA is a molecule.');
    assert.equal(lowerFirst('pH is a scale.'), 'pH is a scale.');
    assert.equal(lowerFirst('Filipino is a language.'), 'Filipino is a language.');
    assert.equal(lowerFirst(''), '');
  });
  it('no longer turns True / False into Yes / No', () => {
    assert.equal(quiz.yesNo, undefined);
    assert.equal(quiz.yesNoAsk, undefined);
  });
  it('capitalises the first letter for display only, leaving names like iPhone and pH alone', () => {
    assert.equal(capitalFirst('builds confidence.'), 'Builds confidence.');
    assert.equal(capitalFirst('“quoted” text'), '“Quoted” text');
    assert.equal(capitalFirst('iPhone use'), 'iPhone use');
    assert.equal(capitalFirst('pH scale'), 'pH scale');
    assert.equal(capitalFirst('___ is a method'), '___ is a method');
    assert.equal(capitalFirst(''), '');
  });
  it('leaves a multiple-choice question as it is', () => {
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
    assert.equal(bestLine(90, 80), 'New best. Your previous best was 80%.');
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

describe('tfCorrection', () => {
  it('says the card answer once as a plain sentence, never as a right answer', () => {
    assert.equal(quiz.tfCorrection({ type: 'tf', kind: 'concept', right_answer: 'False', answer_text: '9 J' }), 'The answer is 9 J.');
    assert.equal(quiz.tfCorrection({ type: 'tf', kind: 'term', question: 'Work', right_answer: 'False', answer_text: 'The force times distance' }), 'Work means the force times distance.');
  });
  it('says the statement is true when the right answer is True, never repeating the card answer', () => {
    assert.equal(quiz.tfCorrection({ type: 'tf', kind: 'concept', right_answer: 'True', answer_text: '9 J' }), 'That statement is true.');
    assert.equal(quiz.tfCorrection({ type: 'tf', kind: 'term', question: 'Work', right_answer: 'True', answer_text: 'The force times distance' }), 'That statement is true.');
  });
  it('gives the true sentence for an AI sentence pair (statement form)', () => {
    const q = { type: 'tf', kind: 'concept', form: 'statement', question: 'Why sample?', right_answer: 'False', answer_text: 'sampling saves time' };
    assert.equal(quiz.tfCorrection(q), 'The true statement: Sampling saves time.');
    assert.equal(quiz.tfCorrection({ ...q, right_answer: 'True' }), 'That statement is true.');
    assert.equal(quiz.tfCorrection({ ...q, answer_text: '' }), '');
  });
  it('is empty when the answer is unknown or the item is not true / false', () => {
    assert.equal(quiz.tfCorrection({ type: 'tf', kind: 'concept', right_answer: 'False', answer_text: '' }), '');
    assert.equal(quiz.tfCorrection({ type: 'mc', right_answer: 'x', answer_text: '9 J' }), '');
  });
});
