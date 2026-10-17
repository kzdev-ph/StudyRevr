import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, runMigrations } from '../src/db/index.js';
import { comparable } from '../src/pipeline/evidence.js';
import { generateSections } from '../src/pipeline/generate.js';
import { checkQuickCheck, groundQuickChecks, RETRY_LABEL, unchangedCheck } from '../src/pipeline/quick-checks.js';
import { checkItems, checkSummary, checksToReview, resetChecks, reviewChecks } from '../src/services/check-review.js';
import { formatReport, lessonLeakReport } from '../src/quiz/check.js';
import { SELF_INTRO_TEXT } from './fixtures/self-intro.js';

const quiet = { error() {}, warn() {}, log() {}, info() {} };
const KEY = comparable(SELF_INTRO_TEXT);

// Lesson 10's quick checks as the AI made them, each with the quote it would give. S3 invented a reason: the IMPORTANCE
// slide only lists "Starts conversations effectively.", "Shows professionalism." and "Builds confidence.".
const S1 = { question: 'What is a self-introduction?', answer: 'It is a brief presentation of yourself that helps others know who you are.', evidence: 'A self-introduction is a brief presentation of yourself that helps others know who you are.' };
const S2 = { question: 'What are two purposes of a self-introduction?', answer: 'To introduce yourself clearly and to create a positive first impression.', evidence: 'Introduce yourself clearly.\n- Create a positive first impression.' };
const S3 = { question: 'Why is starting conversations effectively important?', answer: 'It is one of the ways a self-introduction is important because it also shows professionalism and builds confidence.', evidence: 'Starts conversations effectively.' };
const S4 = { question: 'What does authentic tone mean in a self-introduction?', answer: 'It means to be honest and natural.', evidence: 'Authentic Tone\n– Be honest and natural.' };
const S5 = { question: 'What is a multimodal self-introduction?', answer: 'It combines different ways of communicating.', evidence: 'A multimodal self-introduction combines different ways of communicating.' };

describe('quick checks are grounded in the lesson', () => {
  it('lesson 10: S1, S2, S4 and S5 pass; S3, whose answer invents a reason, does not', () => {
    for (const check of [S1, S2, S4, S5]) assert.ok(checkQuickCheck(check, KEY).ok, `${check.question}: ${checkQuickCheck(check, KEY).reason}`);
    assert.deepEqual(checkQuickCheck(S3, KEY), { ok: false, reason: 'it asks why, and the lesson’s quote gives no reason' });
    // the same invented "because" under a "what" question, and with a quote that holds every listed item
    const what = { ...S3, question: 'What is one way a self-introduction is important?', evidence: 'Builds confidence.\n- Helps people remember you.\n- Starts conversations effectively.\n- Shows professionalism.' };
    assert.deepEqual(checkQuickCheck(what, KEY), { ok: false, reason: 'the answer gives a reason the lesson’s quote doesn’t state' });
    assert.ok(checkQuickCheck({ ...what, answer: 'It starts conversations effectively.' }, KEY).ok, 'the same question, answered as the lesson says it');
  });

  it('the quote must be in the lesson, say more than the question, and state the answer', () => {
    assert.equal(checkQuickCheck({ ...S1, evidence: 'A self-introduction is your whole life story.' }, KEY).reason, 'evidence not found in the lesson text');
    assert.equal(checkQuickCheck({ ...S1, evidence: '' }, KEY).reason, 'no evidence quote');
    assert.equal(checkQuickCheck({ ...S5, evidence: 'MULTIMODAL SELF-INTRODUCTION' }, KEY).reason, 'evidence is only the term or a title');
    assert.equal(checkQuickCheck({ ...S5, answer: 'It mixes songs, dance and video to impress an audience.' }, KEY).reason, 'the answer says more than its quote');
    assert.equal(checkQuickCheck({ ...S5, answer: 'A multimodal self-introduction.' }, KEY).reason, 'the answer only repeats the question');
    assert.equal(checkQuickCheck({ question: '', answer: 'x', evidence: 'y' }, KEY).reason, 'no question or answer');
  });

  it('a "why" question passes when the quote states the reason (English and Filipino)', () => {
    const text = 'Plants need light because light drives photosynthesis.\n\nMahalaga ang wika dahil ito ay nagbubuklod sa mga tao.';
    const key = comparable(text);
    assert.ok(checkQuickCheck({ question: 'Why do plants need light?', answer: 'Light drives photosynthesis.', evidence: 'Plants need light because light drives photosynthesis.' }, key).ok);
    assert.ok(checkQuickCheck({ question: 'Bakit mahalaga ang wika?', answer: 'Dahil ito ay nagbubuklod sa mga tao.', evidence: 'Mahalaga ang wika dahil ito ay nagbubuklod sa mga tao.' }, key).ok);
    assert.equal(checkQuickCheck({ question: 'How does light cause growth in plants?', answer: 'Light drives photosynthesis.', evidence: 'light drives photosynthesis' }, key).reason, 'it asks why, and the lesson’s quote gives no reason');
  });

  it('unchangedCheck: the same content words in question and answer', () => {
    assert.ok(unchangedCheck(S5, { ...S5, question: 'What is a multimodal self-introduction, then?' }));
    assert.ok(!unchangedCheck(S5, { ...S5, answer: 'It mixes different ways of communicating.' }));
  });

  describe('the sections stage', () => {
    const section = (title, checks) => ({ title, content: `${title}: what the section says.`, check_questions: checks, sources: null });
    const fakeAi = (reply) => {
      const ai = {
        calls: [],
        async generateJSON({ schema, label, user }) {
          ai.calls.push({ label, user });
          if (label !== RETRY_LABEL) throw new Error(`unexpected call: ${label}`);
          return schema.parse(typeof reply === 'function' ? reply(user) : reply);
        },
      };
      return ai;
    };

    it('keeps what holds up, asks for the failing ones again in one call, and drops what still fails', async () => {
      const sections = [section('What is it', [S1]), section('Importance', [S3]), section('Purpose', [S2, { ...S2, question: 'What is the third purpose?', evidence: 'not in the lesson at all' }])];
      const ai = fakeAi({
        checks: [
          { n: 1, question: 'What is one way a self-introduction is important?', answer: 'It starts conversations effectively.', evidence: 'Starts conversations effectively.' },
          { n: 2, question: 'What is the third purpose?', answer: 'To build relationships and trust.', evidence: 'invented again' },
        ],
      });
      const dropped = [];
      const out = await groundQuickChecks({ ai, sections, rawText: SELF_INTRO_TEXT, onDrop: (d) => dropped.push(d) });
      assert.deepEqual(ai.calls.map((c) => c.label), [RETRY_LABEL], 'one call for the whole lesson');
      assert.match(ai.calls[0].user, /What was wrong: it asks why, and the lesson’s quote gives no reason/);
      assert.match(ai.calls[0].user, /What was wrong: evidence not found in the lesson text/);
      assert.deepEqual(out[0].check_questions, [S1]);
      assert.deepEqual(out[1].check_questions.map((c) => c.answer), ['It starts conversations effectively.']);
      assert.deepEqual(out[2].check_questions, [{ ...S2, evidence: 'Introduce yourself clearly. - Create a positive first impression.' }], 'the quote is tidied to one line');
      assert.deepEqual(dropped.map((d) => d.reason), ['evidence not found in the lesson text']);
    });

    it('nothing failing: no call. A failed call or an unchanged rewrite drops the check and never fails the stage', async () => {
      const none = fakeAi({ checks: [] });
      await groundQuickChecks({ ai: none, sections: [section('A', [S1])], rawText: SELF_INTRO_TEXT });
      assert.equal(none.calls.length, 0);

      const down = { calls: 0, async generateJSON() { this.calls++; throw new Error('provider down'); } };
      const out = await groundQuickChecks({ ai: down, sections: [section('A', [S3])], rawText: SELF_INTRO_TEXT });
      assert.deepEqual(out[0].check_questions, [], 'a section may end with no quick check');

      const same = fakeAi({ checks: [{ n: 1, question: S3.question, answer: `${S3.answer}`, evidence: 'Builds confidence. - Helps people remember you. - Starts conversations effectively. - Shows professionalism.' }] });
      const dropped = [];
      const kept = await groundQuickChecks({ ai: same, sections: [section('A', [S3])], rawText: SELF_INTRO_TEXT, onDrop: (d) => dropped.push(d.reason) });
      assert.deepEqual([kept[0].check_questions, dropped], [[], ['came back unchanged']]);
    });

    it('the sections reply may have no quick checks, or checks without a quote (dropped in code, not a failed call)', async () => {
      const ai = {
        async generateJSON({ schema }) {
          return schema.parse({ sections: [{ title: 'Cover', content: 'Nothing but the lesson title here.', check_questions: [] }, { title: 'B', content: 'Some content long enough.', check_questions: [{ question: 'Q?', answer: 'A.' }, { question: '' }] }] });
        },
      };
      const sections = await generateSections({ ai, chunks: [{ index: 0, text: 'x', tokens: 100 }] });
      assert.deepEqual(sections.map((s) => s.check_questions), [[], [{ question: 'Q?', answer: 'A.', evidence: '' }]]);
    });
  });
});

describe('the quick check review', () => {
  let db;
  let lessonId;
  const sectionIds = [];
  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    lessonId = Number(db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status) VALUES ('Self-intro', 's.pptx', ?, 150, 'ready')").run(SELF_INTRO_TEXT).lastInsertRowid);
    const add = db.prepare('INSERT INTO sections (lesson_id, position, title, content, check_questions, filipino_version) VALUES (?, ?, ?, ?, ?, ?)');
    sectionIds.length = 0;
    for (const [i, [title, checks]] of [['What is a Self-Introduction?', [S1]], ['Importance', [{ ...S3, question: 'What is one way a self-introduction is important?', evidence: 'Builds confidence. - Helps people remember you. - Starts conversations effectively. - Shows professionalism.' }]], ['Key elements', [S4, S2]], ['Cover', []]].entries()) {
      sectionIds.push(Number(add.run(lessonId, i + 1, title, `${title} explained.`, JSON.stringify(checks), '{"title":"T","content":"C","check_questions":[]}').lastInsertRowid));
    }
  });
  afterEach(() => db.close());

  // review(section, q, label) -> [{ flag, why }] for check q of a section; rewrite(n) -> a new check
  const fakeAi = ({ review = () => [], rewrite = () => null } = {}) => {
    const ai = {
      calls: [],
      async generateJSON({ schema, label, user }) {
        ai.calls.push({ label, user });
        if (label.startsWith('the quick check review')) {
          const blocks = user.split(/^\[(\d+)\] Section: (.*)$/m);
          const sections = [];
          for (let i = 1; i < blocks.length; i += 3) {
            const qs = [...blocks[i + 2].matchAll(/^ {4}q(\d+): Question: (.*)$/gm)];
            sections.push({ n: Number(blocks[i]), checks: qs.flatMap((m) => review(blocks[i + 1], { q: Number(m[1]), question: m[2] }, label).map((f) => ({ q: Number(m[1]), ...f }))) });
          }
          return schema.parse({ sections });
        }
        if (label === 'the quick checks the review flagged') {
          const numbers = [...user.matchAll(/^\[(\d+)\] Section:/gm)].map((m) => Number(m[1]));
          return schema.parse({ checks: numbers.map((n) => ({ n, ...(rewrite(n) ?? { question: '' }) })) });
        }
        throw new Error(`unexpected call: ${label}`);
      },
    };
    return ai;
  };
  const labels = (ai) => ai.calls.map((c) => c.label);
  const checksOf = (id) => JSON.parse(db.prepare('SELECT check_questions FROM sections WHERE id = ?').get(id).check_questions);
  const reviewOf = (id) => JSON.parse(db.prepare('SELECT check_review FROM sections WHERE id = ?').get(id).check_review ?? 'null');
  const filipino = (id) => db.prepare('SELECT filipino_version FROM sections WHERE id = ?').get(id).filipino_version;

  it('reviews every section with quick checks in one call and caches it; a section with none needs nothing', async () => {
    assert.equal(checkItems(db, lessonId).length, 3);
    const ai = fakeAi();
    const result = await reviewChecks({ db, ai, lessonId, madeBy: { provider: 'google', model: 'gemini-3.5-flash-lite' }, log: quiet });
    assert.deepEqual(labels(ai), ['the quick check review']);
    assert.match(ai.calls[0].user, /q1: Question: What is a self-introduction\?\n {8}Answer: .*\n {8}From the lesson: "A self-introduction is a brief/);
    assert.deepEqual(result, { reviewed: 4, flagged: 0, rewritten: 0, dropped: 0, error: null });
    assert.equal(reviewOf(sectionIds[0]).made_by, 'google/gemini-3.5-flash-lite');
    assert.equal(filipino(sectionIds[0]) !== null, true, 'nothing changed: the Taglish version stays');
    assert.deepEqual(checkSummary(db, lessonId), { reviewed: 4, pending: 0, dropped: 0 });

    const again = fakeAi();
    await reviewChecks({ db, ai: again, lessonId, log: quiet });
    assert.deepEqual(labels(again), [], 'cached');

    // a section's checks changed: only that one is reviewed again
    db.prepare('UPDATE sections SET check_questions = ? WHERE id = ?').run(JSON.stringify([S5]), sectionIds[2]);
    assert.deepEqual(checksToReview(db, lessonId).map((x) => x.section.id), [sectionIds[2]]);
    // Review again: everything
    await reviewChecks({ db, ai: fakeAi(), lessonId, log: quiet });
    assert.equal(resetChecks(db, lessonId), 3);
    assert.equal(checksToReview(db, lessonId).length, 3);
  });

  it('a flagged check is written again, grounded and reviewed again; still flagged it is dropped', async () => {
    const flagImportance = (title, check, label) => (label === 'the quick check review' && title === 'Importance' ? [{ flag: 'not_in_lesson', why: 'invents a reason' }] : []);
    const ai = fakeAi({
      review: (title, check, label) => [...flagImportance(title, check, label), ...(title === 'Key elements' && check.q === 2 ? [{ flag: 'not_answered', why: 'the section is about elements' }, { flag: 'bogus', why: 'x' }] : [])],
      rewrite: (n) => (n === 1 ? { question: 'What is one way a self-introduction is important?', answer: 'It starts conversations effectively.', evidence: 'Starts conversations effectively.' } : null),
    });
    const result = await reviewChecks({ db, ai, lessonId, log: quiet });
    assert.deepEqual(labels(ai), ['the quick check review', 'the quick checks the review flagged', 'the quick check review (after fixes)']);
    assert.match(ai.calls[1].user, /What was wrong: not_in_lesson: invents a reason/);
    assert.deepEqual(result, { reviewed: 4, flagged: 2, rewritten: 1, dropped: 1, error: null });

    assert.deepEqual(checksOf(sectionIds[1]).map((c) => c.answer), ['It starts conversations effectively.'], 'written again and passed round 2');
    assert.equal(reviewOf(sectionIds[1]).round, 2);
    assert.equal(filipino(sectionIds[1]), null, 'its checks changed: the cached Taglish version (with their translations) is cleared');
    assert.deepEqual(checksOf(sectionIds[2]).map((c) => c.question), [S4.question], 'not written again (empty reply): dropped');
    assert.deepEqual(reviewOf(sectionIds[2]).dropped.map((d) => d.why), ['not_answered: the section is about elements'], 'an unknown flag is ignored');
    assert.deepEqual(checkSummary(db, lessonId), { reviewed: 3, pending: 0, dropped: 1 });
    assert.equal(filipino(sectionIds[0]) !== null, true);

    // npm run quiz:check shows it
    assert.match(formatReport(lessonLeakReport(db, lessonId)), /Quick checks: 3; AI review: 3 reviewed, 1 dropped\n {4}"Key elements": "What are two purposes of a self-introduction\?" dropped \(not_answered: the section is about elements\)/);
  });

  it('a rewrite that comes back unchanged, or is still flagged in round 2, is dropped; nothing is left pending', async () => {
    const importance = (title) => title === 'Importance';
    const unchanged = fakeAi({
      review: (title, _c, label) => (importance(title) && label === 'the quick check review' ? [{ flag: 'not_in_lesson', why: 'invents a reason' }] : []),
      rewrite: () => ({ question: 'What is one way a self-introduction is important?', answer: S3.answer, evidence: 'Builds confidence. - Helps people remember you. - Starts conversations effectively. - Shows professionalism.' }),
    });
    await reviewChecks({ db, ai: unchanged, lessonId, log: quiet });
    assert.deepEqual(labels(unchanged), ['the quick check review', 'the quick checks the review flagged'], 'no round 2 for nothing new');
    assert.deepEqual(checksOf(sectionIds[1]), []);
    assert.equal(checksToReview(db, lessonId).length, 0);

    db.prepare('UPDATE sections SET check_questions = ?, check_review = NULL WHERE id = ?').run(JSON.stringify([S1]), sectionIds[1]);
    const stubborn = fakeAi({
      review: (title) => (importance(title) ? [{ flag: 'vague', why: 'two answers' }] : []),
      rewrite: () => ({ question: 'What is a self-introduction in short?', answer: 'A brief presentation of yourself.', evidence: 'A self-introduction is a brief presentation of yourself' }),
    });
    await reviewChecks({ db, ai: stubborn, lessonId, log: quiet });
    assert.deepEqual(labels(stubborn), ['the quick check review', 'the quick checks the review flagged', 'the quick check review (after fixes)']);
    assert.deepEqual(checksOf(sectionIds[1]), [], 'still flagged after the fix: dropped');
    assert.equal(checksToReview(db, lessonId).length, 0);
  });

  it('a reply that lists only the flagged sections (lesson 12: none) counts the rest as clean, so nothing stays pending', async () => {
    const ai = { calls: 0, async generateJSON({ schema }) { this.calls++; return schema.parse({ sections: [] }); } };
    const result = await reviewChecks({ db, ai, lessonId, log: quiet });
    assert.deepEqual([ai.calls, result.reviewed, result.flagged], [1, 4, 0]);
    assert.equal(checksToReview(db, lessonId).length, 0);
  });

  it('a failed review call saves nothing and reports the error (the stage then fails for admin to retry)', async () => {
    const ai = { async generateJSON() { throw new Error('provider down'); } };
    const result = await reviewChecks({ db, ai, lessonId, log: quiet });
    assert.equal(result.error, 'provider down');
    assert.equal(checksToReview(db, lessonId).length, 3);
  });
});
