import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, runMigrations } from '../src/db/index.js';
import { getJobStatus } from '../src/pipeline/jobs.js';
import { createPipelineRunner } from '../src/pipeline/runner.js';
import { buildQuiz, quizCandidates } from '../src/quiz/build.js';
import { formatReport, lessonLeakReport } from '../src/quiz/check.js';
import { loadDistractors } from '../src/quiz/distractors.js';
import { quizBuildOptions } from '../src/quiz/options.js';
import { cardHash, readReview } from '../src/quiz/review-flags.js';
import { contextForBatch, itemsToReview, resetReviews, reviewQuiz, reviewSummary, unchangedRewrite } from '../src/services/quiz-review.js';
import { addCodes, cleanCheckReview, seedLesson, startStudyApp, TEST_PIN } from './helpers.js';

const quiet = { error() {}, warn() {}, log() {}, info() {} };

// The items of a review prompt: [{ n, kind, question, options: [{ o, use, text }] }]
function parseItems(user) {
  const items = [];
  for (const line of (/<items>\n([^]*?)\n<\/items>/.exec(user)?.[1] ?? '').split('\n')) {
    const head = /^\[(\d+)\] (Term|Concept) card/.exec(line);
    if (head) items.push({ n: Number(head[1]), kind: head[2].toLowerCase(), question: '', options: [] });
    const q = /^ {4}Question: (.*)$/.exec(line);
    if (q) items.at(-1).question = q[1];
    const o = /^ {4}o(\d+) \(([a-z_]+)\): (.*)$/.exec(line);
    if (o) items.at(-1).options.push({ o: Number(o[1]), use: o[2], text: o[3] });
  }
  return items;
}

// A fake Default AI. `review(item, label)` -> { card, set, true_statement, options, omit } for one item (nothing:
// clean); `families` is the reply's families; `remake(n)` the wrong answers for a remade set; `rewrite(n)` a card
// written again.
function fakeAi({ review = () => ({}), families = [], remake = (n) => [`Alpha topic answer ${n}.`, `Beta topic answer ${n}.`, `Gamma topic answer ${n}.`], rewrite = () => null } = {}) {
  const ai = {
    calls: [],
    async generateJSON({ schema, label, user }) {
      ai.calls.push({ label, user });
      if (label.startsWith('the quiz review')) {
        const items = parseItems(user)
          .map((it) => ({ n: it.n, ...review(it, label) }))
          .filter((it) => !it.omit)
          .map(({ n, card = [], set = [], true_statement = [], options = [] }) => ({ n, card, set, true_statement, options }));
        return schema.parse({ items, families });
      }
      if (label.startsWith('the quiz answer options')) {
        const numbers = [...user.matchAll(/^\[(\d+)\] Question:/gm)].map((m) => Number(m[1]));
        return schema.parse({ items: numbers.map((n) => ({ n, wrong: remake(n) })) });
      }
      if (label.startsWith('the quick check review')) return schema.parse(cleanCheckReview(user));
      if (label === 'the flashcards the quiz review flagged') {
        const numbers = [...user.matchAll(/^\[(\d+)\] (?:Term|Concept) card/gm)].map((m) => Number(m[1]));
        return schema.parse({ cards: numbers.map((n) => ({ n, ...rewrite(n) })) });
      }
      throw new Error(`unexpected call: ${label}`);
    },
  };
  return ai;
}

const saveWrong = (db, cardId, wrong) => db.prepare('INSERT OR REPLACE INTO quiz_distractors (flashcard_id, choices, made_at) VALUES (?, ?, ?)').run(cardId, JSON.stringify(wrong), '2026-10-01T00:00:00.000Z');
const rows = (db, lessonId) => db.prepare('SELECT * FROM quiz_reviews WHERE lesson_id = ? ORDER BY flashcard_id').all(lessonId);
const candidates = (db, lessonId) => {
  const cards = db.prepare('SELECT id, kind, front, back, evidence FROM flashcards WHERE lesson_id = ? ORDER BY position').all(lessonId);
  return quizCandidates(cards, quizBuildOptions(db, lessonId));
};
const labels = (ai) => ai.calls.map((c) => c.label);

describe('quiz review', () => {
  let db;
  let lessonId;
  let cards;
  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    ({ lessonId, cards } = seedLesson(db, { n: 4 }));
    cards.forEach((id, i) => saveWrong(db, id, [`Alpha topic answer ${i + 1}.`, `Beta topic answer ${i + 1}.`, `Gamma topic answer ${i + 1}.`]));
  });
  afterEach(() => db.close());

  it('reviews every card the quiz can ask once, keeps only known flags, and saves the key-term families', async () => {
    const insert = db.prepare('INSERT INTO key_terms (lesson_id, term, definition, evidence) VALUES (?, ?, ?, ?)');
    for (const term of ['River system', 'Rivers', 'Lake', 'Pond']) insert.run(lessonId, term, `${term} defined.`, 'quote');
    assert.equal(itemsToReview(db, lessonId).length, 4);
    const ai = fakeAi({
      review: (it) =>
        it.n === 2
          ? { true_statement: [{ flag: 'giveaway', why: 'common sense' }], card: [{ flag: 'silly', why: 'not a flag' }] }
          : it.n === 3
            ? { set: [{ flag: 'two_correct', why: 'not a set flag' }] }
            : it.n === 4
              ? { omit: true }
              : {},
      families: [['river', 'River system'], ['lake', 'Pond'], ['Lake', 'Ocean']],
    });

    const result = await reviewQuiz({ db, ai, lessonId, madeBy: { provider: 'google', model: 'gemini-3.5-flash-lite' }, log: quiet });
    assert.deepEqual(labels(ai), ['the quiz review'], 'nothing to make again: a giveaway true statement just drops Yes/No');
    assert.match(ai.calls[0].user, /o1 \(both\): Alpha topic answer 1\./);
    assert.match(ai.calls[0].user, /<lesson_text>/);
    assert.deepEqual(result, { reviewed: 4, flagged: 1, regenerated: 0, remade: 0, error: null }, 'the item left out of the reply counts as reviewed');

    const saved = rows(db, lessonId);
    assert.deepEqual(saved.map((r) => r.flashcard_id), cards.slice(0, 4), 'an item left out of the reply is saved with nothing flagged');
    assert.deepEqual([saved[3].card_flags, saved[3].set_flags, saved[3].true_flags, saved[3].option_flags], ['[]', '[]', '[]', '{}']);
    assert.deepEqual(JSON.parse(saved[1].true_flags), [{ flag: 'giveaway', why: 'common sense' }]);
    assert.equal(saved[1].card_flags, '[]', 'an unknown flag is ignored');
    assert.equal(saved[2].set_flags, '[]', 'a flag where it does not belong is ignored');
    assert.equal(saved[0].made_by, 'google/gemini-3.5-flash-lite');
    assert.deepEqual(JSON.parse(db.prepare('SELECT term_families FROM lessons WHERE id = ?').get(lessonId).term_families), [['Lake', 'Pond']], 'synonyms kept; a term and its kind dropped (containment covers it), and a term not in the lesson');

    const second = candidates(db, lessonId).find((p) => p.card.id === cards[1]);
    assert.deepEqual(second.falseClean, [], 'no Yes/No for a true statement anyone can tell');
    assert.equal(second.mcClean.length, 3, 'multiple choice is still fine');
    assert.match(second.excluded.map((x) => x.detail).join(' '), /Yes\/No: giveaway \(common sense\)/);

    // cached: nothing is left to review, so a second run asks for nothing
    assert.equal(itemsToReview(db, lessonId).length, 0);
    const again = fakeAi();
    await reviewQuiz({ db, ai: again, lessonId, log: quiet });
    assert.deepEqual(labels(again), []);

    // what the quiz shows changed (a new wrong answer): that card is reviewed again
    saveWrong(db, cards[0], ['Delta topic answer 1.', 'Beta topic answer 1.', 'Gamma topic answer 1.']);
    assert.deepEqual(itemsToReview(db, lessonId).map((x) => x.card.id), [cards[0]]);
    assert.deepEqual(reviewSummary(db, lessonId), { reviewed: 3, flagged: 1, pending: 1 });
  });

  it('makes flagged wrong options again once, reviews them again, and leaves out what is still flagged', async () => {
    const ai = fakeAi({
      review: (it) => ({ options: it.options.filter((o) => /^Alpha/.test(o.text)).map((o) => ({ o: o.o, flag: 'two_correct', why: 'the lesson says so too' })) }),
      remake: (n) => [`Alpha again topic answer ${n}.`, `Delta topic answer ${n}.`],
    });
    const result = await reviewQuiz({ db, ai, lessonId, log: quiet });
    assert.deepEqual(labels(ai), ['the quiz review', 'the quiz answer options (after review)', 'the quiz review (after fixes)']);
    const remakePrompt = ai.calls[1].user;
    assert.match(remakePrompt, /Alpha topic answer 1\./, 'the flagged option is shown as rejected');
    assert.match(remakePrompt, /the lesson says so too/);
    assert.equal(result.remade, 4);

    const saved = rows(db, lessonId);
    assert.deepEqual(saved.map((r) => r.round), [2, 2, 2, 2]);
    const wrong = loadDistractors(db, lessonId).get(cards[0]);
    assert.ok(!wrong.includes('Alpha topic answer 1.'), 'the flagged option is gone');
    assert.ok(wrong.includes('Beta topic answer 1.'), 'the unflagged ones are kept');
    assert.equal(db.prepare('SELECT settled FROM quiz_distractors WHERE flashcard_id = ?').get(cards[0]).settled, 0);

    // still flagged in round 2 ("Alpha again"): left out, so multiple choice has only 2 and the card is a Yes/No question
    const first = candidates(db, lessonId).find((p) => p.card.id === cards[0]);
    assert.ok(!first.mcClean.length);
    assert.ok(first.falseClean.length && !first.falseClean.some((s) => s.startsWith('Alpha')));
    assert.ok(first.excluded.some((x) => x.rule === 'ai' && x.text === 'Alpha again topic answer 1.'));

    // settled: nothing more to do
    const again = fakeAi();
    await reviewQuiz({ db, ai: again, lessonId, log: quiet });
    assert.deepEqual(labels(again), []);
  });

  it('an option the reviewer calls reversed (the opposite with no negative word) is left out of multiple choice and of Yes/No', async () => {
    const ai = fakeAi({ review: (it) => ({ options: it.options.filter((o) => /^Beta/.test(o.text)).map((o) => ({ o: o.o, flag: 'reversed', why: 'the right answer turned around' })) }), remake: (n) => [`Beta again topic answer ${n}.`, `Delta topic answer ${n}.`] });
    await reviewQuiz({ db, ai, lessonId, log: quiet });
    const first = candidates(db, lessonId).find((p) => p.card.id === cards[0]);
    assert.ok(!first.mcClean.length, 'with one of three options out, multiple choice has too few');
    assert.ok(!first.falseClean.some((s) => s.startsWith('Beta')), 'the reversed option is not a Yes/No false statement either');
    assert.ok(first.excluded.some((x) => x.rule === 'ai' && /^Beta/.test(x.text) && /reversed/.test(x.detail)), JSON.stringify(first.excluded));
  });

  it('an empty reply, or one that matches none of the cards, fails the batch: nothing is saved and every card stays pending', async () => {
    const ai = fakeAi({ review: () => ({ omit: true }) });
    const result = await reviewQuiz({ db, ai, lessonId, log: quiet });
    assert.match(result.error, /listed none of the cards/);
    assert.equal(rows(db, lessonId).length, 0);
    assert.equal(reviewSummary(db, lessonId).pending, 4);
    assert.equal(itemsToReview(db, lessonId).length, 4);
  });

  it('writes a flagged card again in place, makes its options, and reviews it again', async () => {
    const reviewFlags = (it, label) => (label === 'the quiz review' && it.question.startsWith(`Q${lessonId}.1:`) ? { card: [{ flag: 'vague', why: 'names no topic' }] } : {});
    const ai = fakeAi({
      review: reviewFlags,
      rewrite: () => ({ question: 'What does each topic of this lesson come with?', answer: 'A right and a wrong answer.', evidence: 'with a right and a wrong answer' }),
    });
    const result = await reviewQuiz({ db, ai, lessonId, log: quiet });
    assert.deepEqual(labels(ai), ['the quiz review', 'the flashcards the quiz review flagged', 'the quiz answer options', 'the quiz review (after fixes)']);
    assert.match(ai.calls[1].user, /vague: names no topic/);
    assert.equal(result.regenerated, 1);

    const card = db.prepare('SELECT id, front, back FROM flashcards WHERE id = ?').get(cards[0]);
    assert.deepEqual(card, { id: cards[0], front: 'What does each topic of this lesson come with?', back: 'A right and a wrong answer.' }, 'same id, new text');
    assert.equal(rows(db, lessonId).find((r) => r.flashcard_id === cards[0]).round, 2);
    assert.ok(candidates(db, lessonId).find((p) => p.card.id === cards[0]).mcClean.length === 3, 'asked again once it passes');
  });

  describe('term cards: a new definition is another term\'s false statement', () => {
    const TEXT = 'Landforms. Glacier: ice that moves slowly down a valley, and later flows down it as a river of ice. Delta: land formed where a river meets the sea. Dune: a hill of sand shaped by the wind. Reef: a ridge of rock or coral near the surface of the water.';
    const TERMS = [
      ['Glacier', 'Ice that moves slowly down a valley.'],
      ['Delta', 'Land formed where a river meets the sea.'],
      ['Dune', 'A hill of sand shaped by the wind.'],
      ['Reef', 'A ridge of rock or coral near the surface of the water.'],
    ];
    let termLesson;
    let termCards;
    beforeEach(() => {
      termLesson = Number(db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status, created_at) VALUES ('Landforms', 'l.pptx', ?, 60, 'ready', '2026-10-01T00:00:00.000Z')").run(TEXT).lastInsertRowid);
      const insert = db.prepare("INSERT INTO flashcards (lesson_id, kind, front, back, evidence, position) VALUES (?, 'term', ?, ?, ?, ?)");
      termCards = TERMS.map(([t, d], i) => Number(insert.run(termLesson, t, d, d.replace(/\.$/, '').toLowerCase(), i + 1).lastInsertRowid));
    });
    const glacierFlagged = (it, label) => (label === 'the quiz review' && it.question.startsWith('Ice that moves') ? { card: [{ flag: 'vague', why: 'could be any ice' }] } : {});

    it('after a rewrite every card that shows the new definition is reviewed again: nothing is left "not reviewed yet"', async () => {
      const before = itemsToReview(db, termLesson);
      assert.ok(before.find((x) => x.card.id === termCards[1]).item.options.some((o) => o.text === TERMS[0][1]), 'Delta is asked against Glacier\'s definition');
      const ai = fakeAi({ review: glacierFlagged, rewrite: () => ({ definition: 'Ice that flows down a valley as a river of ice.' }) });
      const result = await reviewQuiz({ db, ai, lessonId: termLesson, log: quiet });
      assert.deepEqual(labels(ai), ['the quiz review', 'the flashcards the quiz review flagged', 'the quiz review (after fixes)']);
      assert.equal(result.regenerated, 1);
      const round2 = parseItems(ai.calls[2].user);
      assert.ok(round2.some((it) => it.question.startsWith('Ice that flows')), 'the card written again');
      assert.ok(round2.some((it) => it.question === TERMS[1][1] && it.options.some((o) => o.text === 'Ice that flows down a valley as a river of ice.')), 'a card that now shows the new definition');
      assert.equal(reviewSummary(db, termLesson).pending, 0);
      assert.ok(rows(db, termLesson).filter((r) => r.round === 2).length >= 2);
    });

    it('a rewrite that comes back with the same words is not saved and spends no second review', async () => {
      const ai = fakeAi({ review: glacierFlagged, rewrite: () => ({ definition: 'Ice that moves slowly down the valley.' }) });
      const result = await reviewQuiz({ db, ai, lessonId: termLesson, log: quiet });
      assert.deepEqual(labels(ai), ['the quiz review', 'the flashcards the quiz review flagged'], 'no round 2: nothing changed');
      assert.equal(result.regenerated, 0);
      assert.equal(db.prepare('SELECT back FROM flashcards WHERE id = ?').get(termCards[0]).back, TERMS[0][1]);
      assert.deepEqual(reviewSummary(db, termLesson), { reviewed: 4, flagged: 1, pending: 0 });
      const glacier = candidates(db, termLesson).find((p) => p.card.id === termCards[0]);
      assert.deepEqual([glacier.mcClean.length, glacier.falseClean.length], [0, 0], 'it stays left out');
    });

    it('unchangedRewrite compares content words only', () => {
      const old = { kind: 'concept', front: 'What does a glacier do?', back: 'It moves slowly.' };
      assert.ok(unchangedRewrite(old, { ...old, back: 'It moves slowly!' }));
      assert.ok(!unchangedRewrite(old, { ...old, front: 'Which landform moves slowly down a valley?' }));
      assert.ok(unchangedRewrite({ kind: 'term', front: 'Glacier', back: 'It is ice that moves.' }, { kind: 'term', front: 'Glacier', back: 'This is ice that moves.' }));
    });
  });

  it('never writes a card again once participants have records: the card is left out instead', async () => {
    addCodes(db, 'P01');
    db.prepare("INSERT INTO events (participant_id, type, lesson_id, created_at, study_date) VALUES ((SELECT id FROM participants WHERE code = 'P01'), 'stats_view', ?, '2026-10-01T00:00:00Z', '2026-10-01')").run(lessonId);
    const ai = fakeAi({ review: (it) => (it.question.startsWith(`Q${lessonId}.1:`) ? { card: [{ flag: 'not_in_lesson', why: 'adds a word' }] } : {}) });
    await reviewQuiz({ db, ai, lessonId, log: quiet });
    assert.deepEqual(labels(ai), ['the quiz review']);
    const first = candidates(db, lessonId).find((p) => p.card.id === cards[0]);
    assert.deepEqual([first.mcClean.length, first.falseClean.length], [0, 0], 'not asked');
    assert.match(first.problems.map((p) => p.detail).join(' '), /not_in_lesson \(adds a word\)/);

    // quiz:check shows it
    const report = lessonLeakReport(db, lessonId);
    assert.equal(report.review.reviewed, 4);
    assert.equal(report.review.flagged.length, 1);
    assert.match(formatReport(report), /AI review: [^]*not_in_lesson \(adds a word\)/);
  });

  it('a card written again elsewhere (Regenerate) loses its old review', async () => {
    await reviewQuiz({ db, ai: fakeAi({ review: () => ({ card: [{ flag: 'vague', why: 'x' }] }), rewrite: () => ({}) }), lessonId, log: quiet });
    db.prepare("UPDATE flashcards SET front = 'Which pair comes with every topic of the lesson?' WHERE id = ?").run(cards[1]);
    const second = candidates(db, lessonId).find((p) => p.card.id === cards[1]);
    assert.ok(!second.excluded.length && !second.problems.some((p) => p.rule === 'ai'), 'the old verdict does not apply to the new text');
    assert.ok(itemsToReview(db, lessonId).some((x) => x.card.id === cards[1]));
  });

  it('Review again: every card is reviewed again', async () => {
    await reviewQuiz({ db, ai: fakeAi(), lessonId, log: quiet });
    assert.equal(itemsToReview(db, lessonId).length, 0);
    assert.equal(resetReviews(db, lessonId), 4);
    assert.equal(itemsToReview(db, lessonId).length, 4);
  });

  it('sends the whole lesson when short, else the blocks around the quotes', () => {
    assert.equal(contextForBatch('short lesson', ['x']), 'short lesson');
    const blocks = Array.from({ length: 200 }, (_, i) => `Block ${i} ${'filler words '.repeat(10)}`);
    blocks[100] = 'The quoted sentence lives here.';
    const text = contextForBatch(blocks.join('\n\n'), ['quoted sentence lives']);
    assert.deepEqual(text.split('\n\n').map((b) => b.split(' ')[0] + (b.startsWith('Block') ? b.split(' ')[1] : '')), ['Block99', 'The', 'Block101']);
  });
});

describe('quiz review stage and Review again', () => {
  let t;
  let ai;
  let runner;
  let lessonId;
  beforeEach(async () => {
    ai = fakeAi();
    const db = openDb(':memory:');
    runMigrations(db);
    runner = createPipelineRunner({ db, ai, log: quiet });
    t = await startStudyApp({ db, ai, runner });
    ({ lessonId } = seedLesson(t.db, { n: 3 }));
  });
  afterEach(async () => {
    await t.close();
    t.db.close();
  });
  const call = (method, path, opts = {}) => t.call(method, path, { pin: TEST_PIN, ...opts });

  it('runs after the quiz options and shows on admin’s lesson row', async () => {
    assert.equal((await call('POST', `/api/lessons/${lessonId}/quiz-options`)).status, 202);
    await runner.idle();
    assert.deepEqual(labels(ai), ['the quiz answer options', 'the quiz review']);
    assert.equal(getJobStatus(t.db, lessonId).job.status, 'done');
    const row = (await call('GET', '/api/lessons?counts=1')).body.lessons.find((l) => l.id === lessonId);
    assert.deepEqual(row.quiz_review, { reviewed: 3, flagged: 0, pending: 0, checks: { reviewed: 0, pending: 0, dropped: 0 }, status: null, error: null }, 'seeded sections have no quick checks');
    const student = (await t.call('GET', '/api/lessons', { as: 'P00' })).body.lessons.find((l) => l.id === lessonId);
    assert.equal(student.quiz_review, undefined, 'students never get it');
  });

  it('after the job is done nothing is "not reviewed yet", even when the reviewer leaves cards out of its reply', async () => {
    const left = fakeAi({ review: (it) => (it.n % 2 === 0 ? { omit: true } : {}) });
    ai.generateJSON = left.generateJSON; // the runner and the routes share this fake
    await call('POST', `/api/lessons/${lessonId}/quiz-options`);
    await runner.idle();
    assert.equal(getJobStatus(t.db, lessonId).job.status, 'done');
    assert.equal(itemsToReview(t.db, lessonId).length, 0);
    assert.deepEqual(reviewSummary(t.db, lessonId), { reviewed: 3, flagged: 0, pending: 0 });
    const row = (await call('GET', '/api/lessons?counts=1')).body.lessons.find((l) => l.id === lessonId);
    assert.equal(row.quiz_review.pending, 0);
  });

  it('Review again needs the PIN, refuses a busy or unknown lesson, and reviews every card again', async () => {
    await call('POST', `/api/lessons/${lessonId}/quiz-options`);
    await runner.idle();
    const before = ai.calls.length;
    assert.equal((await call('POST', `/api/admin/lessons/${lessonId}/quiz-review`, { pin: null })).status, 401);
    assert.equal((await call('POST', '/api/admin/lessons/9999/quiz-review')).status, 404);
    t.db.prepare("UPDATE jobs SET status = 'running' WHERE lesson_id = ?").run(lessonId);
    assert.equal((await call('POST', `/api/admin/lessons/${lessonId}/quiz-review`)).status, 409);
    t.db.prepare("UPDATE jobs SET status = 'done' WHERE lesson_id = ?").run(lessonId);

    const res = await call('POST', `/api/admin/lessons/${lessonId}/quiz-review`);
    assert.equal(res.status, 202);
    assert.equal(res.body.lesson.status, 'ready', 'the lesson stays ready');
    await runner.idle();
    assert.deepEqual(labels(ai).slice(before), ['the quiz review']);
    assert.equal(getJobStatus(t.db, lessonId).lesson.status, 'ready');
  });

  it('the sections’ quick checks are reviewed in the same stage, counted on the row, and in Review again', async () => {
    const check = { question: 'What comes with each topic of the lesson?', answer: 'A right and a wrong answer.', evidence: 'with a right and a wrong answer' };
    t.db.prepare('UPDATE sections SET check_questions = ? WHERE lesson_id = ? AND position = 0').run(JSON.stringify([check]), lessonId);
    await call('POST', `/api/lessons/${lessonId}/quiz-options`);
    await runner.idle();
    assert.deepEqual(labels(ai), ['the quiz answer options', 'the quiz review', 'the quick check review']);
    const row = async () => (await call('GET', '/api/lessons?counts=1')).body.lessons.find((l) => l.id === lessonId).quiz_review;
    assert.deepEqual((await row()).checks, { reviewed: 1, pending: 0, dropped: 0 });

    // a changed check is all Review quiz looks at
    t.db.prepare('UPDATE sections SET check_questions = ? WHERE lesson_id = ? AND position = 0').run(JSON.stringify([{ ...check, question: 'What does each topic of the lesson come with?' }]), lessonId);
    assert.deepEqual((await row()).checks, { reviewed: 0, pending: 1, dropped: 0 });
    let before = ai.calls.length;
    assert.equal((await call('POST', `/api/admin/lessons/${lessonId}/quiz-review`)).status, 202);
    await runner.idle();
    assert.deepEqual(labels(ai).slice(before), ['the quick check review']);

    // nothing pending: Review again looks at the cards and the quick checks again
    before = ai.calls.length;
    await call('POST', `/api/admin/lessons/${lessonId}/quiz-review`);
    await runner.idle();
    assert.deepEqual(labels(ai).slice(before), ['the quiz review', 'the quick check review']);

    // a lesson with quick checks and no quiz questions can still be reviewed
    t.db.prepare('DELETE FROM flashcards WHERE lesson_id = ?').run(lessonId);
    assert.equal((await call('POST', `/api/admin/lessons/${lessonId}/quiz-review`)).status, 202);
    await runner.idle();
  });

  it('a failed review leaves the lesson ready and the job failed, for admin to retry', async () => {
    const real = ai.generateJSON;
    ai.generateJSON = (args) => (args.label === 'the quiz review' ? Promise.reject(new Error('provider down')) : real(args));
    await call('POST', `/api/lessons/${lessonId}/quiz-options`);
    await runner.idle();
    const { lesson, job } = getJobStatus(t.db, lessonId);
    assert.equal(lesson.status, 'ready');
    assert.deepEqual([job.stage, job.status], ['quiz_review', 'failed']);
    assert.match(job.error, /quiz review couldn’t finish/);
    const row = (await call('GET', '/api/lessons?counts=1')).body.lessons.find((l) => l.id === lessonId);
    assert.equal(row.quiz_review.status, 'failed');
    assert.equal(row.quiz_review.pending, 3);
  });
});

describe('quiz build options on a database from before migration 013', () => {
  it('reads no reviews and no families instead of failing (quiz:check opens any StudyRevr database)', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const { lessonId } = seedLesson(db, { n: 2 });
    db.exec('DROP TABLE quiz_reviews; ALTER TABLE lessons DROP COLUMN term_families;');
    const opts = quizBuildOptions(db, lessonId);
    assert.equal(opts.reviews.size, 0);
    assert.deepEqual(opts.termFamilies, []);
    const report = lessonLeakReport(db, lessonId);
    assert.equal(report.review.reviewed, 0);
    assert.match(formatReport(report), /Clean questions available/);
    db.close();
  });
});

describe('the quiz a student gets', () => {
  // a small seeded generator, so every run builds the same 40 quizzes
  const seeded = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const term = (id, front, back) => ({ id, kind: 'term', front, back, evidence: `${front} quote` });
  const cards = [
    term(1, 'Rivers', 'Flowing water that runs down to the sea.'),
    term(2, 'Lakes', 'Still water with land all around it.'),
    term(3, 'Glaciers', 'Slow sheets of ice on high mountains.'),
    term(4, 'Deserts', 'Dry land that gets very little rain.'),
    term(5, 'Oceans', 'Huge bodies of salt water between continents.'),
    { id: 6, kind: 'concept', front: 'Q6: what is said about the topic?', back: 'Topic answer 6: forests and valleys.', evidence: 'quote' },
    { id: 7, kind: 'concept', front: 'Q7: what is said about the topic?', back: 'Topic answer 7: islands and meadows.', evidence: 'quote' },
  ];
  const lessonText = 'The topic of this lesson: alpha, beta and gamma, with a right and a wrong answer. ' + cards.map((c) => `${c.front} ${c.back}`).join(' ');
  const distractors = new Map([
    [6, ['Alpha topic answer 6.', 'Beta topic answer 6.', 'Gamma topic answer 6.']],
    [7, ['Alpha topic answer 7.', 'Beta topic answer 7.', 'Gamma topic answer 7.']],
  ]);
  const flagged = 'Alpha topic answer 6.';
  const review = readReview({ card_hash: cardHash(cards[5]), card_flags: '[]', set_flags: '[]', true_flags: '[]', option_flags: JSON.stringify({ [flagged]: [{ flag: 'two_correct', why: 'x' }] }), round: 2 });

  it('never shows a flagged option, nor a term of the same family as the one asked (40 seeded quizzes)', () => {
    const asked = new Set();
    for (let seed = 1; seed <= 40; seed++) {
      const quiz = buildQuiz({ cards, distractors, lessonText, termFamilies: [['Lakes', 'Oceans']], reviews: new Map([[6, review]]), random: seeded(seed) });
      for (const q of quiz) {
        asked.add(q.flashcard_id);
        const shown = [...q.choices, q.statement ?? ''];
        assert.ok(!shown.includes(flagged), `seed ${seed}: the flagged option was shown`);
        if (q.flashcard_id === 2) assert.ok(!shown.includes('Oceans') && !shown.includes(cards[4].back), `seed ${seed}: Oceans offered for Lakes`);
        if (q.flashcard_id === 5) assert.ok(!shown.includes('Lakes') && !shown.includes(cards[1].back), `seed ${seed}: Lakes offered for Oceans`);
        if (q.flashcard_id === 6) assert.equal(q.type, 'tf', 'two clean options left: asked as Yes/No');
      }
    }
    for (const id of [2, 5, 6]) assert.ok(asked.has(id), `card ${id} was asked at least once`);
  });
});

describe('list-item cards and the wrong-answers stage', () => {
  it('asks the AI only for cards that are not a list item (theirs are the other items of the list)', async () => {
    const { SELF_INTRO_TEXT } = await import('./fixtures/self-intro.js');
    const { cardsNeedingDistractors } = await import('../src/quiz/distractors.js');
    const db = openDb(':memory:');
    runMigrations(db);
    const lessonId = Number(db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status) VALUES ('S', 'S.pptx', ?, 278, 'ready')").run(SELF_INTRO_TEXT).lastInsertRowid);
    const insert = db.prepare("INSERT INTO flashcards (lesson_id, kind, front, back, evidence, position) VALUES (?, 'concept', ?, ?, ?, ?)");
    insert.run(lessonId, 'Which key element of an effective self-introduction means being honest and natural?', 'Authentic Tone', 'Be honest and natural.', 1);
    const other = Number(insert.run(lessonId, 'How is an oral self-introduction given?', 'It is spoken directly to an audience.', 'An oral self-introduction is spoken directly to an audience.', 2).lastInsertRowid);
    assert.deepEqual(cardsNeedingDistractors(db, lessonId).map((c) => c.id), [other]);
    assert.deepEqual(cardsNeedingDistractors(db, lessonId, { includeFailing: true }).map((c) => c.id), [other]);
    db.close();
  });
});
