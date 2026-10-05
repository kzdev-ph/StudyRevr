import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, paths, tabOf } from '../src/lib/router.js';

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
  it('maps routes to bottom tabs', () => {
    assert.equal(tabOf(parseRoute('#/review/3')), 'review');
    assert.equal(tabOf(parseRoute('#/quiz')), 'quiz');
  });
});
