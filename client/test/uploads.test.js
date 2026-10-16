import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { STAGES, adminLessonNote, ownLessonNote, processingLine, rowActions, uploadsLeftText } from '../src/lib/uploads.js';

describe('uploadsLeftText (under the student upload button)', () => {
  it('says nothing while uploads are off', () => {
    assert.equal(uploadsLeftText({ allowed: false, per_day: 2, left_today: 2 }), null);
    assert.equal(uploadsLeftText(null), null);
  });
  it('counts what is left, singular and plural', () => {
    assert.equal(uploadsLeftText({ allowed: true, per_day: 2, left_today: 2 }), '2 uploads left today');
    assert.equal(uploadsLeftText({ allowed: true, per_day: 2, left_today: 1 }), '1 upload left today');
  });
  it('says when to come back once they are used up', () => {
    assert.equal(uploadsLeftText({ allowed: true, per_day: 2, left_today: 0 }), 'You’ve used today’s uploads. You can upload again tomorrow.');
  });
  it('does not promise uploads when the limit is 0', () => {
    assert.equal(uploadsLeftText({ allowed: true, per_day: 0, left_today: 0 }), 'Uploads are not available right now.');
  });
});

describe('ownLessonNote / adminLessonNote', () => {
  it('tells a student who can see their upload, and nothing about the teacher\'s lessons', () => {
    assert.equal(ownLessonNote({ mine: true, shared: false }), 'Only you see this');
    assert.equal(ownLessonNote({ mine: true, shared: true }), 'Yours, shared with everyone');
    assert.equal(ownLessonNote({ mine: false, shared: false }), null);
  });
  it('tells admin whose upload it is, and never names a code to a student', () => {
    assert.equal(adminLessonNote({ origin: 'admin' }), null);
    assert.equal(adminLessonNote({ origin: 'student', owner_code: 'P07', shared: false }), 'Uploaded by P07 · only P07 can see it');
    assert.equal(adminLessonNote({ origin: 'student', owner_code: 'P07', shared: true }), 'Uploaded by P07 · shared with everyone');
    assert.equal(adminLessonNote({ origin: 'student', owner_code: null, shared: true }), 'Uploaded by a withdrawn participant · shared with everyone');
    assert.equal(ownLessonNote({ mine: false, owner_code: 'P07' }), null);
  });
});

describe('processingLine (the library row while an upload is prepared)', () => {
  it('uses the processing page\'s words for the stage', () => {
    for (const s of STAGES) assert.equal(processingLine({ status: 'processing', processing: { stage: s.id, status: 'running' } }), `${s.doing}…`);
  });
  it('says it is waiting when the job is queued or unknown', () => {
    assert.equal(processingLine({ status: 'processing', processing: { stage: 'sections', status: 'queued' } }), 'Waiting its turn…');
    assert.equal(processingLine({ status: 'processing' }), 'Waiting its turn…');
  });
  it('is nothing for a lesson that is not processing', () => {
    assert.equal(processingLine({ status: 'ready' }), null);
    assert.equal(processingLine({ status: 'failed' }), null);
  });
});

describe('rowActions', () => {
  it('offers Delete only when the server says so, Try again only for a failed upload', () => {
    assert.deepEqual(rowActions({ mine: true, can_delete: true, can_retry: false }), { delete: true, retry: false });
    assert.deepEqual(rowActions({ mine: true, can_delete: false, can_retry: true }), { delete: false, retry: true });
  });
  it('offers nothing on a lesson that is not theirs', () => {
    assert.deepEqual(rowActions({ mine: false, can_delete: true, can_retry: true }), { delete: false, retry: false });
    assert.deepEqual(rowActions({}), { delete: false, retry: false });
  });
});
