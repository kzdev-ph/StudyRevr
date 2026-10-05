import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AiError } from '../src/ai/client.js';
import { keyPointsPrompt, keyTermsMergePrompt, keyTermsPrompt, sectionsPrompt } from '../src/ai/prompts.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { generateKeyTerms, targetSectionCount } from '../src/pipeline/generate.js';
import { getJobStatus, queueJob } from '../src/pipeline/jobs.js';
import { keepAllCandidates, quoteFromPrompt } from './helpers.js';
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
    async generateJSON({ schema, label, user }) {
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
      } else if (label.startsWith('the merged key terms')) {
        value = keepAllCandidates(user);
      } else if (label.startsWith('the key points') || label.startsWith('the merged')) {
        value = { key_points: [`Takeaway from ${label}.`] };
      } else {
        const evidence = quoteFromPrompt(user);
        value = { terms: [{ term: `Term ${n}`, definition: `Defined by ${label}.`, evidence }, { term: 'Shared', definition: 'Same everywhere.', evidence }] };
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
    const stageOf = (l) => (l.startsWith('the review') ? 0 : l.startsWith('the key points') || l.startsWith('the merged key points') ? 1 : 2);
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

const QUOTE = 'The lesson explains every term in plain words.';

describe('generateKeyTerms', () => {
  const chunks = (n) => Array.from({ length: n }, (_, i) => ({ index: i, text: `Part ${i}. ${QUOTE}`, tokens: 100 }));
  // `lists[i]` answers the i-th chunk call; the merge call (label "the merged key terms") is answered by `merge(user)`
  // and, like the real one, only ever sees and returns candidate numbers.
  const termsAi = (lists, merge = keepAllCandidates) => ({
    prompts: [],
    merges: [],
    async generateJSON({ schema, user, system, label }) {
      if (label === 'the merged key terms') {
        this.merges.push({ user, system });
        return schema.parse(merge(user));
      }
      const i = this.prompts.push({ user, system }) - 1;
      return schema.parse({ terms: lists[i] });
    },
  });
  const t = (term, definition = `${term} is defined.`) => ({ term, definition, evidence: QUOTE });

  it('de-duplicates across chunks ignoring case, punctuation and plurals, before the merge call', async () => {
    const ai = termsAi([[t('Media Channels', 'First.'), t('Reach')], [t('media channel!', 'Second.'), t('Personalization')]]);
    const out = await generateKeyTerms({ ai, chunks: chunks(2), maxTerms: 12 });
    assert.deepEqual(out.map((x) => x.term), ['Media Channels', 'Reach', 'Personalization']);
    assert.equal(out[0].definition, 'First.', 'the first spelling and definition win unless the merge picks another version');
    const { user } = ai.merges[0];
    assert.equal(user.match(/^\[\d+\] /gm).length, 3, 'one candidate per distinct term');
    assert.match(user, /\[1\] Media Channels\n {2}version 1: definition: First\.[^]*version 2: definition: Second\./, 'both versions are offered');
  });

  it('caps the total and interleaves chunks best-first so later parts are not crowded out', async () => {
    const ai = termsAi([[t('a1'), t('a2'), t('a3'), t('a4')], [t('b1'), t('b2'), t('b3'), t('b4')], [t('c1'), t('c2'), t('c3'), t('c4')]]);
    const out = await generateKeyTerms({ ai, chunks: chunks(3), maxTerms: 5 });
    assert.deepEqual(out.map((x) => x.term), ['a1', 'b1', 'c1', 'a2', 'b2']);
    assert.match(ai.merges[0].system, /at most 5/);
    assert.match(ai.merges[0].user, /\[1\] a1[^]*\[2\] b1[^]*\[3\] c1[^]*\[4\] a2/, 'candidates go in best-first order');
  });

  it('a lesson with one chunk skips the merge call; so does one with no candidates', async () => {
    const one = termsAi([[t('a'), t('A')]]);
    assert.deepEqual((await generateKeyTerms({ ai: one, chunks: chunks(1) })).map((x) => x.term), ['a']);
    assert.equal(one.merges.length, 0);
    const none = termsAi([[], []]);
    assert.deepEqual(await generateKeyTerms({ ai: none, chunks: chunks(2) }), []);
    assert.equal(none.merges.length, 0);
  });

  it('the merge only keeps, drops and picks among the candidates: order, version choice, unknown and repeated ids', async () => {
    const lists = [[t('Alpha', 'A1.'), t('Beta'), t('Wide Reach')], [t('alphas', 'A2.'), t('Gamma'), t('Flyers')]];
    // candidates: 1 Alpha (versions 1, 2), 2 Gamma?  -> interleaved: Alpha, alphas(version of 1), Beta, Gamma, Wide Reach, Flyers
    const ai = termsAi(lists, () => ({ terms: [{ id: 3, version: 1 }, { id: 1, version: 2 }, { id: 99 }, { id: 3 }, { id: 1, version: 7 }] }));
    const merged = [];
    const out = await generateKeyTerms({ ai, chunks: chunks(2), maxTerms: 12, onMerge: (m) => merged.push(m) });
    assert.deepEqual(out.map((x) => [x.term, x.definition]), [['Gamma', 'Gamma is defined.'], ['Alpha', 'A2.']]);
    assert.ok(out.every((x) => x.evidence === QUOTE));
    assert.deepEqual(merged, [{ before: ['Alpha', 'Beta', 'Gamma', 'Wide Reach', 'Flyers'], after: ['Gamma', 'Alpha'], fallback: false }]);
  });

  it('the merge cannot add terms or evidence: an answer with extra text fields is still only ids', async () => {
    const ai = termsAi([[t('Alpha')], [t('Beta')]], () => ({ terms: [{ id: 1, term: 'Invented', definition: 'Made up', evidence: 'Made up quote' }] }));
    const out = await generateKeyTerms({ ai, chunks: chunks(2) });
    assert.deepEqual(out, [{ term: 'Alpha', definition: 'Alpha is defined.', evidence: QUOTE }]);
  });

  it('an unusable merge answer keeps all candidates (capped) instead of erasing the lesson key terms', async () => {
    const ai = termsAi([[t('Alpha')], [t('Beta')]], () => ({ terms: [{ id: 42 }] }));
    const merged = [];
    const out = await generateKeyTerms({ ai, chunks: chunks(2), maxTerms: 12, onMerge: (m) => merged.push(m) });
    assert.deepEqual(out.map((x) => x.term), ['Alpha', 'Beta']);
    assert.equal(merged[0].fallback, true);
  });

  it('counts the merge call in the progress total', async () => {
    const seen = [];
    await generateKeyTerms({ ai: termsAi([[t('a')], [t('b')], [t('c')]]), chunks: chunks(3), onProgress: (p) => seen.push(`${p.done}/${p.total}`) });
    assert.deepEqual(seen, ['0/4', '1/4', '2/4', '3/4', '4/4']);
  });

  it('merge prompt: keep only domain concepts, remove examples and evaluative phrases, only choose, never invent', () => {
    const { system, user } = keyTermsMergePrompt({ candidates: [{ term: 'Media', versions: [{ definition: 'D.', evidence: 'E e e.' }] }], maxTerms: 12 });
    assert.match(system, /domain-specific concepts a student must be able to define on a test/);
    assert.match(system, /plain example or list item/);
    assert.match(system, /evaluative or descriptive phrase[^]*wide reach/);
    assert.match(system, /same idea as a better candidate/);
    assert.match(system, /Keep at most 12/);
    assert.match(system, /never add a term, never rewrite a definition or an evidence quote, and refer to candidates only by their number/);
    assert.match(system, /Use ONLY the text you are given/);
    assert.match(user, /\[1\] Media\n {2}version 1: definition: D\.\n {4}evidence: "E e e\."/);
  });

  it('asks each call for only a share of the cap, and the cap defaults to 12', async () => {
    const ai = termsAi([[], [], [], []]);
    await generateKeyTerms({ ai, chunks: chunks(4) });
    for (const { system } of ai.prompts) assert.match(system, /\(at most 5\)/);
    const one = termsAi([[]]);
    await generateKeyTerms({ ai: one, chunks: chunks(1) });
    assert.match(one.prompts[0].system, /\(at most 12\)/);
  });

  it('scales the target term count with the size of the chunk (about one per 100 words, 3 at least)', async () => {
    const ai = termsAi([[], [], []]);
    const sized = (tokens) => [{ index: 0, text: 'x', tokens }];
    await generateKeyTerms({ ai, chunks: sized(100), maxTerms: 12 });
    await generateKeyTerms({ ai, chunks: sized(1200), maxTerms: 12 });
    await generateKeyTerms({ ai, chunks: sized(5000), maxTerms: 12 });
    assert.deepEqual(ai.prompts.map((p) => p.system.match(/about (\d+) terms/)[1]), ['3', '6', '12']);
  });

  it('drops terms whose evidence is missing, not in the lesson, or only a title, and reports each one', async () => {
    const lesson = [{ index: 0, text: 'MEDIA LITERACY\n\nA hypothesis is a tentative answer to a research question.', tokens: 100 }];
    const ai = termsAi([[
      { term: 'Hypothesis', definition: 'A tentative answer.', evidence: '"A hypothesis is a tentative answer to a research question."' },
      { term: 'Media Literacy', definition: 'Made up.', evidence: 'MEDIA LITERACY' },
      { term: 'Variable', definition: 'Made up.', evidence: 'A variable is anything that can change in a study.' },
      { term: 'Theory', definition: 'No quote.', evidence: '' },
    ]]);
    const dropped = [];
    const out = await generateKeyTerms({ ai, chunks: lesson, maxTerms: 12, onDrop: (d) => dropped.push(d) });
    assert.deepEqual(out.map((x) => x.term), ['Hypothesis']);
    assert.equal(out[0].evidence, 'A hypothesis is a tentative answer to a research question.', 'surrounding quotes are removed');
    assert.deepEqual(dropped, [
      { term: 'Media Literacy', reason: 'evidence is only the term or a title' },
      { term: 'Variable', reason: 'evidence not found in the lesson text' },
      { term: 'Theory', reason: 'no evidence quote' },
    ]);
  });

  it('a dropped term does not use up the cap', async () => {
    const lesson = [{ index: 0, text: QUOTE, tokens: 100 }];
    const bad = { term: 'bad', definition: 'd', evidence: 'invented words that are nowhere' };
    const ai = termsAi([[bad, t('a'), t('b'), t('c')]]);
    const out = await generateKeyTerms({ ai, chunks: lesson, maxTerms: 3 });
    assert.deepEqual(out.map((x) => x.term), ['a', 'b', 'c']);
  });

  it('a reply without an evidence field drops the term instead of failing the call', async () => {
    const lesson = [{ index: 0, text: QUOTE, tokens: 100 }];
    const ai = termsAi([[{ term: 'x', definition: 'd' }, t('y')]]);
    assert.deepEqual((await generateKeyTerms({ ai, chunks: lesson })).map((x) => x.term), ['y']);
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
    assert.match(system, /only names or titles a term[^]*never define a term from your own knowledge/);
    assert.match(system, /\(at most 12\)/);
    assert.match(system, /"evidence": one sentence or phrase copied EXACTLY[^]*never use a title or heading/);
    assert.match(system, /"evidence":"\.\.\."/);
    assert.match(system, /A concept is an idea, method, principle[^]*is NOT a concept/);
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
