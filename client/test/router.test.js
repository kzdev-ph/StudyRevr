import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAdminRoute, parseRoute, paths, tabOf } from '../src/lib/router.js';

describe('parseRoute', () => {
  it('opens the library by default', () => {
    for (const hash of ['', '#', '#/', '#/review', '#/nonsense']) assert.deepEqual(parseRoute(hash), { name: 'library' });
  });
  it('parses a lesson and its view', () => {
    assert.deepEqual(parseRoute('#/review/12'), { name: 'lesson', lessonId: 12, view: 'sections' });
    assert.deepEqual(parseRoute('#/review/12/terms'), { name: 'lesson', lessonId: 12, view: 'terms' });
    assert.deepEqual(parseRoute('#/review/12/whatever'), { name: 'lesson', lessonId: 12, view: 'sections' });
  });
  it('parses the other tabs and settings', () => {
    for (const name of ['flashcards', 'quiz', 'stats', 'settings']) assert.deepEqual(parseRoute(`#/${name}`), { name });
  });
  it('builds paths that parse back', () => {
    for (const view of ['sections', 'points', 'terms']) assert.equal(parseRoute(paths.lesson(7, view)).view, view);
  });
  it('parses a quiz on a lesson', () => {
    assert.deepEqual(parseRoute('#/quiz/12'), { name: 'quizRun', lessonId: 12 });
    assert.deepEqual(parseRoute(paths.quiz(5)), { name: 'quizRun', lessonId: 5 });
    assert.deepEqual(parseRoute('#/quiz/abc'), { name: 'quiz' });
  });
  it('parses the admin screens', () => {
    assert.deepEqual(parseRoute('#/admin'), { name: 'admin' });
    assert.deepEqual(parseRoute('#/admin/participants/p3'), { name: 'adminParticipant', code: 'P3' });
    assert.deepEqual(parseRoute('#/admin/lessons/12'), { name: 'adminLesson', lessonId: 12 });
    assert.deepEqual(parseRoute(paths.adminLesson(5)), { name: 'adminLesson', lessonId: 5 });
    assert.deepEqual(parseRoute('#/admin/lessons/abc'), { name: 'admin' });
  });
  it('knows which routes are admin screens (the only ones that keep the PIN)', () => {
    for (const hash of ['#/admin', '#/admin/participants/P03', '#/admin/lessons/4']) assert.equal(isAdminRoute(parseRoute(hash)), true);
    for (const hash of ['#/review', '#/review/4', '#/settings', '#/quiz/4', '#/stats', '#/flashcards/all']) assert.equal(isAdminRoute(parseRoute(hash)), false);
    assert.equal(tabOf(parseRoute('#/admin/lessons/4')), null);
  });
  it('maps routes to bottom tabs', () => {
    assert.equal(tabOf(parseRoute('#/review/3')), 'review');
    assert.equal(tabOf(parseRoute('#/quiz')), 'quiz');
    assert.equal(tabOf(parseRoute('#/quiz/3')), 'quiz');
  });
});
