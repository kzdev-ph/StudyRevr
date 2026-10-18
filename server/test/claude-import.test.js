import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import JSZip from 'jszip';
import os from 'node:os';
import path from 'node:path';
import { createFileAi, promptHash, slug } from '../src/ai/file-ai.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { exportRound, ExchangeRefused, importExchange, lessonMeta, loadExchange } from '../src/services/claude-exchange.js';
import { resetLesson } from '../src/services/rebuild-lesson.js';
import { serverBlock } from '../src/services/server-check.js';
import { writePidFile } from '../src/server-pid.js';
import { addCodes, cleanCheckReview, cleanReview, groundedChecks, keepAllCandidates, quoteFromPrompt, startStudyApp, TEST_PIN } from './helpers.js';

// `npm run lesson:export` / `lesson:import`: a lesson written outside the app goes through the real pipeline with a
// file-backed AI, so the schemas and the code checks apply as they do to the Default AI's output.

const TEXT = [
  'Photosynthesis happens in the chloroplasts of plant cells, where light is turned into chemical energy for the plant.',
  'Cellular respiration releases the energy stored in glucose so that the cell can use it for its work.',
  'The water cycle moves water between the oceans, the air and the land through evaporation, rain and rivers.',
].join('\n\n');

// What a writer would answer to each prompt. `overrides[label prefix]` replaces one answer: (request, n) => value.
function writer(overrides = {}) {
  return (request, n) => {
    const { label, user } = request;
    for (const [prefix, fn] of Object.entries(overrides)) if (label.startsWith(prefix)) return fn(request, n);
    if (label.startsWith('the review sections')) {
      return { sections: [{ title: 'The lesson', content: 'Photosynthesis, respiration and the water cycle, as the lesson describes them.', check_questions: groundedChecks(user, 1), sources: [] }] };
    }
    if (label.startsWith('the key points')) return { key_points: ['Plants turn light into chemical energy.', 'Cells release energy from glucose.'] };
    if (label.startsWith('the key terms')) {
      return { terms: [{ term: 'Photosynthesis', definition: 'Light turned into chemical energy.', evidence: quoteFromPrompt(user, 12) }] };
    }
    if (label.startsWith('the merged key terms')) return keepAllCandidates(user);
    if (label.startsWith('the flashcards')) {
      return { cards: [{ question: 'What does the cell use the energy from glucose for?', answer: 'Its work.', evidence: 'releases the energy stored in glucose so that the cell can use it for its work' }] };
    }
    if (label.startsWith('the quiz answer options')) {
      const numbers = [...user.matchAll(/^\[(\d+)\] Question:/gm)].map((m) => Number(m[1]));
      return { items: numbers.map((x) => ({ n: x, wrong: ['Plants make more starch.', 'Cells store some water.', 'Light warms the leaves.'] })) };
    }
    if (label.startsWith('the quick checks')) return { checks: [] };
    if (label.startsWith('the quiz review')) return cleanReview(user);
    if (label.startsWith('the quick check review')) return cleanCheckReview(user);
    throw new Error(`the test writer has no answer for "${label}"`);
  };
}

describe('lesson export / import (a lesson written outside the app)', () => {
  let db;
  let folder;
  let lessonId;

  const addLesson = (title = 'Cells and water', text = TEXT) => {
    const id = Number(
      db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status, source_kind, source_numbers, source_total, origin) VALUES (?, 'cells.pptx', ?, 100, 'ready', 'slide', '[1,2,3]', 3, 'student')").run(title, text).lastInsertRowid,
    );
    return id;
  };
  const reply = (name, value) => fs.writeFileSync(path.join(folder, 'replies', `${name}.json`), typeof value === 'string' ? value : JSON.stringify(value));
  const meta = () => lessonMeta(db, lessonId, { chunkTokens: 30000, keyTermsMax: 12 });
  const round = () => exportRound({ folder, meta: loadExchange(folder).meta });

  // Plays the writer: export, answer every waiting prompt, export again, until nothing is waiting. -> the rounds' results
  const play = async (answer = writer(), { maxRounds = 14, partial = false } = {}) => {
    const rounds = [];
    const given = new Map();
    for (let i = 0; i < maxRounds; i++) {
      const result = i === 0 && !fs.existsSync(path.join(folder, 'lesson.json')) ? await exportRound({ folder, meta: meta() }) : await round();
      rounds.push(result);
      if (result.status !== 'waiting') return rounds;
      assert.deepEqual(result.invalid, [], `a reply was unusable: ${JSON.stringify(result.invalid)}`);
      for (const r of result.pending) {
        const n = (given.get(r.label) ?? 0) + 1;
        given.set(r.label, n);
        reply(r.name, answer(r, n));
      }
    }
    if (partial) return rounds;
    throw new Error('the writer never finished');
  };

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'studyrevr-exchange-'));
    lessonId = addLesson();
  });
  afterEach(() => {
    db.close();
    fs.rmSync(folder, { recursive: true, force: true });
  });

  describe('the file-backed AI', () => {
    it('names calls by label (a repeat gets -2) and ties a reply to the prompt it answers', async () => {
      assert.equal(slug('the quiz answer options (second try)'), 'the-quiz-answer-options-second-try');
      const schema = { safeParse: (v) => ({ success: typeof v?.a === 'string', data: v, error: { issues: [{ path: ['a'], message: 'Required' }] } }) };
      const hash = promptHash('s', 'u');
      const files = { x: '{"a":"ok"}', 'x-2': '{"a":"ok"}', bad: '{"a": 1}', junk: 'not json' };
      const ai = createFileAi({ replies: { read: (n) => files[n] ?? null, hashes: { x: hash, 'x-2': 'other', bad: hash, junk: hash } } });
      assert.deepEqual(await ai.generateJSON({ system: 's', user: 'u', schema, label: 'x' }), { a: 'ok' });
      ai.generateJSON({ system: 's', user: 'u', schema, label: 'x' }); // x-2: reply written for another prompt
      ai.generateJSON({ system: 's', user: 'u', schema, label: 'bad' });
      ai.generateJSON({ system: 's', user: 'u', schema, label: 'junk' });
      ai.generateJSON({ system: 's', user: 'u', schema, label: 'missing' });
      assert.equal(await ai.stalled, 'stalled');
      const report = ai.report();
      assert.deepEqual(report.pending.map((p) => [p.name, p.stale]), [['x-2', true], ['missing', false]]);
      assert.deepEqual(report.invalid.map((p) => p.name), ['bad', 'junk']);
      assert.match(report.invalid[0].problem, /does not match the required format \(a: Required\)/);
      assert.match(report.invalid[1].problem, /not valid JSON/);
      ai.cancel();
    });
  });

  describe('export rounds', () => {
    it('asks for the sections first, then each stage once the stage before it has replies', async () => {
      const rounds = await play();
      const asked = rounds.map((r) => r.pending.map((p) => p.label));
      assert.deepEqual(asked[0], ['the review sections']);
      assert.deepEqual(asked[1], ['the key points']);
      // the key points prompt carries the sections the writer produced
      assert.match(rounds[1].pending[0].user, /Photosynthesis, respiration and the water cycle/);
      assert.ok(asked.flat().includes('the key terms') && asked.flat().includes('the flashcards'));
      assert.ok(asked.flat().some((l) => l.startsWith('the quiz answer options')));
      assert.ok(asked.flat().some((l) => l.startsWith('the quiz review')));
      assert.equal(rounds.at(-1).status, 'complete');
      assert.match(fs.readFileSync(path.join(folder, 'NEXT.txt'), 'utf8'), /^COMPLETE/);
      // the folder: the lesson, its blocks, a prompt with its JSON shape for each waiting call
      assert.equal(fs.readFileSync(path.join(folder, 'raw_text.txt'), 'utf8'), TEXT);
      const blocks = JSON.parse(fs.readFileSync(path.join(folder, 'blocks.json'), 'utf8'));
      assert.deepEqual(blocks.map((b) => b.slide), [1, 2, 3]);
    });

    it('writes each waiting prompt with its system and user text, the reply file and the expected shape', async () => {
      await exportRound({ folder, meta: meta() });
      const files = fs.readdirSync(path.join(folder, 'prompts')).sort();
      assert.deepEqual(files, ['01-the-review-sections.json', '01-the-review-sections.md']);
      const prompt = JSON.parse(fs.readFileSync(path.join(folder, 'prompts', files[0]), 'utf8'));
      assert.equal(prompt.reply_file, 'replies/the-review-sections.json');
      assert.equal(prompt.expects.properties.sections.type, 'array');
      assert.match(prompt.user, /Photosynthesis happens/);
      assert.match(prompt.system, /Use ONLY the lesson text/);
      assert.match(fs.readFileSync(path.join(folder, 'prompts', files[1]), 'utf8'), /Write your reply to: replies\/the-review-sections\.json/);
    });

    it('lists a reply that fails its schema or is not JSON, and carries on only when it is fixed', async () => {
      await exportRound({ folder, meta: meta() });
      reply('the-review-sections', { sections: [{ title: '', content: 'x' }] });
      let result = await round();
      assert.equal(result.status, 'waiting');
      assert.equal(result.invalid[0].name, 'the-review-sections');
      assert.match(result.invalid[0].problem, /does not match the required format/);
      assert.match(fs.readFileSync(path.join(folder, 'NEXT.txt'), 'utf8'), /Fix these replies[^]*the-review-sections\.json/);
      reply('the-review-sections', 'here are your sections!');
      result = await round();
      assert.match(result.invalid[0].problem, /not valid JSON/);
      reply('the-review-sections', '```json\n' + JSON.stringify(writer()({ label: 'the review sections', user: result.pending[0]?.user ?? '' })) + '\n```');
      assert.equal((await round()).invalid.length, 0);
    });

    it('moves a reply to stale/ and asks again when the reply before it changed', async () => {
      await play(writer(), { maxRounds: 3, partial: true }); // sections, key points answered; key terms waiting
      assert.ok(fs.existsSync(path.join(folder, 'replies', 'the-key-points.json')));
      // the sections change, so the key points prompt (which contains them) is a different prompt now
      reply('the-review-sections', { sections: [{ title: 'Other', content: 'A different summary of the photosynthesis lesson text.', check_questions: [] }] });
      const result = await round();
      assert.equal(result.status, 'waiting');
      assert.deepEqual(result.pending.map((p) => [p.label, p.stale]), [['the key points', true]]);
      assert.ok(fs.existsSync(path.join(folder, 'stale', 'the-key-points.json')));
      assert.ok(!fs.existsSync(path.join(folder, 'replies', 'the-key-points.json')));
      assert.match(fs.readFileSync(path.join(folder, 'NEXT.txt'), 'utf8'), /older prompt, moved to stale/);
    });

    it('ignores a reply written for a prompt that was never exported', async () => {
      await exportRound({ folder, meta: meta() });
      reply('the-key-points', { key_points: ['Early.'] });
      const result = await round();
      assert.deepEqual(result.pending.map((p) => p.label), ['the review sections']);
      assert.ok(fs.existsSync(path.join(folder, 'replies', 'the-key-points.json')));
    });
  });

  describe('the code checks run on what was written', () => {
    it('drops a quick check, a key term and flashcards whose quote is not in the lesson or that give the answer away, and reports them', async () => {
      const rounds = await play(
        writer({
          'the review sections': ({ user }) => ({
            sections: [{ title: 'The lesson', content: 'Photosynthesis, respiration and the water cycle, as the lesson describes them.', check_questions: [...groundedChecks(user, 1), { question: 'Where do mitochondria sit?', answer: 'In the cell body.', evidence: 'Mitochondria sit in the cell body of animals' }] }],
          }),
          'the key terms': ({ user }) => ({
            terms: [
              { term: 'Photosynthesis', definition: 'Light turned into chemical energy.', evidence: quoteFromPrompt(user, 12) },
              { term: 'Mitochondria', definition: 'The powerhouse of the cell.', evidence: 'Mitochondria are the powerhouse of the cell' },
            ],
          }),
          'the flashcards': () => ({
            cards: [
              { question: 'What does the cell use the energy from glucose for?', answer: 'Its work.', evidence: 'releases the energy stored in glucose so that the cell can use it for its work' },
              { question: 'What powers the engines of tractors?', answer: 'Diesel fuel.', evidence: 'Tractor engines run on diesel fuel every day' },
              { question: 'What is the water cycle that moves water?', answer: 'The water cycle that moves water', evidence: 'The water cycle moves water between the oceans, the air and the land' },
            ],
          }),
        }),
      );
      const last = rounds.at(-1);
      assert.equal(last.status, 'complete');
      const log = last.log.join('\n');
      assert.match(log, /dropped key term "Mitochondria"/);
      assert.match(log, /dropped flashcard "What powers the engines of tractors\?"/);
      assert.match(log, /dropped flashcard "What is the water cycle that moves water\?"[^\n]*gives its answer away/);
      assert.match(log, /quick check "Where do mitochondria sit\?"[^\n]*dropped/);
      assert.match(fs.readFileSync(path.join(folder, 'NEXT.txt'), 'utf8'), /dropped key term "Mitochondria"/);
    });

    it('asks for a second try of a failing quick check as a prompt of its own', async () => {
      const bad = ({ user }) => ({ sections: [{ title: 'The lesson', content: 'Photosynthesis, respiration and the water cycle, as the lesson describes them.', check_questions: [{ question: 'Where?', answer: 'Mars.', evidence: 'Mars is red' }], sources: [] }] });
      const rounds = await play(writer({ 'the review sections': bad, 'the quick checks (second try)': () => ({ checks: [] }) }));
      const labels = rounds.flatMap((r) => r.pending.map((p) => p.label));
      assert.ok(labels.includes('the quick checks (second try)'));
      assert.equal(rounds.at(-1).status, 'complete');
    });
  });

  describe('import', () => {
    const idOf = (code) => db.prepare('SELECT id FROM participants WHERE code = ?').get(code).id;
    const count = (table, id) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE lesson_id = ?`).get(id).n;

    it('--as-new makes a separate teacher’s lesson titled "(Claude)", made_by claude-haiku, and leaves the original alone', async () => {
      db.prepare("UPDATE settings SET value = 'short' WHERE key = 'summary_length'").run();
      const hadMax = db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'flashcards_max'").get().n;
      await play();
      const done = await importExchange({ db, folder, asNew: true });
      assert.notEqual(done.lessonId, lessonId);
      const copy = db.prepare('SELECT * FROM lessons WHERE id = ?').get(done.lessonId);
      assert.equal(copy.title, 'Cells and water (Claude)');
      assert.equal(copy.origin, 'admin');
      assert.equal(copy.owner_participant_id, null);
      assert.equal(copy.shared_at, null);
      assert.equal(copy.status, 'ready');
      assert.equal(copy.made_by, 'claude-haiku');
      assert.equal(copy.thinking_level, null);
      assert.equal(copy.raw_text, TEXT);
      assert.equal(copy.source_numbers, '[1,2,3]');
      assert.equal(count('sections', done.lessonId), 1);
      assert.equal(count('key_points', done.lessonId), 2);
      assert.ok(count('flashcards', done.lessonId) >= 2);
      assert.equal(db.prepare('SELECT status FROM jobs WHERE lesson_id = ?').get(done.lessonId).status, 'done');
      // the original is untouched: still the pipeline's default author, nothing generated for it
      const original = db.prepare('SELECT origin, made_by, title FROM lessons WHERE id = ?').get(lessonId);
      assert.deepEqual({ ...original }, { origin: 'student', made_by: 'gemini', title: 'Cells and water' });
      assert.equal(count('sections', lessonId), 0);
      // the settings the export used for its prompts are not left behind
      assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'summary_length'").get().value, 'short');
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'flashcards_max'").get().n, hadMax);
    });

    it('replaces the lesson in place under the rebuild rules, keeping its id, title and owner', async () => {
      addCodes(db, 'P00', 'P01');
      db.prepare('UPDATE lessons SET owner_participant_id = ? WHERE id = ?').run(idOf('P01'), lessonId);
      db.prepare("INSERT INTO sections (lesson_id, position, title, content) VALUES (?, 1, 'Old', 'old')").run(lessonId);
      await play();
      const done = await importExchange({ db, folder });
      assert.equal(done.lessonId, lessonId);
      const l = db.prepare('SELECT title, origin, owner_participant_id, made_by, status FROM lessons WHERE id = ?').get(lessonId);
      assert.deepEqual({ ...l }, { title: 'Cells and water', origin: 'student', owner_participant_id: idOf('P01'), made_by: 'claude-haiku', status: 'ready' });
      assert.equal(db.prepare('SELECT title FROM sections WHERE lesson_id = ?').get(lessonId).title, 'The lesson');
    });

    it('refuses to replace a lesson a participant other than P00 has records on, and writes nothing', async () => {
      addCodes(db, 'P01');
      db.prepare("INSERT INTO flashcards (lesson_id, kind, front, back, evidence, position) VALUES (?, 'concept', 'Q', 'A', 'e', 1)").run(lessonId);
      const card = db.prepare('SELECT id FROM flashcards WHERE lesson_id = ?').get(lessonId).id;
      db.prepare('INSERT INTO flashcard_reviews (participant_id, flashcard_id, rating) VALUES (?, ?, 3)').run(idOf('P01'), card);
      await play();
      await assert.rejects(importExchange({ db, folder }), /can't be made again/);
      assert.equal(count('flashcards', lessonId), 1);
      assert.equal(db.prepare('SELECT made_by FROM lessons WHERE id = ?').get(lessonId).made_by, 'gemini');
      // --as-new has no such rule: nothing of the original is touched
      const done = await importExchange({ db, folder, asNew: true });
      assert.equal(db.prepare('SELECT made_by FROM lessons WHERE id = ?').get(done.lessonId).made_by, 'claude-haiku');
    });

    it('refuses to replace a lesson whose text changed since the export', async () => {
      await play();
      db.prepare("UPDATE lessons SET raw_text = raw_text || ' More.' WHERE id = ?").run(lessonId);
      await assert.rejects(importExchange({ db, folder }), /different text/);
    });

    it('refuses a folder with a missing, stale or unusable reply, and creates nothing', async () => {
      await play();
      const lessons = () => db.prepare('SELECT COUNT(*) AS n FROM lessons').get().n;
      const before = lessons();
      fs.rmSync(path.join(folder, 'replies', 'the-key-points.json'));
      await assert.rejects(importExchange({ db, folder, asNew: true }), (e) => e instanceof ExchangeRefused && /not ready to import/.test(e.message) && /the-key-points/.test(e.message));
      reply('the-key-points', { key_points: [] });
      await assert.rejects(importExchange({ db, folder, asNew: true }), /Fix these replies/);
      assert.equal(lessons(), before);
    });

    it('rolls the whole import back when the real run fails after the checks passed', async () => {
      await play();
      const before = db.prepare('SELECT COUNT(*) AS n FROM lessons').get().n;
      // a database trigger makes saving the flashcards fail, as a real failure in the middle of the run would
      db.exec("CREATE TRIGGER no_cards BEFORE INSERT ON flashcards BEGIN SELECT RAISE(ABORT, 'boom'); END");
      await assert.rejects(importExchange({ db, folder, asNew: true }));
      db.exec('DROP TRIGGER no_cards');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lessons').get().n, before);
      assert.equal(db.inTransaction, false);
    });

    it('an import over a lesson the Default AI had changed makes it Claude’s again, not mixed', async () => {
      db.prepare("UPDATE lessons SET made_by = 'mixed' WHERE id = ?").run(lessonId);
      await play();
      await importExchange({ db, folder });
      assert.equal(db.prepare('SELECT made_by FROM lessons WHERE id = ?').get(lessonId).made_by, 'claude-haiku');
    });

    it('a rebuild sets the author back to the pipeline’s', async () => {
      db.prepare("UPDATE lessons SET made_by = 'claude-haiku' WHERE id = ?").run(lessonId);
      resetLesson(db, lessonId);
      assert.equal(db.prepare('SELECT made_by FROM lessons WHERE id = ?').get(lessonId).made_by, 'gemini');
    });
  });

  describe('running server', () => {
    it('blocks both scripts while a server runs on the database', async () => {
      const dbPath = path.join(folder, 'study.db');
      assert.equal(await serverBlock({ dbPath, port: 1 }), null);
      writePidFile(dbPath, process.pid); // this process stands in for a running server
      assert.match(await serverBlock({ dbPath, port: 1 }), /server is running \(process \d+\)/);
    });
  });
});

describe('made_by on lessons', () => {
  let t;
  beforeEach(async () => {
    t = await startStudyApp();
    addCodes(t.db, 'P01');
    t.db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status, made_by) VALUES ('Imported', 'i.pptx', 'text', 10, 'ready', 'claude-haiku'), ('Made', 'm.pptx', 'text', 10, 'ready', 'gemini')").run();
  });
  afterEach(() => t.close());

  it('is shown to admin only, and exported in lessons.csv with a codebook entry', async () => {
    const admin = await t.call('GET', '/api/lessons', { pin: TEST_PIN });
    assert.deepEqual(admin.body.lessons.map((l) => [l.title, l.made_by]).sort(), [['Imported', 'claude-haiku'], ['Made', 'gemini']]);
    const student = await t.call('GET', '/api/lessons', { as: 'P01' });
    assert.ok(student.body.lessons.length >= 2);
    for (const l of student.body.lessons) assert.ok(!('made_by' in l), 'a student never receives made_by');
    const csv = await t.call('GET', '/api/admin/export/lessons.csv', { pin: TEST_PIN, raw: true });
    const text = await csv.text();
    assert.match(text.split('\r\n')[0], /source_kind,made_by,thinking_level/);
    assert.match(text, /Imported[^\r\n]*claude-haiku/);
    const zipRes = await t.call('GET', '/api/admin/export.zip', { pin: TEST_PIN, raw: true });
    const zip = await JSZip.loadAsync(Buffer.from(await zipRes.arrayBuffer()));
    assert.match(await zip.file('README.txt').async('string'), /made_by\s+who wrote the lesson's generated content[^]*claude-haiku = written offline/);
  });
});
