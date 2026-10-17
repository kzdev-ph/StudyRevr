import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { quizReviewNotice } from '../src/lib/quizReview.js';

const lesson = (quiz_review, status = 'ready') => ({ status, quiz_review });

describe('quizReviewNotice (admin lesson row)', () => {
  it('says nothing for a lesson that is not ready or has nothing reviewed', () => {
    assert.equal(quizReviewNotice(lesson({ reviewed: 3, flagged: 1, pending: 0 }, 'processing')), null);
    assert.equal(quizReviewNotice(lesson({ reviewed: 0, flagged: 0, pending: 0 })), null);
    assert.equal(quizReviewNotice({ status: 'ready' }), null);
  });
  it('shows progress with no button while the reviewer works', () => {
    for (const status of ['queued', 'running']) assert.deepEqual(quizReviewNotice(lesson({ reviewed: 3, status })), { state: 'making', title: 'Checking the quiz questions…', detail: null, action: null });
  });
  it('a failed review shows the reason and Review again', () => {
    assert.deepEqual(quizReviewNotice(lesson({ reviewed: 0, pending: 4, status: 'failed', error: 'The AI provider is rate limiting requests.' })), {
      state: 'failed',
      title: 'The quiz check failed.',
      detail: 'The AI provider is rate limiting requests.',
      action: 'Review again',
    });
  });
  it('counts what the reviewer has not seen yet', () => {
    assert.equal(quizReviewNotice(lesson({ reviewed: 2, pending: 1 })).title, '1 quiz question isn’t checked by the AI reviewer yet.');
    assert.equal(quizReviewNotice(lesson({ reviewed: 0, pending: 3 })).action, 'Review quiz');
  });
  it('after a review: how many cards were flagged, and Review again', () => {
    assert.deepEqual(quizReviewNotice(lesson({ reviewed: 12, flagged: 2, pending: 0, status: 'done' })), {
      state: 'done',
      title: 'AI review: 2 of 12 cards flagged.',
      detail: 'The flagged questions or answer options are left out of the quiz.',
      action: 'Review again',
    });
    assert.equal(quizReviewNotice(lesson({ reviewed: 12, flagged: 0, pending: 0 })).title, 'AI review: all 12 cards passed.');
  });
});
