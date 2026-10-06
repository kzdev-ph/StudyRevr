import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import PptxGenJS from 'pptxgenjs';
import { AiError, createAiClient } from '../src/ai/client.js';
import { createApp } from '../src/app.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { failInterruptedJobs, getJobStatus, queueJob } from '../src/pipeline/jobs.js';
import { createPipelineRunner } from '../src/pipeline/runner.js';
import { resolveAiConfig } from '../src/services/settings.js';
import { keepAllCandidates, quoteFromPrompt, studyFetch, TEST_PIN } from './helpers.js';

const fetch = studyFetch; // as participant P00, with the admin PIN (see helpers.js)

const quiet = { error() {}, warn() {}, log() {} };
const para = (label, tokens = 50) => `${label} ${'word '.repeat(Math.max(0, (tokens * 3) / 5 - 1)).trim()}`.slice(0, tokens * 3);

// Answers each feature with canned, schema-valid JSON and records every prompt. `fail(label, nth)` may throw.
function fakeAi({ fail } = {}) {
  const calls = [];
  const byLabel = {};
  return {
    calls,
    async generateJSON({ system, user, schema, label, maxTokens }) {
      calls.push({ system, user, label, maxTokens });
      byLabel[label] = (byLabel[label] ?? 0) + 1;
      fail?.(label, byLabel[label], calls.length);
      const n = calls.length;
      let value;
      if (label.startsWith('the review sections')) {
        value = {
          sections: [
            {
              title: `Section ${n}`,
              content: `Content of section ${n}, long enough to be valid.`,
              check_questions: [1, 2, 3].map((i) => ({ question: `Question ${i}?`, answer: `Answer ${i}.` })),
            },
          ],
        };
      } else if (label.startsWith('the merged key terms')) {
        value = keepAllCandidates(user);
      } else if (label.startsWith('the key points') || label.startsWith('the merged')) {
        value = { key_points: [`Point ${n}a.`, `Point ${n}b.`] };
      } else if (label.startsWith('the quiz answer options')) {
        const numbers = [...user.matchAll(/^\[(\d+)\] Question:/gm)].map((m) => Number(m[1]));
        value = { items: numbers.map((n) => ({ n, wrong: ['Wrong one.', 'Wrong two.', 'Wrong three.'] })) };
      } else if (label.startsWith('the flashcards')) {
        value = { cards: [{ question: `What does call ${n} ask?`, answer: 'Something from the lesson.', evidence: quoteFromPrompt(user, 8) }] };
      } else {
        const evidence = quoteFromPrompt(user);
        value = { terms: [{ term: 'Media', definition: `Defined in call ${n}.`, evidence }, { term: `Term ${n}`, definition: 'Another definition.', evidence: quoteFromPrompt(user, 7) }] };
      }
      return schema.parse(value);
    },
  };
}

describe('pipeline', () => {
  let db;
  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
  });

  const addLesson = (rawText) => {
    const id = Number(db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status) VALUES ('T', 'T.pptx', ?, 100, 'processing')").run(rawText).lastInsertRowid);
    queueJob(db, id);
    return id;
  };
  const run = async (ai, id, chunkTokens) => {
    const runner = createPipelineRunner({ db, ai, chunkTokens, log: quiet });
    runner.enqueue(id);
    await runner.idle();
  };
  const rows = (table, id) => db.prepare(`SELECT * FROM ${table} WHERE lesson_id = ?`).all(id);
  const slideText = 'Photosynthesis\n- Plants make glucose\nNotes:\nThe teacher explains that light drives the reaction.\n\nCellular respiration\n- Cells release energy';

  it('generates and saves sections, key points and key terms, then marks the lesson ready', async () => {
    const id = addLesson(slideText);
    const ai = fakeAi();
    await run(ai, id);

    const status = getJobStatus(db, id);
    assert.equal(status.lesson.status, 'ready');
    assert.equal(status.lesson.error, null);
    assert.deepEqual({ stage: status.job.stage, status: status.job.status, error: status.job.error }, { stage: 'done', status: 'done', error: null });
    assert.deepEqual(ai.calls.map((c) => c.label), ['the review sections', 'the key points', 'the key terms', 'the flashcards', 'the quiz answer options']);

    const [section] = rows('sections', id);
    assert.equal(section.position, 1);
    assert.equal(JSON.parse(section.check_questions).length, 2, 'a third quick-check question is dropped');
    assert.equal(section.simple_version, null);
    assert.equal(rows('key_points', id).length, 2);
    assert.deepEqual(rows('key_terms', id).map((t) => t.term), ['Media', 'Term 3']);
    assert.equal(rows('key_terms', id)[0].evidence, 'Photosynthesis - Plants make glucose Notes:', 'the verified quote is stored with the term');
    const cards = db.prepare('SELECT kind, front, back, evidence, state, position FROM flashcards WHERE lesson_id = ? ORDER BY position').all(id);
    assert.deepEqual(cards.map((c) => [c.kind, c.front, c.position, c.state]), [
      ['term', 'Media', 1, 0],
      ['concept', 'What does call 4 ask?', 2, 0],
      ['term', 'Term 3', 3, 0],
    ], 'term cards from the key terms, interleaved with the concept cards, all new');
    assert.ok(cards.every((c) => c.evidence), 'every card keeps its evidence quote');
  });

  it('drops key terms whose evidence is not in the lesson, logs each one, and still finishes', async () => {
    const id = addLesson(slideText);
    const ai = {
      async generateJSON({ schema, label }) {
        if (label.startsWith('the key terms')) {
          return schema.parse({
            terms: [
              { term: 'Photosynthesis', definition: 'How plants make glucose.', evidence: 'Plants make glucose' },
              { term: 'Chlorophyll', definition: 'A pigment.', evidence: 'Chlorophyll is the green pigment in leaves.' },
            ],
          });
        }
        if (label.startsWith('the key points')) return schema.parse({ key_points: ['p'] });
        if (label.startsWith('the flashcards')) return schema.parse({ cards: [] });
        return schema.parse({ sections: [{ title: 't', content: 'c'.repeat(30), check_questions: [{ question: 'q', answer: 'a' }] }] });
      },
    };
    const infos = [];
    const runner = createPipelineRunner({ db, ai, log: { ...quiet, info: (m) => infos.push(m) } });
    runner.enqueue(id);
    await runner.idle();
    assert.equal(getJobStatus(db, id).lesson.status, 'ready');
    assert.deepEqual(rows('key_terms', id).map((t) => t.term), ['Photosynthesis']);
    const dropped = infos.filter((m) => m.includes('dropped key term'));
    assert.equal(dropped.length, 1);
    assert.match(dropped[0], /dropped key term "Chlorophyll" \(evidence not found in the lesson text\)/);
    const saved = infos.find((m) => m.includes('flashcards ('));
    assert.match(saved, /saved \d+ flashcards \(AI calls \d+\.\ds, checks and de-duplication \d+\.\ds, saving \d+\.\ds\)/, 'where the flashcards stage spent its time');
  });

  it('prompts use only-the-lesson-text and the Notes: rule, and send the lesson text', async () => {
    const id = addLesson(slideText);
    const ai = fakeAi();
    await run(ai, id);
    for (const label of ['the review sections', 'the key terms']) {
      const { system, user } = ai.calls.find((c) => c.label === label);
      assert.match(system, /Use ONLY the lesson text/);
      assert.match(system, /exactly "Notes:"[^]*teacher's spoken explanation of that slide/);
      assert.match(system, /never as a separate topic/);
      assert.match(user, /<lesson_text>\nPhotosynthesis\n- Plants make glucose\nNotes:\nThe teacher explains/);
    }
    const kp = ai.calls.find((c) => c.label === 'the key points');
    assert.match(kp.system, /Use ONLY the text you are given/);
    assert.match(kp.user, /Section 1\nContent of section 1/);
  });

  it('uses the summary_length setting in the sections prompt', async () => {
    const detailed = fakeAi();
    await run(detailed, addLesson(slideText));
    assert.match(detailed.calls[0].system, /100 to 170 words/);

    db.prepare("UPDATE settings SET value = 'short' WHERE key = 'summary_length'").run();
    const short = fakeAi();
    await run(short, addLesson(slideText));
    assert.match(short.calls[0].system, /40 to 80 words/);
  });

  it('records progress while a stage runs', async () => {
    const id = addLesson(Array.from({ length: 4 }, (_, i) => `Slide ${i}\n${para(`body${i}`, 90)}`).join('\n\n'));
    const seen = [];
    const ai = fakeAi({ fail: (label) => seen.push(`${label}: ${JSON.stringify(getJobStatus(db, id).job.progress)} ${getJobStatus(db, id).job.stage}`) });
    await run(ai, id, 200);
    assert.ok(seen.length > 3);
    assert.match(seen[0], /the review sections \(part 1 of \d+\): \{"done":0,"total":\d+\} sections/);
    assert.match(seen[1], /\(part 2 of \d+\): \{"done":1,/);
    assert.ok(seen.some((s) => s.includes('key_terms') || s.includes('the key terms')));
  });

  it('splits a long lesson into several calls, one section list per chunk, merged in lesson order', async () => {
    const slides = Array.from({ length: 6 }, (_, i) => `Slide ${i}\n${para(`body${i}`, 100)}`);
    const id = addLesson(slides.join('\n\n'));
    const ai = fakeAi();
    await run(ai, id, 250);

    const sectionCalls = ai.calls.filter((c) => c.label.startsWith('the review sections'));
    assert.ok(sectionCalls.length >= 3);
    assert.match(sectionCalls[0].user, /^This is part 1 of \d+ of the lesson\./);
    assert.equal(rows('sections', id).length, sectionCalls.length);
    assert.deepEqual(rows('sections', id).map((s) => s.position), sectionCalls.map((_, i) => i + 1));

    const termCalls = ai.calls.filter((c) => c.label.startsWith('the key terms'));
    assert.ok(termCalls.length >= 3);
    const terms = rows('key_terms', id).map((t) => t.term);
    assert.equal(terms.filter((t) => t === 'Media').length, 1, 'duplicate terms across chunks are merged');
    assert.equal(terms.length, termCalls.length + 1);
  });

  it('merges key points from several chunks with one extra call and caps them at 8', async () => {
    const id = addLesson(Array.from({ length: 6 }, (_, i) => `Slide ${i}\n${para(`body${i}`, 100)}`).join('\n\n'));
    const ai = fakeAi();
    // Sections are tiny in the fake, so shrink the budget until the review itself needs several key-point calls.
    await run(ai, id, 250);
    assert.ok(!ai.calls.some((c) => c.label.startsWith('the merged key points')), 'a short review needs no merge step');

    const longSections = Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, content: para(`c${i}`, 80) }));
    const { generateKeyPoints } = await import('../src/pipeline/generate.js');
    const calls = [];
    const ai2 = {
      async generateJSON({ schema, label, user }) {
        calls.push({ label, user });
        return schema.parse({ key_points: Array.from({ length: 5 }, (_, i) => `${label} #${i}`) });
      },
    };
    const points = await generateKeyPoints({ ai: ai2, sections: longSections, chunkTokens: 400 });
    assert.ok(calls.length > 2);
    assert.match(calls.at(-1).label, /merged/);
    assert.match(calls.at(-1).user, /Candidate key points:/);
    assert.ok(points.length <= 8);
  });

  it('fails the lesson with the AI error message, keeps finished stages, and a retry continues from the failed stage', async () => {
    const id = addLesson(slideText);
    const broken = fakeAi({
      fail: (label) => {
        if (label === 'the key points') throw new AiError('rate_limit', 'The AI provider is rate limiting requests (HTTP 429). Try again shortly.');
      },
    });
    await run(broken, id);

    let status = getJobStatus(db, id);
    assert.equal(status.lesson.status, 'failed');
    assert.match(status.lesson.error, /rate limiting/);
    assert.deepEqual({ stage: status.job.stage, status: status.job.status }, { stage: 'key_points', status: 'failed' });
    assert.match(status.job.error, /rate limiting/);
    assert.equal(rows('sections', id).length, 1, 'sections were saved before the failure');
    assert.equal(rows('key_points', id).length, 0);

    queueJob(db, id);
    assert.equal(getJobStatus(db, id).lesson.status, 'processing');
    const healthy = fakeAi();
    await run(healthy, id);
    assert.deepEqual(healthy.calls.map((c) => c.label), ['the key points', 'the key terms', 'the flashcards', 'the quiz answer options'], 'sections are not regenerated');
    status = getJobStatus(db, id);
    assert.equal(status.lesson.status, 'ready');
    assert.equal(status.lesson.error, null);
    assert.equal(rows('sections', id).length, 1);
  });

  it('writes nothing for a stage that fails halfway (no partial sections)', async () => {
    const id = addLesson(Array.from({ length: 6 }, (_, i) => `Slide ${i}\n${para(`body${i}`, 100)}`).join('\n\n'));
    const ai = fakeAi({ fail: (label, _nth, callNo) => { if (callNo === 3) throw new AiError('timeout', 'The AI provider timed out.', 504); } });
    await run(ai, id, 250);
    assert.equal(getJobStatus(db, id).lesson.status, 'failed');
    assert.equal(rows('sections', id).length, 0);
  });

  it('fails without calling the AI when the lesson has no text', async () => {
    const id = addLesson('');
    const ai = fakeAi();
    await run(ai, id);
    assert.equal(ai.calls.length, 0);
    const status = getJobStatus(db, id);
    assert.equal(status.lesson.status, 'failed');
    assert.match(status.lesson.error, /no readable text/);
  });

  it('fails when the AI finds nothing to study', async () => {
    const id = addLesson(slideText);
    const ai = { async generateJSON({ schema }) { return schema.parse({ sections: [] }); } };
    await run(ai, id);
    assert.match(getJobStatus(db, id).lesson.error, /couldn't find anything to study/);
  });

  it('tells the user when the AI provider is not configured', async () => {
    const id = addLesson(slideText);
    const ai = createAiClient({ getConfig: () => resolveAiConfig(db, {}), fetchImpl: () => { throw new Error('no network expected'); } });
    await run(ai, id);
    const { lesson, job } = getJobStatus(db, id);
    assert.equal(lesson.status, 'failed');
    assert.match(lesson.error, /No API key for Google Gemini[^]*GOOGLE_API_KEY/);
    assert.equal(job.stage, 'sections');
  });

  it('hides unexpected errors behind a generic message but logs them', async () => {
    const id = addLesson(slideText);
    const logged = [];
    const runner = createPipelineRunner({ db, ai: { generateJSON: async () => { throw new TypeError('secret internals'); } }, log: { error: (...a) => logged.push(a) } });
    runner.enqueue(id);
    await runner.idle();
    const { lesson } = getJobStatus(db, id);
    assert.match(lesson.error, /Something went wrong while processing/);
    assert.ok(!lesson.error.includes('secret internals'));
    assert.equal(logged.length, 1);
  });

  it('stops quietly if the lesson is deleted mid-run', async () => {
    const id = addLesson(slideText);
    const ai = fakeAi({ fail: (label) => { if (label === 'the review sections') db.prepare('DELETE FROM lessons WHERE id = ?').run(id); } });
    await run(ai, id);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sections').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM jobs').get().c, 0);
  });

  it('runs queued lessons one at a time, in order', async () => {
    const a = addLesson(slideText);
    const b = addLesson(slideText);
    const order = [];
    let active = 0;
    let maxActive = 0;
    const ai = {
      async generateJSON({ schema, label }) {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(label);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return schema.parse(label.startsWith('the flashcards') ? { cards: [] } : label.startsWith('the key terms') ? { terms: [] } : label.startsWith('the key points') ? { key_points: ['p'] } : { sections: [{ title: 't', content: 'c'.repeat(30), check_questions: [{ question: 'q', answer: 'a' }] }] });
      },
    };
    const runner = createPipelineRunner({ db, ai, log: quiet });
    runner.enqueue(a);
    runner.enqueue(b);
    await runner.idle();
    assert.equal(maxActive, 1);
    assert.equal(getJobStatus(db, a).lesson.status, 'ready');
    assert.equal(getJobStatus(db, b).lesson.status, 'ready');
    assert.equal(rows('key_terms', a).length, 0, 'a lesson may legitimately define no terms');
  });

  it('failInterruptedJobs marks unfinished work as failed so it can be retried', () => {
    const running = addLesson(slideText);
    db.prepare("UPDATE jobs SET status = 'running', stage = 'key_points' WHERE lesson_id = ?").run(running);
    const done = addLesson(slideText);
    db.prepare("UPDATE jobs SET status = 'done', stage = 'done' WHERE lesson_id = ?").run(done);
    db.prepare("UPDATE lessons SET status = 'ready' WHERE id = ?").run(done);

    assert.equal(failInterruptedJobs(db), 1);
    assert.equal(getJobStatus(db, running).lesson.status, 'failed');
    assert.match(getJobStatus(db, running).job.error, /restart/);
    assert.equal(getJobStatus(db, done).lesson.status, 'ready');
  });
});

describe('pipeline API', () => {
  let db;
  let server;
  let base;
  let runner;
  let ai;

  before(async () => {
    db = openDb(':memory:');
    runMigrations(db);
    ai = fakeAi();
    runner = createPipelineRunner({ db, ai, log: quiet });
    const app = createApp(db, { maxUploadBytes: 5 * 1024 * 1024, adminPin: TEST_PIN }, { ai, runner });
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  const json = async (path, init) => {
    const res = await fetch(`${base}${path}`, init);
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };

  it('upload starts the pipeline; status goes from processing to ready and the lesson carries its results', async () => {
    const pptx = new PptxGenJS();
    const slide = pptx.addSlide();
    slide.addText('Introduction to Media Channels', { x: 0.5, y: 0.3, w: 9, h: 1, fontSize: 28 });
    slide.addText('Television, radio and the internet carry messages to audiences.', { x: 0.5, y: 1.5, w: 9, h: 1 });
    slide.addNotes('The teacher adds that each channel reaches people differently.');
    const form = new FormData();
    form.append('file', new Blob([await pptx.write({ outputType: 'nodebuffer' })], { type: 'application/octet-stream' }), 'media.pptx');
    const up = await json('/api/lessons', { method: 'POST', body: form });
    assert.equal(up.status, 201);
    assert.equal(up.body.lesson.status, 'processing');

    const id = up.body.lesson.id;
    const early = await json(`/api/lessons/${id}/status`);
    assert.equal(early.status, 200);
    assert.equal(early.body.lesson.id, id);
    assert.ok(['queued', 'running', 'done'].includes(early.body.job.status));

    await runner.idle();
    const done = await json(`/api/lessons/${id}/status`);
    assert.deepEqual(done.body.lesson, { id, status: 'ready', error: null });
    assert.equal(done.body.job.stage, 'done');
    assert.equal(done.body.job.status, 'done');
    assert.equal(typeof done.body.job.updated_at, 'string');
    assert.match(ai.calls[0].user, /Introduction to Media Channels\nTelevision, radio and the internet carry messages to audiences\.\nNotes:\nThe teacher adds/);

    const detail = await json(`/api/lessons/${id}`);
    assert.equal(detail.body.lesson.status, 'ready');
    assert.equal(detail.body.sections.length, 1);
    assert.equal(detail.body.sections[0].check_questions.length, 2);
    assert.deepEqual(detail.body.sections[0].check_questions[0], { question: 'Question 1?', answer: 'Answer 1.' });
    assert.equal(detail.body.key_points.length, 2);
    assert.equal(detail.body.key_terms.length, 2);
  });

  it('status is 404 for an unknown lesson and 400 for a bad id', async () => {
    assert.equal((await json('/api/lessons/9999/status')).status, 404);
    assert.equal((await json('/api/lessons/abc/status')).status, 400);
  });

  it('retry re-queues a failed lesson and refuses anything else', async () => {
    const id = Number(db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status, error) VALUES ('T', 'T.pdf', 'Some lesson text here.', 4, 'failed', 'boom')").run().lastInsertRowid);
    db.prepare("INSERT INTO jobs (lesson_id, stage, status, error) VALUES (?, 'sections', 'failed', 'boom')").run(id);

    const retry = await json(`/api/lessons/${id}/retry`, { method: 'POST' });
    assert.equal(retry.status, 202);
    assert.equal(retry.body.lesson.status, 'processing');
    assert.equal(retry.body.lesson.error, null);
    await runner.idle();
    assert.equal((await json(`/api/lessons/${id}/status`)).body.lesson.status, 'ready');

    assert.equal((await json(`/api/lessons/${id}/retry`, { method: 'POST' })).status, 409);
    assert.equal((await json('/api/lessons/9999/retry', { method: 'POST' })).status, 404);
  });
});
