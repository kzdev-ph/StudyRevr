import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AiError } from '../src/ai/client.js';
import { keyPointsPrompt, keyTermsPrompt, sectionsPrompt } from '../src/ai/prompts.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { generateKeyTerms, targetSectionCount } from '../src/pipeline/generate.js';
import { getJobStatus, queueJob } from '../src/pipeline/jobs.js';
import { createPipelineRunner } from '../src/pipeline/runner.js';

const quiet = { error() {}, warn() {}, log() {} };
const para = (label, tokens = 50) => `${label} ${'word '.repeat(Math.max(0, (tokens * 3) / 5 - 1)).trim()}`.slice(0, tokens * 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const longLesson = (slides = 8) => Array.from({ length: slides }, (_, i) => `Slide ${i}\n${para(`body${i}`, 100)}`).join('\n\n');

// A fake provider that takes `delay(label, n)` ms per call, tracks how many calls overlap, and records start/finish order.
function timedAi({ delay = () => 3, fail } = {}) {
  const log = { active: 0, peak: 0, started: [], finishedAtStart: [], finished: [] };
  return {
    log,
    async generateJSON({ schema, label }) {
      log.started.push(label);
      log.finishedAtStart.push(log.finished.length);
      log.active++;
      log.peak = Math.max(log.peak, log.active);
      const n = log.started.length;
      try {
        await sleep(delay(label, n));
        fail?.(label, n);
      } finally {
        log.active--;
      }
      log.finished.push(label);
      let value;
      if (label.startsWith('the review sections')) {
        value = { sections: [{ title: `S ${label}`, content: `Content for ${label}, long enough.`, check_questions: [{ question: 'Q?', answer: 'A.' }] }] };
      } else if (label.startsWith('the key points') || label.startsWith('the merged')) {
        value = { key_points: [`Takeaway from ${label}.`] };
      } else {
        value = { terms: [{ term: `Term ${n}`, definition: `Defined by ${label}.` }, { term: 'Shared', definition: 'Same everywhere.' }] };
      }
      return schema.parse(value);
    },
  };
}

describe('parallel pipeline', () => {
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
  const run = async (ai, id, options) => {
    const runner = createPipelineRunner({ db, ai, log: quiet, ...options });
    runner.enqueue(id);
    await runner.idle();
  };
  const rows = (table, id) => db.prepare(`SELECT * FROM ${table} WHERE lesson_id = ? ORDER BY id`).all(id);

  it('runs a stage\'s chunk calls in parallel, never more than the limit', async () => {
    const id = addLesson(longLesson());
    const ai = timedAi({ delay: () => 8 });
    await run(ai, id, { chunkTokens: 250, concurrency: 3 });
    assert.equal(getJobStatus(db, id).lesson.status, 'ready');
    assert.equal(ai.log.peak, 3);
  });

  it('is sequential with concurrency 1', async () => {
    const id = addLesson(longLesson());
    const ai = timedAi();
    await run(ai, id, { chunkTokens: 250, concurrency: 1 });
    assert.equal(ai.log.peak, 1);
  });

  it('keeps the stage order: all sections, then key points, then key terms', async () => {
    const id = addLesson(longLesson());
    const ai = timedAi({ delay: (label) => (label.includes('part 1 of') ? 25 : 2) }); // part 1 is slowest
    await run(ai, id, { chunkTokens: 250, concurrency: 4 });
    const stageOf = (l) => (l.startsWith('the review') ? 0 : l.startsWith('the key points') || l.startsWith('the merged') ? 1 : 2);
    const { started, finishedAtStart } = ai.log;
    const count = (stage) => started.filter((l) => stageOf(l) === stage).length;
    assert.ok(count(0) >= 3 && count(1) >= 1 && count(2) >= 3);
    started.forEach((label, i) => {
      const callsBefore = Array.from({ length: stageOf(label) }, (_, st) => count(st)).reduce((a, b) => a + b, 0);
      assert.ok(finishedAtStart[i] >= callsBefore, `${label} started before the earlier stages finished`);
    });
  });

  it('saves sections in lesson order even when later chunks finish first', async () => {
    const id = addLesson(longLesson());
    const ai = timedAi({ delay: (label) => (label.includes('part 1 of') ? 30 : 1) });
    await run(ai, id, { chunkTokens: 250, concurrency: 4 });
    const titles = rows('sections', id).map((s) => s.title);
    assert.ok(titles.length >= 3);
    assert.match(titles[0], /part 1 of/);
    assert.deepEqual(titles, titles.map((_, i) => titles.find((t) => t.includes(`part ${i + 1} of`))), 'part 1, 2, 3, ... in order');
    assert.deepEqual(rows('sections', id).map((s) => s.position), titles.map((_, i) => i + 1));
  });

  it('progress counts finished calls: never goes backwards, ends at total, resets for each stage', async () => {
    const id = addLesson(longLesson());
    const seen = [];
    const ai = timedAi({ delay: (_l, n) => 2 + (n % 3) * 4 });
    const runner = createPipelineRunner({ db, ai, log: quiet, chunkTokens: 250, concurrency: 3 });
    const poll = setInterval(() => {
      const { job } = getJobStatus(db, id);
      seen.push(`${job.stage}:${job.progress.done}/${job.progress.total}`);
    }, 1);
    runner.enqueue(id);
    await runner.idle();
    clearInterval(poll);

    for (const stage of ['sections', 'key_terms']) {
      const marks = seen.filter((s) => s.startsWith(`${stage}:`)).map((s) => s.split(':')[1].split('/').map(Number)).filter(([, total]) => total > 0);
      assert.ok(marks.length > 1, `${stage} was observed`);
      const total = marks[0][1];
      assert.ok(marks.every(([done, t]) => t === total && done <= total));
      assert.deepEqual(marks.map(([d]) => d), [...marks.map(([d]) => d)].sort((a, b) => a - b), `${stage} progress never goes backwards`);
    }
    const { job } = getJobStatus(db, id);
    assert.deepEqual([job.stage, job.status], ['done', 'done']);
  });

  it('a failing call fails the lesson at once with its message, saves nothing from that stage, and stops recording progress', async () => {
    const id = addLesson(longLesson());
    const ai = timedAi({
      delay: (label) => (label.includes('part 2 of') ? 2 : 25),
      fail: (label) => { if (label.includes('part 2 of')) throw new AiError('rate_limit', 'The AI provider is rate-limiting requests (HTTP 429). Wait a minute, then try again.'); },
    });
    await run(ai, id, { chunkTokens: 250, concurrency: 4 });
    const failed = getJobStatus(db, id);
    assert.equal(failed.lesson.status, 'failed');
    assert.match(failed.lesson.error, /rate-limiting/);
    assert.equal(failed.job.stage, 'sections');
    const progressAtFailure = failed.job.progress;
    assert.equal(rows('sections', id).length, 0);
    await sleep(60); // the slower in-flight calls finish after the failure
    assert.deepEqual(getJobStatus(db, id).job.progress, progressAtFailure, 'stragglers do not write progress after the failure');
    assert.equal(getJobStatus(db, id).lesson.status, 'failed');
    assert.ok(!ai.log.started.some((l) => l.startsWith('the key points')), 'later stages never started');
  });

  it('reads the tuning (chunk size, concurrency, key terms cap) when each lesson starts', async () => {
    const tuning = { chunkTokens: 250, concurrency: 1, keyTermsMax: 12 };
    const runner = createPipelineRunner({ db, ai: timedAi(), log: quiet, tuning: () => tuning });
    const a = addLesson(longLesson());
    runner.enqueue(a);
    await runner.idle();
    const callsA = rows('sections', a).length;
    Object.assign(tuning, { chunkTokens: 100_000 }); // e.g. the user switched to a big-context provider in Settings
    const b = addLesson(longLesson());
    runner.enqueue(b);
    await runner.idle();
    assert.ok(callsA >= 3);
    assert.equal(rows('sections', b).length, 1, 'the whole lesson now fits one call');
  });

  it('limits key terms to keyTermsMax per lesson', async () => {
    const id = addLesson(longLesson(12));
    await run(timedAi(), id, { chunkTokens: 250, concurrency: 3, keyTermsMax: 4 });
    assert.equal(rows('key_terms', id).length, 4);
  });
});

describe('generateKeyTerms', () => {
  const chunks = (n) => Array.from({ length: n }, (_, i) => ({ index: i, text: `chunk ${i}`, tokens: 100 }));
  const termsAi = (lists) => ({
    prompts: [],
    async generateJSON({ schema, user, system }) {
      const i = this.prompts.push({ user, system }) - 1;
      return schema.parse({ terms: lists[i] });
    },
  });
  const t = (term) => ({ term, definition: `${term} is defined.` });

  it('de-duplicates across chunks ignoring case and punctuation, first definition wins', async () => {
    const ai = termsAi([[t('Interactivity'), t('Reach')], [t('interactivity!'), t('Personalization')]]);
    const out = await generateKeyTerms({ ai, chunks: chunks(2), maxTerms: 12 });
    assert.deepEqual(out.map((x) => x.term), ['Interactivity', 'Reach', 'Personalization']);
  });

  it('caps the total and interleaves chunks best-first so later parts are not crowded out', async () => {
    const ai = termsAi([[t('a1'), t('a2'), t('a3'), t('a4')], [t('b1'), t('b2'), t('b3'), t('b4')], [t('c1'), t('c2'), t('c3'), t('c4')]]);
    const out = await generateKeyTerms({ ai, chunks: chunks(3), maxTerms: 5 });
    assert.deepEqual(out.map((x) => x.term), ['a1', 'b1', 'c1', 'a2', 'b2']);
  });

  it('asks each call for only a share of the cap, and the cap defaults to 12', async () => {
    const ai = termsAi([[], [], [], []]);
    await generateKeyTerms({ ai, chunks: chunks(4) });
    for (const { system } of ai.prompts) assert.match(system, /at most 5 terms/);
    const one = termsAi([[]]);
    await generateKeyTerms({ ai: one, chunks: chunks(1) });
    assert.match(one.prompts[0].system, /at most 12 terms/);
  });

  it('trims a model that returns more than it was asked for', async () => {
    const ai = termsAi([Array.from({ length: 30 }, (_, i) => t(`T${i}`))]);
    assert.equal((await generateKeyTerms({ ai, chunks: chunks(1), maxTerms: 12 })).length, 12);
  });
});

describe('prompts', () => {
  const text = 'Slide\n- point\nNotes:\nExplained.';

  it('key terms: only domain concepts a student must define; no list items or evaluative phrases; definitions say what it is', () => {
    const { system, user } = keyTermsPrompt({ text, index: 0, total: 1, maxTerms: 12 });
    assert.match(system, /must be able to define on a test/);
    assert.match(system, /domain-specific concepts/);
    assert.match(system, /plain examples or list items/);
    assert.match(system, /evaluative or descriptive phrases[^]*wide reach/);
    assert.match(system, /say what the term IS[^]*Never just list examples/);
    assert.match(system, /at most 12 terms/);
    assert.match(system, /Use ONLY the lesson text/);
    assert.match(system, /exactly "Notes:"/, 'still explains the Notes: line');
    assert.match(user, /<lesson_text>\nSlide/);
  });

  it('key points: each states a takeaway, not a list of examples', () => {
    const { system } = keyPointsPrompt({ text, index: 0, total: 1 });
    assert.match(system, /states ONE takeaway/);
    assert.match(system, /NOT a list of examples/);
    assert.match(system, /such as A, B, C/);
    assert.match(keyPointsPrompt({ text, consolidate: true }).system, /NOT a list of examples/);
  });

  it('sections: aims for a section count that scales with the chunk size', () => {
    assert.match(sectionsPrompt({ text, index: 0, total: 1, summaryLength: 'detailed', targetSections: 1 }).system, /about 1 section for the text/);
    assert.match(sectionsPrompt({ text, index: 0, total: 1, summaryLength: 'detailed', targetSections: 40 }).system, /about 40 sections/);
    assert.equal(targetSectionCount(10), 1);
    assert.equal(targetSectionCount(2000), 4);
    assert.equal(targetSectionCount(30_000), 54, 'a ~30000-token Gemini chunk is ~15000 words');
  });
});
