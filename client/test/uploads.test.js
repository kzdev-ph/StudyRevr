import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { STAGES, adminLessonNote, ownLessonNote, processingLine, rowActions, thinkingNote, madeByNote, uploadsLeftText } from '../src/lib/uploads.js';

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
    assert.equal(adminLessonNote({ origin: 'student', owner_code: null, shared: false }), 'Uploaded by a withdrawn participant · nobody can see it');
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

describe('flashcardsNotice (admin\'s "Make cards", now in the lesson list)', () => {
  it('offers Make cards for a ready lesson with none, and nothing once it has some', async () => {
    const { flashcardsNotice } = await import('../src/lib/flashcardsNotice.js');
    assert.equal(flashcardsNotice({ status: 'ready', flashcards: { total: 0 } }).action, 'Make cards');
    assert.equal(flashcardsNotice({ status: 'ready', flashcards: { total: 12 } }), null);
    assert.equal(flashcardsNotice({ status: 'processing', flashcards: { total: 0 } }), null);
    assert.equal(flashcardsNotice({ status: 'ready' }).state, 'missing');
  });
  it('says when there are fewer cards than a full mock quiz, and when none could be made', async () => {
    const { flashcardsNotice } = await import('../src/lib/flashcardsNotice.js');
    const few = flashcardsNotice({ status: 'ready', flashcards: { total: 8, quiz_length: 10 } });
    assert.equal(few.state, 'few');
    assert.equal(few.title, 'Only 8 flashcards.');
    assert.match(few.detail, /at most 8 of 10/);
    assert.equal(few.action, null);
    const one = flashcardsNotice({ status: 'ready', flashcards: { total: 1, quiz_length: 10 } });
    assert.equal(one.title, 'Only 1 flashcard.');
    assert.match(one.detail, /needs at least 2/);
    assert.equal(flashcardsNotice({ status: 'ready', flashcards: { total: 12, quiz_length: 10 } }), null);
    const damaged = { code: 'damaged_text', message: 'x' };
    const empty = flashcardsNotice({ status: 'ready', text_warning: damaged, flashcards: { total: 0, quiz_length: 10 } });
    assert.deepEqual([empty.state, empty.title, empty.action], ['empty', 'No flashcards could be made.', 'Make cards']);
    assert.match(empty.detail, /can stop cards from being made/);
    const plain = flashcardsNotice({ status: 'ready', flashcards: { total: 0, quiz_length: 10 } });
    assert.deepEqual([plain.state, plain.action], ['missing', 'Make cards']);
  });
  it('shows progress and failure', async () => {
    const { flashcardsNotice } = await import('../src/lib/flashcardsNotice.js');
    assert.equal(flashcardsNotice({ status: 'ready', flashcards: { total: 0, status: 'running' } }).state, 'making');
    const failed = flashcardsNotice({ status: 'ready', flashcards: { total: 0, status: 'failed', error: 'boom' } });
    assert.deepEqual([failed.state, failed.detail, failed.action], ['failed', 'boom', 'Try again']);
  });
});

describe('thinkingNote (admin: how a lesson was prepared)', () => {
  it('names the level, and says nothing for a lesson made before the setting existed or for a student', () => {
    assert.equal(thinkingNote({ thinking_level: 'high' }), 'Prepared with thinking: High');
    assert.equal(thinkingNote({ thinking_level: 'minimal' }), 'Prepared with thinking: Minimal');
    assert.equal(thinkingNote({ thinking_level: 'low' }), 'Prepared with thinking: Low');
    assert.equal(thinkingNote({ thinking_level: 'medium' }), 'Prepared with thinking: Medium');
    assert.equal(thinkingNote({ thinking_level: 'mixed' }), 'Prepared with thinking: Mixed');
    assert.equal(thinkingNote({ thinking_level: null }), null);
    assert.equal(thinkingNote({}), null);
  });
});

describe('madeByNote (admin: who wrote the lesson)', () => {
  it('says so only for an imported lesson, and nothing for the pipeline’s or for a student', () => {
    assert.equal(madeByNote({ made_by: 'claude-haiku' }), 'Written by Claude (Haiku), imported');
    assert.equal(madeByNote({ made_by: 'gemini' }), null);
    assert.equal(madeByNote({}), null);
  });

  it('says a Claude-written lesson the Default AI changed is mixed', () => {
    assert.equal(madeByNote({ made_by: 'mixed' }), 'Written by Claude (Haiku), then changed by the Default AI');
  });
});
