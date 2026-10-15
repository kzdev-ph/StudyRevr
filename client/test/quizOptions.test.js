import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { quizOptionsNotice } from '../src/lib/quizOptions.js';

const lesson = (quiz_options, status = 'ready') => ({ status, quiz_options });

describe('quizOptionsNotice (admin lesson row)', () => {
  it('says plainly that the quiz answers failed, with the reason and a Retry action', () => {
    const n = quizOptionsNotice(lesson({ missing: 4, status: 'failed', error: 'The AI provider is rate limiting requests.' }));
    assert.deepEqual(n, { state: 'failed', title: 'Quiz answers failed.', detail: 'The AI provider is rate limiting requests.', action: 'Retry quiz answers' });
  });
  it('says nothing when nothing is missing, even after an earlier failure', () => {
    assert.equal(quizOptionsNotice(lesson({ missing: 0, status: 'failed', error: 'old' })), null);
    assert.equal(quizOptionsNotice(lesson({ missing: 0, status: 'done', error: null })), null);
  });
  it('shows progress while it is being made, with no button', () => {
    for (const status of ['queued', 'running']) {
      const n = quizOptionsNotice(lesson({ missing: 4, status, error: null }));
      assert.equal(n.state, 'making');
      assert.equal(n.action, null);
    }
  });
  it('offers to make them for a lesson that never had them', () => {
    const n = quizOptionsNotice(lesson({ missing: 3, status: null, error: null }));
    assert.equal(n.state, 'missing');
    assert.equal(n.action, 'Make quiz answers');
  });
  it('offers to remake the answer options that give the answer away', () => {
    const n = quizOptionsNotice(lesson({ missing: 0, weak: 2, status: 'done', error: null }));
    assert.deepEqual([n.state, n.title, n.action], ['missing', '2 quiz questions give the answer away.', 'Remake quiz answers']);
    assert.equal(quizOptionsNotice(lesson({ missing: 0, weak: 1, status: null })).title, '1 quiz question gives the answer away.');
    assert.equal(quizOptionsNotice(lesson({ missing: 0, weak: 1, status: 'failed', error: 'x' })).action, 'Retry quiz answers');
  });
  it('stays quiet while the lesson itself is processing or failed', () => {
    assert.equal(quizOptionsNotice(lesson({ missing: 4, status: 'failed', error: 'x' }, 'processing')), null);
    assert.equal(quizOptionsNotice(lesson({ missing: 4, status: 'failed', error: 'x' }, 'failed')), null);
    assert.equal(quizOptionsNotice({ status: 'ready' }), null);
  });
});
