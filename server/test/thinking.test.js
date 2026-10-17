// "Think harder when preparing lessons" (setting lesson_thinking, off | high, default off): lesson processing calls
// ask the model to think (reasoning: 'high'); live Explain simpler / Taglish, Prepare and the quiz-start fallback never
// do. Each lesson records the level it was prepared at (lessons.processed_thinking), shown to admin and exported.
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AiError } from '../src/ai/client.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { CODEBOOK } from '../src/export/codebook.js';
import { getJobStatus, queueJob } from '../src/pipeline/jobs.js';
import { createPipelineRunner } from '../src/pipeline/runner.js';
import { lessonThinking } from '../src/services/settings.js';
import { addCodes, cleanCheckReview, cleanReview, groundedChecks, keepAllCandidates, quoteFromPrompt, seedLesson, startStudyApp, TEST_PIN } from './helpers.js';

const quiet = { error() {}, warn() {}, log() {}, info() {} };
const SLIDES = 'Photosynthesis\n- Plants make glucose\nNotes:\nThe teacher explains that light drives the reaction.\n\nCellular respiration\n- Cells release energy';

// Answers every processing label with canned JSON and records the `reasoning` each call was made with.
function fakeAi({ fail } = {}) {
  const calls = [];
  return {
    calls,
    async generateJSON({ user, schema, label, reasoning }) {
      calls.push({ label, reasoning });
      fail?.(label);
      const n = calls.length;
      let value;
      if (label.startsWith('the review sections')) value = { sections: [{ title: `Section ${n}`, content: `Content of section ${n}, long enough to be valid.`, check_questions: groundedChecks(user, 2) }] };
      else if (label.startsWith('the merged key terms')) value = keepAllCandidates(user);
      else if (label.startsWith('the key points')) value = { key_points: [`Point ${n}a.`, `Point ${n}b.`] };
      else if (label.startsWith('the quiz review')) value = cleanReview(user);
      else if (label.startsWith('the quick check review')) value = cleanCheckReview(user);
      else if (label.startsWith('the quiz answer options')) {
        const numbers = [...user.matchAll(/^\[(\d+)\] Question:/gm)].map((m) => Number(m[1]));
        value = { items: numbers.map((k) => ({ n: k, wrong: ['Plants make more starch.', 'Cells store some water.', 'Light warms the leaves.'] })) };
      } else if (label.startsWith('the flashcards')) value = { cards: [{ question: `What does call ${n} ask?`, answer: 'Something from the lesson.', evidence: quoteFromPrompt(user, 8) }] };
      else if (label.includes('simpler')) value = { simple: 'Simple.', example: 'Like a line.' };
      else if (label.includes('Taglish') || label.includes('Filipino')) value = { title: 'Pamagat', content: 'Laman.', check_questions: [] };
      else value = { terms: [{ term: 'Media', definition: `Defined in call ${n}.`, evidence: quoteFromPrompt(user) }, { term: `Term ${n}`, definition: 'Another definition.', evidence: quoteFromPrompt(user, 7) }] };
      return schema.parse(value);
    },
  };
}

describe('lesson thinking: setting, calls and the record on the lesson', () => {
  let t;
  let ai;
  let runner;
  beforeEach(async () => {
    ai = fakeAi();
    const db = openDb(':memory:');
    runMigrations(db);
    runner = createPipelineRunner({ db, ai, log: quiet });
    t = await startStudyApp({ db, ai, runner });
  });
  afterEach(async () => {
    await t.close();
    t.db.close();
  });
  const call = (method, path, opts = {}) => t.call(method, path, { pin: TEST_PIN, ...opts });
  const addLesson = () => {
    const id = Number(t.db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status) VALUES ('T', 'T.pptx', ?, 100, 'processing')").run(SLIDES).lastInsertRowid);
    queueJob(t.db, id);
    return id;
  };
  const processed = (id) => t.db.prepare('SELECT processed_thinking FROM lessons WHERE id = ?').get(id).processed_thinking;
  const setThinking = async (value) => {
    const res = await call('PUT', '/api/settings', { body: { lesson_thinking: value } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  };

  it('defaults to off, saves off / high, refuses anything else and logs each change in admin_events', async () => {
    assert.equal(lessonThinking(t.db), 'off');
    assert.equal((await call('GET', '/api/settings')).body.lesson_thinking, 'off');
    assert.equal((await call('PUT', '/api/settings', { body: { lesson_thinking: 'extreme' } })).status, 400);
    assert.equal((await call('PUT', '/api/settings', { body: { lesson_thinking: 'high' }, pin: null })).status, 401, 'admin only');

    await setThinking('off');
    await setThinking('high');
    assert.equal(lessonThinking(t.db), 'high');
    await setThinking('high');
    await setThinking('off');
    const events = t.db.prepare("SELECT type, detail FROM admin_events WHERE type = 'setting_changed' ORDER BY id").all();
    assert.deepEqual(events.map((e) => e.detail), ['lesson_thinking=high', 'lesson_thinking=off'], 'only real changes are logged');
  });

  it('with high, every processing call asks for thinking, and the lesson is recorded as high', async () => {
    await setThinking('high');
    const id = addLesson();
    runner.enqueue(id);
    await runner.idle();
    assert.equal(getJobStatus(t.db, id).lesson.status, 'ready');
    assert.deepEqual([...new Set(ai.calls.map((c) => c.label))], [
      'the review sections', 'the key points', 'the key terms', 'the flashcards', 'the flashcards for list items without a card', 'the quiz answer options', 'the quiz review', 'the quick check review',
    ]);
    assert.ok(ai.calls.every((c) => c.reasoning === 'high'), JSON.stringify(ai.calls.filter((c) => c.reasoning !== 'high')));
    assert.equal(processed(id), 'high');
  });

  it('with off, no call asks for thinking, and the lesson is recorded as off', async () => {
    await setThinking('off');
    const id = addLesson();
    runner.enqueue(id);
    await runner.idle();
    assert.ok(ai.calls.length > 5);
    assert.ok(ai.calls.every((c) => c.reasoning === undefined));
    assert.equal(processed(id), 'off');
  });

  it('a retry at the other level makes the record "mixed"; the same level keeps it', async () => {
    const broken = fakeAi({
      fail: (label) => {
        if (label === 'the key terms') throw new AiError('rate_limit', 'The AI provider is rate limiting requests (HTTP 429). Try again shortly.');
      },
    });
    ai.generateJSON = broken.generateJSON;
    await setThinking('high');
    const id = addLesson();
    runner.enqueue(id);
    await runner.idle();
    assert.equal(getJobStatus(t.db, id).lesson.status, 'failed');
    assert.equal(processed(id), 'high', 'a failed run is recorded too: its calls did ask for thinking');

    await setThinking('off');
    ai.generateJSON = fakeAi().generateJSON;
    queueJob(t.db, id);
    runner.enqueue(id);
    await runner.idle();
    assert.equal(getJobStatus(t.db, id).lesson.status, 'ready');
    assert.equal(processed(id), 'mixed');

    // a later run at either level leaves "mixed" alone
    await setThinking('high');
    assert.equal(t.db.prepare('SELECT processed_thinking FROM lessons WHERE id = ?').get(id).processed_thinking, 'mixed');
  });

  it('a lesson made before the setting existed counts as off: a quiz-answers run at high makes it mixed, at off keeps it off', async () => {
    const { lessonId } = seedLesson(t.db, { n: 3 });
    assert.equal(processed(lessonId), null);
    await setThinking('off');
    assert.equal((await call('POST', `/api/lessons/${lessonId}/quiz-options`)).status, 202);
    await runner.idle();
    assert.equal(processed(lessonId), 'off');

    t.db.prepare('UPDATE lessons SET processed_thinking = NULL WHERE id = ?').run(lessonId);
    await setThinking('high');
    assert.equal((await call('POST', `/api/admin/lessons/${lessonId}/quiz-review`)).status, 202);
    await runner.idle();
    assert.equal(processed(lessonId), 'mixed');
  });

  it('Prepare (simpler and Taglish versions) never thinks and does not touch the record', async () => {
    const { lessonId } = seedLesson(t.db, { n: 3 });
    t.db.prepare("UPDATE lessons SET processed_thinking = 'high' WHERE id = ?").run(lessonId);
    t.db.prepare('INSERT INTO sections (lesson_id, position, title, content) VALUES (?, 0, ?, ?)').run(lessonId, 'Intro', 'Some content of the section.');
    assert.equal((await call('POST', `/api/lessons/${lessonId}/section-versions`)).status, 202);
    await runner.idle();
    assert.ok(ai.calls.length > 0);
    assert.ok(ai.calls.every((c) => c.reasoning === undefined), JSON.stringify(ai.calls));
    assert.equal(processed(lessonId), 'high');
  });

  it('admin’s lesson list carries the record; a student’s list never does', async () => {
    const { lessonId } = seedLesson(t.db, { n: 2 });
    t.db.prepare("UPDATE lessons SET processed_thinking = 'high' WHERE id = ?").run(lessonId);
    const admin = (await call('GET', '/api/lessons?counts=1')).body.lessons.find((l) => l.id === lessonId);
    assert.equal(admin.processed_thinking, 'high');
    const student = (await t.call('GET', '/api/lessons', { as: 'P00' })).body.lessons.find((l) => l.id === lessonId);
    assert.equal('processed_thinking' in student, false);
  });

  it('lessons.csv has a processed_thinking column and the codebook explains it', async () => {
    addCodes(t.db, 'P01');
    const { lessonId } = seedLesson(t.db, { n: 2 });
    t.db.prepare("UPDATE lessons SET processed_thinking = 'mixed' WHERE id = ?").run(lessonId);
    const csv = (await call('GET', '/api/admin/export/lessons.csv', { raw: true }).then((r) => r.text())).replace(/^﻿/, '');
    const [header, ...lines] = csv.trim().split('\r\n');
    const col = header.split(',').indexOf('processed_thinking');
    assert.ok(col >= 0, header);
    assert.ok(lines.some((l) => l.split(',')[col] === 'mixed'), lines.join('\n'));
    const text = CODEBOOK({ now: new Date('2026-10-05T04:00:00Z'), includeP00: false, lessons: [] });
    assert.match(text, /processed_thinking/);
    assert.match(text, /off[^]*high[^]*mixed/);
    assert.match(text, /Explain simpler[^]*never think|never think[^]*Explain simpler/);
  });
});
