// "Think harder when preparing lessons" (setting lesson_thinking, minimal | low | medium | high, default low):
// above minimal, lesson processing calls ask the model to think at that level (reasoning: 'low' ...) and the content
// stages get the restate-only line; live Explain simpler / Taglish, Prepare and the quiz-start fallback never do. Each lesson records the level it was prepared at (lessons.thinking_level), shown to admin and exported.
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AiError } from '../src/ai/client.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { CODEBOOK } from '../src/export/codebook.js';
import { getJobStatus, queueJob } from '../src/pipeline/jobs.js';
import { createPipelineRunner } from '../src/pipeline/runner.js';
import { RESTATE_ONLY } from '../src/pipeline/run.js';
import { lessonThinking, setSetting } from '../src/services/settings.js';
import { addCodes, blankStatements, cleanCheckReview, cleanReview, groundedChecks, keepAllCandidates, quoteFromPrompt, seedLesson, startStudyApp, TEST_PIN } from './helpers.js';

const quiet = { error() {}, warn() {}, log() {}, info() {} };
const SLIDES = 'Photosynthesis\n- Plants make glucose\nNotes:\nThe teacher explains that light drives the reaction.\n\nCellular respiration\n- Cells release energy';

// Answers every processing label with canned JSON and records the `reasoning` each call was made with.
function fakeAi({ fail } = {}) {
  const calls = [];
  return {
    calls,
    async generateJSON({ system, user, schema, label, reasoning }) {
      calls.push({ label, reasoning, restate: String(system).includes(RESTATE_ONLY) });
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
      } else if (label.startsWith('the quiz true/false statements')) value = blankStatements(user);
      else if (label.startsWith('the flashcards')) value = { cards: [{ question: `What does call ${n} ask?`, answer: 'Something from the lesson.', evidence: quoteFromPrompt(user, 8) }] };
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
  const processed = (id) => t.db.prepare('SELECT thinking_level FROM lessons WHERE id = ?').get(id).thinking_level;
  const setThinking = async (value) => {
    const res = await call('PUT', '/api/settings', { body: { lesson_thinking: value } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  };

  it('defaults to low, saves the four levels, refuses anything else and logs each change in admin_events', async () => {
    assert.equal(lessonThinking(t.db), 'low', 'migration 016 moves the old "off" default to low');
    assert.equal((await call('GET', '/api/settings')).body.lesson_thinking, 'low');
    setSetting(t.db, 'lesson_thinking', 'off');
    assert.equal(lessonThinking(t.db), 'minimal', 'a legacy "off" row reads as minimal');
    assert.equal((await call('PUT', '/api/settings', { body: { lesson_thinking: 'off' } })).status, 400, 'the old name is not saved any more');
    assert.equal((await call('PUT', '/api/settings', { body: { lesson_thinking: 'extreme' } })).status, 400);
    assert.equal((await call('PUT', '/api/settings', { body: { lesson_thinking: 'high' }, pin: null })).status, 401, 'admin only');

    await setThinking('minimal');
    for (const level of ['low', 'medium', 'high']) {
      await setThinking(level);
      assert.equal(lessonThinking(t.db), level);
    }
    await setThinking('high');
    await setThinking('minimal');
    const events = t.db.prepare("SELECT type, detail FROM admin_events WHERE type = 'setting_changed' ORDER BY id").all();
    assert.deepEqual(events.map((e) => e.detail), ['lesson_thinking=low', 'lesson_thinking=medium', 'lesson_thinking=high', 'lesson_thinking=minimal'], 'only real changes are logged');
    setSetting(t.db, 'lesson_thinking', 'nonsense');
    assert.equal(lessonThinking(t.db), 'low', 'an unknown value reads as the default');
  });

  it('with high, every processing call asks for thinking, and the lesson is recorded as high', async () => {
    await setThinking('high');
    const id = addLesson();
    runner.enqueue(id);
    await runner.idle();
    assert.equal(getJobStatus(t.db, id).lesson.status, 'ready');
    assert.deepEqual([...new Set(ai.calls.map((c) => c.label))], [
      'the review sections', 'the key points', 'the key terms', 'the flashcards', 'the flashcards for list items without a card', 'the quiz answer options', 'the quiz true/false statements', 'the quiz review', 'the quick check review',
    ]);
    assert.ok(ai.calls.every((c) => c.reasoning === 'high'), JSON.stringify(ai.calls.filter((c) => c.reasoning !== 'high')));
    const quizStage = (c) => c.label.startsWith('the quiz') || c.label.startsWith('the quick check review');
    assert.ok(ai.calls.every((c) => c.restate === !quizStage(c)), 'the restate-only line goes to the content stages only: ' + JSON.stringify(ai.calls));
    assert.equal(processed(id), 'high');
  });

  it('with low or medium, every call asks for that level and the lesson is recorded at it', async () => {
    for (const level of ['low', 'medium']) {
      ai.calls.length = 0;
      await setThinking(level);
      const id = addLesson();
      runner.enqueue(id);
      await runner.idle();
      assert.equal(getJobStatus(t.db, id).lesson.status, 'ready');
      assert.ok(ai.calls.length > 5 && ai.calls.every((c) => c.reasoning === level), JSON.stringify(ai.calls));
      assert.ok(ai.calls.some((c) => c.restate));
      assert.equal(processed(id), level);
    }
  });

  it('with minimal, no call asks for thinking or gets the restate-only line, and the lesson is recorded as minimal', async () => {
    await setThinking('minimal');
    const id = addLesson();
    runner.enqueue(id);
    await runner.idle();
    assert.ok(ai.calls.length > 5);
    assert.ok(ai.calls.every((c) => c.reasoning === undefined && !c.restate));
    assert.equal(processed(id), 'minimal');
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

    await setThinking('minimal');
    ai.generateJSON = fakeAi().generateJSON;
    queueJob(t.db, id);
    runner.enqueue(id);
    await runner.idle();
    assert.equal(getJobStatus(t.db, id).lesson.status, 'ready');
    assert.equal(processed(id), 'mixed');

    // a later run at either level leaves "mixed" alone
    await setThinking('high');
    assert.equal(t.db.prepare('SELECT thinking_level FROM lessons WHERE id = ?').get(id).thinking_level, 'mixed');
  });

  it('a lesson made before the setting existed counts as minimal: a quiz-answers run at high makes it mixed, at minimal keeps it minimal', async () => {
    const { lessonId } = seedLesson(t.db, { n: 3 });
    assert.equal(processed(lessonId), null);
    await setThinking('minimal');
    assert.equal((await call('POST', `/api/lessons/${lessonId}/quiz-options`)).status, 202);
    await runner.idle();
    assert.equal(processed(lessonId), 'minimal');

    t.db.prepare('UPDATE lessons SET thinking_level = NULL WHERE id = ?').run(lessonId);
    await setThinking('high');
    assert.equal((await call('POST', `/api/admin/lessons/${lessonId}/quiz-review`)).status, 202);
    await runner.idle();
    assert.equal(processed(lessonId), 'mixed');
  });

  it('Prepare (simpler and Taglish versions) never thinks and does not touch the record', async () => {
    const { lessonId } = seedLesson(t.db, { n: 3 });
    t.db.prepare("UPDATE lessons SET thinking_level = 'high' WHERE id = ?").run(lessonId);
    t.db.prepare('INSERT INTO sections (lesson_id, position, title, content) VALUES (?, 0, ?, ?)').run(lessonId, 'Intro', 'Some content of the section.');
    assert.equal((await call('POST', `/api/lessons/${lessonId}/section-versions`)).status, 202);
    await runner.idle();
    assert.ok(ai.calls.length > 0);
    assert.ok(ai.calls.every((c) => c.reasoning === undefined), JSON.stringify(ai.calls));
    assert.equal(processed(lessonId), 'high');
  });

  it('admin’s lesson list carries the record; a student’s list never does', async () => {
    const { lessonId } = seedLesson(t.db, { n: 2 });
    t.db.prepare("UPDATE lessons SET thinking_level = 'high' WHERE id = ?").run(lessonId);
    const admin = (await call('GET', '/api/lessons?counts=1')).body.lessons.find((l) => l.id === lessonId);
    assert.equal(admin.thinking_level, 'high');
    const student = (await t.call('GET', '/api/lessons', { as: 'P00' })).body.lessons.find((l) => l.id === lessonId);
    assert.equal('thinking_level' in student, false);
  });

  it('lessons.csv has a thinking_level column and the codebook explains it', async () => {
    addCodes(t.db, 'P01');
    const { lessonId } = seedLesson(t.db, { n: 2 });
    t.db.prepare("UPDATE lessons SET thinking_level = 'mixed' WHERE id = ?").run(lessonId);
    const csv = (await call('GET', '/api/admin/export/lessons.csv', { raw: true }).then((r) => r.text())).replace(/^﻿/, '');
    const [header, ...lines] = csv.trim().split('\r\n');
    const col = header.split(',').indexOf('thinking_level');
    assert.ok(col >= 0, header);
    assert.ok(lines.some((l) => l.split(',')[col] === 'mixed'), lines.join('\n'));
    const text = CODEBOOK({ now: new Date('2026-10-05T04:00:00Z'), includeP00: false, lessons: [] });
    assert.match(text, /thinking_level/);
    assert.match(text, /minimal[^]*low[^]*medium[^]*high[^]*mixed/);
    assert.match(text, /Explain simpler[^]*never think|never think[^]*Explain simpler/);
  });
});

describe('migration 016: thinking levels', () => {
  it('moves the "off" setting to low and copies processed_thinking into thinking_level', () => {
    const migrations = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyrevr-mig-'));
    for (const f of fs.readdirSync(migrations).filter((f) => f < '016')) fs.copyFileSync(path.join(migrations, f), path.join(dir, f));
    const db = openDb(':memory:');
    runMigrations(db, dir);
    fs.rmSync(dir, { recursive: true });
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('lesson_thinking', 'off')").run();
    const add = (p) => Number(db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status, processed_thinking) VALUES ('T', 'T.pptx', 'x', 1, 'ready', ?)").run(p).lastInsertRowid);
    const ids = { off: add('off'), high: add('high'), mixed: add('mixed'), none: add(null) };
    runMigrations(db);
    assert.equal(lessonThinking(db), 'low');
    const level = (id) => db.prepare('SELECT thinking_level FROM lessons WHERE id = ?').get(id).thinking_level;
    assert.deepEqual([level(ids.off), level(ids.high), level(ids.mixed), level(ids.none)], ['minimal', 'high', 'mixed', null]);
    db.close();
  });
});
