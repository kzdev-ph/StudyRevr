import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { openDb, runMigrations } from '../src/db/index.js';
import { createPipelineRunner } from '../src/pipeline/runner.js';
import { markMixedIfClaude } from '../src/services/lesson-author.js';
import { addCodes, cleanCheckReview, cleanReview, seedLesson, startStudyApp, TEST_PIN } from './helpers.js';

// lessons.made_by: a lesson written by Claude (claude-haiku) that the admin Default AI later changes becomes 'mixed';
// any other lesson keeps its author. Every way the Default AI writes into a lesson is covered below.

const quiet = { error() {}, warn() {}, log() {}, info() {} };
const madeBy = (db, id) => db.prepare('SELECT made_by FROM lessons WHERE id = ?').get(id).made_by;

// The Default AI: the quiz review, wrong answers, check review and the card rewrite for Regenerate.
function fakeAi() {
  const ai = {
    calls: [],
    reply: null, // what the single-card Regenerate call answers
    async generateJSON({ schema, label, user }) {
      ai.calls.push(label);
      if (label.startsWith('the quiz review')) return schema.parse(cleanReview(user));
      if (label.startsWith('the quick check review')) return schema.parse(cleanCheckReview(user));
      if (label.startsWith('the quiz answer options')) {
        const numbers = [...user.matchAll(/^\[(\d+)\] Question:/gm)].map((m) => Number(m[1]));
        return schema.parse({ items: numbers.map((n) => ({ n, wrong: [`Alpha topic answer ${n}.`, `Beta topic answer ${n}.`, `Gamma topic answer ${n}.`] })) });
      }
      if (label === 'the new flashcard') return schema.parse(ai.reply);
      throw new Error(`unexpected call: ${label}`);
    },
  };
  return ai;
}

describe('made_by becomes mixed when the Default AI changes a Claude-written lesson', () => {
  let t;
  let ai;
  let runner;
  let lessonId;
  let cards;
  const call = (method, path, opts = {}) => t.call(method, path, { pin: TEST_PIN, ...opts });
  const claudeWrote = () => t.db.prepare("UPDATE lessons SET made_by = 'claude-haiku' WHERE id = ?").run(lessonId);

  beforeEach(async () => {
    ai = fakeAi();
    const db = openDb(':memory:');
    runMigrations(db);
    runner = createPipelineRunner({ db, ai, log: quiet });
    t = await startStudyApp({ db, ai, runner });
    addCodes(t.db, 'P01');
    ({ lessonId, cards } = seedLesson(t.db, { n: 3 }));
  });
  afterEach(async () => {
    await t.close();
    t.db.close();
  });

  it('only a claude-haiku lesson changes: gemini and mixed lessons stay as they are', () => {
    assert.equal(markMixedIfClaude(t.db, lessonId), false);
    assert.equal(madeBy(t.db, lessonId), 'gemini');
    claudeWrote();
    assert.equal(markMixedIfClaude(t.db, lessonId), true);
    assert.equal(madeBy(t.db, lessonId), 'mixed');
    assert.equal(markMixedIfClaude(t.db, lessonId), false);
    assert.equal(madeBy(t.db, lessonId), 'mixed');
  });

  it('Review again (the quiz review stage) marks it, and leaves a gemini lesson gemini', async () => {
    await call('POST', `/api/lessons/${lessonId}/quiz-options`);
    await runner.idle();
    assert.equal(madeBy(t.db, lessonId), 'gemini');
    await call('POST', `/api/admin/lessons/${lessonId}/quiz-review`);
    await runner.idle();
    assert.equal(madeBy(t.db, lessonId), 'gemini');

    claudeWrote();
    assert.equal((await call('POST', `/api/admin/lessons/${lessonId}/quiz-review`)).status, 202);
    await runner.idle();
    assert.equal(madeBy(t.db, lessonId), 'mixed');
    assert.ok(ai.calls.includes('the quiz review'));
  });

  it('Remake quiz answers marks it', async () => {
    claudeWrote();
    assert.equal((await call('POST', `/api/lessons/${lessonId}/quiz-options`)).status, 202);
    await runner.idle();
    assert.ok(ai.calls.includes('the quiz answer options'));
    assert.equal(madeBy(t.db, lessonId), 'mixed');
  });

  it('Regenerate this card marks it, and a refused regenerate does not', async () => {
    t.db.prepare('UPDATE flashcards SET front = ?, back = ? WHERE id = ?').run('What does the topic say about alpha and beta?', 'The topic says alpha and beta.', cards[0]);
    claudeWrote();
    // still leaking (the question holds the answer): refused, nothing saved
    ai.reply = { question: 'What does the topic say about alpha and beta?', answer: 'Alpha and beta.', evidence: 'alpha, beta and gamma' };
    const refused = await call('POST', `/api/admin/flashcards/${cards[0]}/regenerate`);
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(madeBy(t.db, lessonId), 'claude-haiku');

    ai.reply = { question: 'Which three things does the lesson name?', answer: 'Alpha, beta and gamma.', evidence: 'alpha, beta and gamma' };
    const res = await call('POST', `/api/admin/flashcards/${cards[0]}/regenerate`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(madeBy(t.db, lessonId), 'mixed');
  });

  it('the wrong answers the quiz makes when a student starts it mark it, and a start that calls no AI does not', async () => {
    claudeWrote();
    const first = await t.call('POST', `/api/lessons/${lessonId}/quiz/attempts`, { as: 'P01' });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.ok(ai.calls.includes('the quiz answer options'), 'the fallback asked the Default AI');
    assert.equal(madeBy(t.db, lessonId), 'mixed');

    // a Claude lesson whose wrong answers are all saved: starting the quiz calls no AI, so it stays Claude's
    const other = seedLesson(t.db, { title: 'Saved', n: 3 });
    const save = t.db.prepare("INSERT INTO quiz_distractors (flashcard_id, choices, made_at) VALUES (?, ?, 'x')");
    other.cards.forEach((id, i) => save.run(id, JSON.stringify([`Alpha topic answer ${i}.`, `Beta topic answer ${i}.`, `Gamma topic answer ${i}.`])));
    t.db.prepare("UPDATE lessons SET made_by = 'claude-haiku' WHERE id = ?").run(other.lessonId);
    const before = ai.calls.length;
    await t.call('POST', `/api/lessons/${other.lessonId}/quiz/attempts`, { as: 'P01' });
    assert.equal(ai.calls.length, before);
    assert.equal(madeBy(t.db, other.lessonId), 'claude-haiku');
  });

  it('is shown to admin only, and the codebook explains it', async () => {
    t.db.prepare("UPDATE lessons SET made_by = 'mixed' WHERE id = ?").run(lessonId);
    const admin = (await call('GET', '/api/lessons')).body.lessons.find((l) => l.id === lessonId);
    assert.equal(admin.made_by, 'mixed');
    const student = (await t.call('GET', '/api/lessons', { as: 'P01' })).body.lessons.find((l) => l.id === lessonId);
    assert.ok(!('made_by' in student));
    const csv = await (await call('GET', '/api/admin/export/lessons.csv', { raw: true })).text();
    assert.match(csv, /Inquiry[^\r\n]*mixed/);
    const zip = await JSZip.loadAsync(Buffer.from(await (await call('GET', '/api/admin/export.zip', { raw: true })).arrayBuffer()));
    assert.match(await zip.file('README.txt').async('string'), /mixed = a lesson written by Claude that the\s+admin Default AI later changed/);
  });
});
