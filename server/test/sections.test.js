import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AiError } from '../src/ai/client.js';
import { createApp } from '../src/app.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { studyFetch, TEST_PIN } from './helpers.js';

const fetch = studyFetch; // as participant P00, with the admin PIN (see helpers.js)

// Scripted AI: `reply(label, user)` returns the raw JSON value for that call, which is run through the caller's
// schema exactly as the real client does. Every call is recorded.
function fakeAi(reply) {
  const calls = [];
  return {
    calls,
    async generateJSON({ system, user, schema, label }) {
      calls.push({ system, user, label });
      const parsed = schema.safeParse(await reply(label, user, calls.length));
      if (!parsed.success) throw new AiError('invalid_json', `The AI model didn't return usable JSON for ${label}.`);
      return parsed.data;
    },
  };
}

describe('section rewrites and review progress', () => {
  let db;
  let server;
  let base;
  let ai;
  let lessonId;
  let sectionIds;

  const start = async (reply) => {
    ai = fakeAi(reply);
    const app = createApp(db, { maxUploadBytes: 1024 * 1024, adminPin: TEST_PIN }, { ai, runner: { enqueue() {} } });
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const send = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    lessonId = Number(db.prepare(`INSERT INTO lessons (title, filename, raw_text, word_count, status) VALUES ('Inquiry', 'inquiry.pptx', 'Slide text', 2, 'ready')`).run().lastInsertRowid);
    const add = db.prepare('INSERT INTO sections (lesson_id, position, title, content, check_questions) VALUES (?, ?, ?, ?, ?)');
    const questions = JSON.stringify([{ question: 'What is a hypothesis?', answer: 'A testable guess.' }, { question: 'Why test it?', answer: 'To check if it holds.' }]);
    sectionIds = [1, 2, 3].map((n) => Number(add.run(lessonId, n, `Section ${n}`, `A hypothesis is a testable guess about ${n}.`, questions).lastInsertRowid));
    db.prepare('INSERT INTO key_terms (lesson_id, term, definition, evidence) VALUES (?, ?, ?, ?)').run(lessonId, 'Hypothesis', 'A testable guess.', 'A hypothesis is a testable guess');
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  describe('POST /api/sections/:id/simplify', () => {
    const simpleReply = () => ({ simple: 'A hypothesis is a guess you can test.', example: 'Like guessing it will rain and checking the sky.' });

    it('asks the AI once, saves the result per section and serves it from the cache afterwards', async () => {
      await start(simpleReply);
      const first = await send('POST', `/api/sections/${sectionIds[0]}/simplify`);
      assert.equal(first.status, 200);
      assert.deepEqual(first.body, {
        section_id: sectionIds[0],
        kind: 'simple',
        version: { text: 'A hypothesis is a guess you can test.', example: 'Like guessing it will rain and checking the sky.' },
        cached: false,
        shared: true,
        answered_by: { source: 'default', provider: 'google', model: 'gemini-3.5-flash-lite' },
        fallback: null,
      });
      const again = await send('POST', `/api/sections/${sectionIds[0]}/simplify`);
      assert.equal(again.body.cached, true);
      assert.deepEqual(again.body.version, first.body.version);
      assert.equal(ai.calls.length, 1);

      const other = await send('POST', `/api/sections/${sectionIds[1]}/simplify`);
      assert.equal(other.body.cached, false, 'each section has its own cache');
      assert.equal(ai.calls.length, 2);
    });

    it('sends only the section to the model and tells it to stay inside that text', async () => {
      await start(simpleReply);
      await send('POST', `/api/sections/${sectionIds[1]}/simplify`);
      const [call] = ai.calls;
      assert.match(call.system, /Use ONLY the text you are given/);
      assert.match(call.user, /Section 2/);
      assert.doesNotMatch(call.user, /Section 1|Section 3/);
    });

    it('keeps the original summary untouched and returns the simpler version with the lesson', async () => {
      await start(simpleReply);
      await send('POST', `/api/sections/${sectionIds[0]}/simplify`);
      const { body } = await send('GET', `/api/lessons/${lessonId}`);
      const [first, second] = body.sections;
      assert.equal(first.content, 'A hypothesis is a testable guess about 1.');
      assert.equal(first.simple_version.text, 'A hypothesis is a guess you can test.');
      assert.equal(second.simple_version, null);
      assert.equal(first.filipino_version, null);
    });

    it('answers two taps made while the first is still running with one AI call', async () => {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      await start(async () => {
        await gate;
        return simpleReply();
      });
      const a = send('POST', `/api/sections/${sectionIds[0]}/simplify`);
      const b = send('POST', `/api/sections/${sectionIds[0]}/simplify`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      const [ra, rb] = await Promise.all([a, b]);
      assert.deepEqual([ra.status, rb.status], [200, 200]);
      assert.equal(ai.calls.length, 1);
    });

    it('accepts a reply whose example is missing and stores no example', async () => {
      await start(() => ({ simple: ['Short line one.', 'Short line two.'] }));
      const { body } = await send('POST', `/api/sections/${sectionIds[0]}/simplify`);
      assert.deepEqual(body.version, { text: 'Short line one.\nShort line two.', example: null });
    });

    it('surfaces an AI failure as a clear error and caches nothing', async () => {
      await start(() => ({ nonsense: true }));
      const bad = await send('POST', `/api/sections/${sectionIds[0]}/simplify`);
      assert.equal(bad.status, 502);
      assert.match(bad.body.error.message, /usable JSON/);
      assert.equal(db.prepare('SELECT simple_version FROM sections WHERE id = ?').get(sectionIds[0]).simple_version, null);
    });

    it('404s for an unknown section and 400s for a bad id', async () => {
      await start(simpleReply);
      assert.equal((await send('POST', '/api/sections/9999/simplify')).status, 404);
      assert.equal((await send('POST', '/api/sections/abc/simplify')).status, 400);
      assert.equal(ai.calls.length, 0);
    });
  });

  describe('POST /api/sections/:id/translate', () => {
    const translateReply = () => ({
      title: 'Ang hypothesis',
      content: 'Ang hypothesis (hinuha) ay isang guess na puwedeng i-test.',
      check_questions: [
        { question: 'Ano ang hypothesis?', answer: 'Isang testable na guess.' },
        { question: 'Bakit ito tine-test?', answer: 'Para malaman kung tama ito.' },
      ],
    });

    it('translates title, content and questions, caches it, and passes the lesson key terms to the model', async () => {
      await start(translateReply);
      const first = await send('POST', `/api/sections/${sectionIds[0]}/translate`);
      assert.equal(first.status, 200);
      assert.equal(first.body.kind, 'filipino');
      assert.equal(first.body.cached, false);
      assert.equal(first.body.version.title, 'Ang hypothesis');
      assert.equal(first.body.version.check_questions.length, 2);
      assert.match(ai.calls[0].system, /always keep them in English: Hypothesis/);
      assert.match(ai.calls[0].system, /parentheses/);

      const again = await send('POST', `/api/sections/${sectionIds[0]}/translate`);
      assert.equal(again.body.cached, true);
      assert.equal(ai.calls.length, 1);

      const { body } = await send('GET', `/api/lessons/${lessonId}`);
      assert.equal(body.sections[0].filipino_version.content, 'Ang hypothesis (hinuha) ay isang guess na puwedeng i-test.');
      assert.equal(body.sections[0].simple_version, null, 'the two kinds are cached separately');
    });

    it('rejects a translation that drops a quick-check question', async () => {
      await start(() => ({ ...translateReply(), check_questions: [{ question: 'Ano?', answer: 'Isa lang.' }] }));
      const res = await send('POST', `/api/sections/${sectionIds[0]}/translate`);
      assert.equal(res.status, 502);
      assert.equal(db.prepare('SELECT filipino_version FROM sections WHERE id = ?').get(sectionIds[0]).filipino_version, null);
    });
  });

  describe('review progress', () => {
    it('is null until saved, then saved and returned with the lesson', async () => {
      await start(() => ({}));
      assert.equal((await send('GET', `/api/lessons/${lessonId}`)).body.review_progress, null);
      assert.deepEqual((await send('GET', `/api/lessons/${lessonId}/review-progress`)).body, { review_progress: null });

      const put = await send('PUT', `/api/lessons/${lessonId}/review-progress`, { last_section: 1, completed_sections: [1, 0, 0] });
      assert.equal(put.status, 200);
      assert.equal(put.body.review_progress.last_section, 1);
      assert.deepEqual(put.body.review_progress.completed_sections, [0, 1], 'sorted and de-duplicated');

      const { body } = await send('GET', `/api/lessons/${lessonId}`);
      assert.equal(body.review_progress.last_section, 1);
      assert.deepEqual(body.review_progress.completed_sections, [0, 1]);
    });

    it('updates in place and keeps the completed list when only last_section is sent', async () => {
      await start(() => ({}));
      await send('PUT', `/api/lessons/${lessonId}/review-progress`, { last_section: 1, completed_sections: [0] });
      const put = await send('PUT', `/api/lessons/${lessonId}/review-progress`, { last_section: 2 });
      assert.deepEqual([put.body.review_progress.last_section, put.body.review_progress.completed_sections], [2, [0]]);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_progress').get().n, 1);
    });

    it('rejects bad bodies, out-of-range sections, unknown lessons and lessons without sections', async () => {
      await start(() => ({}));
      const url = `/api/lessons/${lessonId}/review-progress`;
      assert.equal((await send('PUT', url, {})).status, 400);
      assert.equal((await send('PUT', url, { last_section: -1 })).status, 400);
      assert.equal((await send('PUT', url, { last_section: 1.5 })).status, 400);
      assert.equal((await send('PUT', url, { last_section: 'two' })).status, 400);
      const far = await send('PUT', url, { last_section: 3 });
      assert.equal(far.status, 400);
      assert.match(far.body.error.message, /3 sections/);
      assert.equal((await send('PUT', url, { last_section: 0, completed_sections: [7] })).status, 400);
      assert.equal((await send('PUT', '/api/lessons/9999/review-progress', { last_section: 0 })).status, 404);

      const empty = Number(db.prepare(`INSERT INTO lessons (title, filename, status) VALUES ('Empty', 'e.pdf', 'processing')`).run().lastInsertRowid);
      assert.equal((await send('PUT', `/api/lessons/${empty}/review-progress`, { last_section: 0 })).status, 409);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_progress').get().n, 0, 'nothing is saved on a rejected request');
    });

    it('is deleted with its lesson', async () => {
      await start(() => ({}));
      await send('PUT', `/api/lessons/${lessonId}/review-progress`, { last_section: 1 });
      await send('DELETE', `/api/lessons/${lessonId}`);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_progress').get().n, 0);
    });
  });
});
