import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Document, Packer, Paragraph } from 'docx';
import PptxGenJS from 'pptxgenjs';
import { AiError } from '../src/ai/client.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { createPipelineRunner } from '../src/pipeline/runner.js';
import { UPLOAD_FAILED_MESSAGE } from '../src/routes/lessons.js';
import { BURST_MAX, QUEUE_LIMIT } from '../src/services/student-upload.js';
import { addCodes, keepAllCandidates, quoteFromPrompt, seedLesson, startStudyApp, TEST_PIN } from './helpers.js';

// Phase 7B: students upload their own lessons (off by default). The switch, the limits, the content checks, the events,
// the failure text, the delete and share rules, and one processing job at a time.

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const quiet = { error() {}, warn() {}, log() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const makeDocx = (paragraphs) => Packer.toBuffer(new Document({ sections: [{ children: paragraphs.map((p) => new Paragraph(p)) }] }));
async function makePptx(slides) {
  const pptx = new PptxGenJS();
  for (const [title, body] of slides) {
    const slide = pptx.addSlide();
    slide.addText(title, { x: 0.5, y: 0.3, w: 9, h: 1, fontSize: 28 });
    slide.addText(body, { x: 0.5, y: 1.5, w: 9, h: 3, fontSize: 18 });
  }
  return pptx.write({ outputType: 'nodebuffer' });
}
const goodDocx = (word = 'Photosynthesis') => makeDocx([`${word} converts light energy into chemical energy stored in glucose.`, `${word} happens in the chloroplasts of plant cells.`]);

describe('student uploads', () => {
  let t;
  const P01 = { as: 'P01' };
  const P02 = { as: 'P02' };
  const admin = { as: 'P00', pin: TEST_PIN };

  const settingsRow = (key) => t.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
  const turnOn = (perDay = 2) => {
    t.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('allow_student_uploads', 'true'), ('student_uploads_per_day', ?)").run(String(perDay));
  };
  const upload = async (buffer, filename, who = P01, mime = DOCX_MIME) => {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), filename);
    const headers = {};
    if (who.as) headers['x-participant'] = who.as;
    if (who.pin) headers['x-admin-pin'] = who.pin;
    const res = await globalThis.fetch(`${t.base}/api/lessons`, { method: 'POST', headers, body: form });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const events = (code) =>
    t.db
      .prepare('SELECT e.type, e.actor, e.lesson_id, e.lesson_title, e.detail, e.study_date FROM lesson_events e JOIN participants p ON p.id = e.participant_id WHERE p.code = ? ORDER BY e.id')
      .all(code);

  beforeEach(async () => {
    t = await startStudyApp();
    addCodes(t.db, 'P01', 'P02');
  });
  afterEach(() => t.close());

  describe('the switch', () => {
    it('is off by default: the student gets 403 student_uploads_off and nothing is created', async () => {
      assert.equal(settingsRow('allow_student_uploads'), 'false');
      const res = await upload(await goodDocx(), 'plants.docx');
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'student_uploads_off');
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM lessons').get().n, 0);
      assert.deepEqual(events('P01'), []);
      const mine = await t.call('GET', '/api/my-uploads', P01);
      assert.equal(mine.body.allowed, false);
    });

    it('does not stop the teacher: an upload with the PIN is the teacher\'s lesson', async () => {
      const res = await upload(await goodDocx(), 'teacher.docx', admin);
      assert.equal(res.status, 201);
      assert.equal(res.body.lesson.origin, 'admin');
      assert.equal(res.body.lesson.mine, false);
      assert.equal(t.db.prepare('SELECT owner_participant_id AS o FROM lessons').get().o, null);
      assert.deepEqual(events('P00'), []);
    });

    it('needs a participant code', async () => {
      turnOn();
      const res = await upload(await goodDocx(), 'plants.docx', {});
      assert.equal(res.status, 401);
    });

    it('a wrong PIN is not an upload as a student either (it counts toward the lockout)', async () => {
      turnOn();
      const res = await upload(await goodDocx(), 'plants.docx', { as: 'P01', pin: 'wrong-pin' });
      assert.equal(res.status, 401);
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM lessons').get().n, 0);
    });

    it('switching it off later only stops new uploads: the lessons and the records stay', async () => {
      turnOn();
      assert.equal((await upload(await goodDocx(), 'plants.docx')).status, 201);
      const put = await t.call('PUT', '/api/settings', { ...admin, body: { allow_student_uploads: false } });
      assert.equal(put.status, 200, JSON.stringify(put.body));
      assert.equal(put.body.allow_student_uploads, false);
      assert.equal((await upload(await goodDocx('Mitosis'), 'cells.docx')).status, 403);
      const list = await t.call('GET', '/api/lessons', P01);
      assert.equal(list.body.lessons.length, 1);
      assert.equal(list.body.lessons[0].mine, true);
      assert.equal((await t.call('GET', '/api/my-uploads', P01)).body.allowed, false);
    });

    it('changes to the two settings are logged in admin_events', async () => {
      await t.call('PUT', '/api/settings', { ...admin, body: { allow_student_uploads: true, student_uploads_per_day: 3 } });
      await t.call('PUT', '/api/settings', { ...admin, body: { allow_student_uploads: true, student_uploads_per_day: 3 } }); // no change: not logged again
      await t.call('PUT', '/api/settings', { ...admin, body: { allow_student_uploads: false } });
      const rows = t.db.prepare("SELECT type, detail FROM admin_events WHERE type = 'setting_changed' ORDER BY id").all();
      assert.deepEqual(rows.map((r) => r.detail), ['allow_student_uploads=true', 'student_uploads_per_day=3', 'allow_student_uploads=false']);
    });

    it('the settings only accept whole numbers from 0 to 20', async () => {
      for (const n of [-1, 21, 1.5]) assert.equal((await t.call('PUT', '/api/settings', { ...admin, body: { student_uploads_per_day: n } })).status, 400, String(n));
      assert.equal((await t.call('PUT', '/api/settings', { ...admin, body: { student_uploads_per_day: 0 } })).status, 200);
    });
  });

  describe('an upload', () => {
    beforeEach(() => turnOn());

    it('is private to its owner, queued like any lesson, and logged', async () => {
      const res = await upload(await goodDocx(), 'plants.docx');
      assert.equal(res.status, 201);
      const { lesson } = res.body;
      assert.equal(lesson.origin, 'student');
      assert.equal(lesson.mine, true);
      assert.equal(lesson.shared, false);
      assert.equal(lesson.status, 'processing');
      assert.equal(lesson.can_delete, true);
      assert.equal('owner_code' in lesson, false, 'a student is never told a code');
      assert.deepEqual(res.body.uploads, { allowed: true, per_day: 2, used_today: 1, left_today: 1, max_mb: 1 });
      const row = t.db.prepare('SELECT origin, owner_participant_id, shared_at FROM lessons WHERE id = ?').get(lesson.id);
      assert.equal(row.origin, 'student');
      assert.equal(row.shared_at, null);
      assert.equal(t.db.prepare("SELECT code FROM participants WHERE id = ?").get(row.owner_participant_id).code, 'P01');
      assert.equal(t.db.prepare("SELECT status FROM jobs WHERE lesson_id = ?").get(lesson.id).status, 'queued');
      assert.deepEqual(events('P01'), [{ type: 'lesson_uploaded', actor: 'student', lesson_id: lesson.id, lesson_title: 'plants', detail: 'plants.docx', study_date: '2026-10-05' }]);
    });

    it('admin sees whose it is', async () => {
      const { lesson } = (await upload(await goodDocx(), 'plants.docx')).body;
      const list = await t.call('GET', '/api/lessons', admin);
      const row = list.body.lessons.find((l) => l.id === lesson.id);
      assert.equal(row.owner_code, 'P01');
      assert.equal(row.origin, 'student');
      assert.equal(row.shared, false);
    });

    it('/my-uploads says how many are left', async () => {
      assert.deepEqual((await t.call('GET', '/api/my-uploads', P01)).body, { allowed: true, per_day: 2, used_today: 0, left_today: 2, max_mb: 1 });
      assert.equal((await t.call('GET', '/api/my-uploads', {})).status, 401);
    });

    it('keeps no copy of the file: only the extracted text is stored', async () => {
      const { lesson } = (await upload(await goodDocx(), 'plants.docx')).body;
      const row = t.db.prepare('SELECT raw_text FROM lessons WHERE id = ?').get(lesson.id);
      assert.match(row.raw_text, /Photosynthesis converts light energy/);
      const columns = t.db.prepare('PRAGMA table_info(lessons)').all().map((c) => c.name);
      assert.ok(!columns.some((c) => /file|blob|path|content/i.test(c.replace('filename', ''))), columns.join());
    });

    it('the daily quota is per student; deleting an upload does not give it back', async () => {
      const first = (await upload(await goodDocx('Alpha'), 'a.docx')).body.lesson;
      assert.equal((await upload(await goodDocx('Beta'), 'b.docx')).status, 201);
      const third = await upload(await goodDocx('Gamma'), 'c.docx');
      assert.equal(third.status, 429);
      assert.equal(third.body.error.code, 'upload_quota');
      assert.match(third.body.error.message, /again tomorrow/);
      // another student has their own two
      assert.equal((await upload(await goodDocx('Delta'), 'd.docx', P02)).status, 201);
      // delete one: still no upload to spare
      assert.equal((await t.call('DELETE', `/api/lessons/${first.id}`, P01)).status, 204);
      assert.equal((await upload(await goodDocx('Gamma'), 'c.docx')).status, 429);
      assert.equal((await t.call('GET', '/api/my-uploads', P01)).body.left_today, 0);
      // a refused upload is not an upload: three events (2 uploads and the delete), no failure rows
      assert.deepEqual(events('P01').map((e) => e.type), ['lesson_uploaded', 'lesson_uploaded', 'lesson_deleted_by_student']);
    });

    it('the quota starts again at 04:00 Manila the next study day', async () => {
      t.now = '2026-10-05T19:59:00.000Z'; // 03:59 on the 6th in Manila: still the 5th's study day
      turnOn(1);
      assert.equal((await upload(await goodDocx('Alpha'), 'a.docx')).status, 201);
      assert.equal((await upload(await goodDocx('Beta'), 'b.docx')).status, 429);
      t.now = '2026-10-05T20:00:00.000Z'; // 04:00 on the 6th
      assert.equal((await upload(await goodDocx('Beta'), 'b.docx')).status, 201);
      assert.deepEqual(events('P01').map((e) => e.study_date), ['2026-10-05', '2026-10-06']);
    });

    it('a limit of 0 means nobody can upload', async () => {
      turnOn(0);
      const res = await upload(await goodDocx(), 'plants.docx');
      assert.equal(res.status, 429);
      assert.equal(res.body.error.code, 'upload_quota');
    });

    it('a burst of requests is limited per student, whatever the quota', async () => {
      turnOn(20);
      for (let i = 0; i < BURST_MAX; i += 1) assert.equal((await upload(Buffer.from('nope'), 'x.txt')).status, 400, `request ${i + 1}`);
      const res = await upload(await goodDocx(), 'plants.docx');
      assert.equal(res.status, 429);
      assert.equal(res.body.error.code, 'upload_rate_limited');
      assert.equal((await upload(await goodDocx(), 'plants.docx', P02)).status, 201, 'another student is not held up');
      t.now = '2026-10-05T04:11:00.000Z'; // the window has passed
      assert.equal((await upload(await goodDocx('Beta'), 'b.docx')).status, 201);
    });

    it('is refused while too many students\' lessons are waiting for the AI', async () => {
      turnOn(20);
      for (let i = 0; i < QUEUE_LIMIT; i += 1) {
        t.db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status, origin, owner_participant_id) VALUES ('q', 'q.docx', 'text', 1, 'processing', 'student', (SELECT id FROM participants WHERE code = 'P02'))").run();
      }
      const res = await upload(await goodDocx(), 'plants.docx');
      assert.equal(res.status, 429);
      assert.equal(res.body.error.code, 'upload_busy');
      assert.equal((await t.call('GET', '/api/my-uploads', P01)).body.used_today, 0, 'a refusal is not counted');
      assert.equal((await upload(await goodDocx(), 'teacher.docx', admin)).status, 201, 'the queue guard is for students');
    });

    it('two uploads at once from one student: the second waits its turn (409), only one counts', async () => {
      turnOn(20);
      const docx = await goodDocx();
      const [a, b] = await Promise.all([upload(docx, 'a.docx'), upload(docx, 'b.docx')]);
      assert.deepEqual([a.status, b.status].sort(), [201, 409]);
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM lessons').get().n, 1);
    });
  });

  describe('what is checked about the file', () => {
    beforeEach(() => turnOn(20));
    const failed = (code) => events('P01').filter((e) => e.type === 'lesson_upload_failed' && e.detail === code).length;

    it('refuses a pptx renamed .docx by its content (wrong_content)', async () => {
      const res = await upload(await makePptx([['Title', 'Body text about plants']]), 'slides.docx');
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'wrong_content');
      assert.equal(failed('wrong_content'), 1);
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM lessons').get().n, 0);
    });

    it('refuses a docx renamed .pptx by its content', async () => {
      const res = await upload(await goodDocx(), 'notes.pptx', P01, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
      assert.equal(res.status, 400);
      assert.equal(failed('wrong_content'), 1);
    });

    it('refuses plain text renamed .pdf (bad_signature) and a text file by its type (wrong_type)', async () => {
      const pdf = await upload(Buffer.from('this is plain text, not a pdf'), 'notes.pdf', P01, 'application/pdf');
      assert.equal(pdf.status, 400);
      assert.equal(failed('bad_signature'), 1);
      const txt = await upload(Buffer.from('plain text'), 'notes.txt', P01, 'text/plain');
      assert.equal(txt.status, 400);
      assert.equal(failed('wrong_type'), 1);
    });

    it('refuses a file over the size limit (too_large)', async () => {
      const res = await upload(Buffer.alloc(1024 * 1024 + 10, 65), 'big.docx');
      assert.equal(res.status, 413);
      assert.equal(failed('too_large'), 1);
    });

    it('refuses a file with no text at all, without using up an upload (no_text)', async () => {
      const res = await upload(await makeDocx(['', '   ']), 'blank.docx');
      assert.equal(res.status, 422);
      assert.equal(res.body.error.code, 'no_text');
      assert.equal(failed('no_text'), 1);
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM lessons').get().n, 0);
      assert.equal((await t.call('GET', '/api/my-uploads', P01)).body.used_today, 0);
    });

    it('accepts a real docx', async () => {
      assert.equal((await upload(await goodDocx(), 'plants.docx')).status, 201);
      assert.equal(events('P01').filter((e) => e.type === 'lesson_upload_failed').length, 0);
    });

    it('the same content checks apply to the teacher\'s uploads', async () => {
      const res = await upload(await makePptx([['Title', 'Body']]), 'slides.docx', admin);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'wrong_content');
      assert.deepEqual(events('P00'), [], 'a teacher\'s failed upload is not a student event');
    });
  });

  describe('a student\'s delete', () => {
    let lesson;
    beforeEach(async () => {
      turnOn();
      lesson = (await upload(await goodDocx(), 'plants.docx')).body.lesson;
    });

    it('works before any study records, and is logged (the lesson goes, the event stays)', async () => {
      const res = await t.call('DELETE', `/api/lessons/${lesson.id}`, P01);
      assert.equal(res.status, 204);
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM lessons').get().n, 0);
      assert.deepEqual(events('P01').map((e) => [e.type, e.lesson_id, e.lesson_title]), [['lesson_uploaded', lesson.id, 'plants'], ['lesson_deleted_by_student', lesson.id, 'plants']]);
    });

    it('is still allowed after only opening the lesson (a reading session with no active time)', async () => {
      t.db.prepare("UPDATE lessons SET status = 'ready' WHERE id = ?").run(lesson.id);
      const session = await t.call('POST', '/api/sessions', { ...P01, body: { lesson_id: lesson.id, activity: 'reading' } });
      assert.equal(session.status, 201);
      const mine = (await t.call('GET', '/api/lessons', P01)).body.lessons.find((l) => l.id === lesson.id);
      assert.equal(mine.can_delete, true);
      assert.equal((await t.call('DELETE', `/api/lessons/${lesson.id}`, P01)).status, 204);
    });

    it('is blocked by reading time, a flashcard answer or a quiz attempt, and the option goes', async () => {
      const seeded = seedLesson(t.db, { title: 'Studied' });
      t.db.prepare("UPDATE lessons SET origin = 'student', owner_participant_id = (SELECT id FROM participants WHERE code = 'P01') WHERE id = ?").run(seeded.lessonId);
      const check = async (what) => {
        const row = (await t.call('GET', '/api/lessons', P01)).body.lessons.find((l) => l.id === seeded.lessonId);
        assert.equal(row.can_delete, false, what);
        const del = await t.call('DELETE', `/api/lessons/${seeded.lessonId}`, P01);
        assert.equal(del.status, 409, what);
        assert.equal(del.body.error.code, 'lesson_studied', what);
        assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM lessons WHERE id = ?').get(seeded.lessonId).n, 1, what);
      };
      // reading time
      const s = (await t.call('POST', '/api/sessions', { ...P01, body: { lesson_id: seeded.lessonId, activity: 'reading' } })).body.session;
      t.now = '2026-10-05T04:01:00.000Z';
      await t.call('POST', `/api/sessions/${s.id}`, { ...P01, body: { active_ms: 30_000 } });
      await check('reading time');
      // (the other two kinds of record are checked on their own lessons below)
      const second = seedLesson(t.db, { title: 'Answered' });
      t.db.prepare("UPDATE lessons SET origin = 'student', owner_participant_id = (SELECT id FROM participants WHERE code = 'P01') WHERE id = ?").run(second.lessonId);
      await t.call('POST', `/api/flashcards/${second.cards[0]}/review`, { ...P01, body: { rating: 3, time_ms: 900, deck: null } });
      assert.equal((await t.call('DELETE', `/api/lessons/${second.lessonId}`, P01)).body.error.code, 'lesson_studied');
      const third = seedLesson(t.db, { title: 'Quizzed' });
      t.db.prepare("UPDATE lessons SET origin = 'student', owner_participant_id = (SELECT id FROM participants WHERE code = 'P01') WHERE id = ?").run(third.lessonId);
      assert.equal((await t.call('POST', `/api/lessons/${third.lessonId}/quiz/attempts`, { ...P01, body: {} })).status, 201);
      assert.equal((await t.call('DELETE', `/api/lessons/${third.lessonId}`, P01)).body.error.code, 'lesson_studied');
    });

    it('is not for someone else\'s upload (404), nor the teacher\'s lesson', async () => {
      assert.equal((await t.call('DELETE', `/api/lessons/${lesson.id}`, P02)).status, 404);
      const teacher = seedLesson(t.db, { title: 'Teacher' });
      assert.equal((await t.call('DELETE', `/api/lessons/${teacher.lessonId}`, P01)).status, 404);
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM lessons').get().n, 2);
    });

    it('the studied flag counts only the owner\'s own records, not other students\' or P00\'s', async () => {
      t.db.prepare("UPDATE lessons SET status = 'ready' WHERE id = ?").run(lesson.id);
      await t.call('PUT', '/api/settings', { ...admin, body: {} });
      assert.equal((await t.call('POST', '/api/sessions', { ...admin, body: { lesson_id: lesson.id, activity: 'reading' } })).status, 201);
      const mine = (await t.call('GET', '/api/lessons', P01)).body.lessons.find((l) => l.id === lesson.id);
      assert.equal(mine.can_delete, true);
    });
  });

  describe('share', () => {
    let lesson;
    beforeEach(async () => {
      turnOn();
      lesson = (await upload(await goodDocx(), 'plants.docx')).body.lesson;
    });

    it('needs the PIN, and a finished lesson', async () => {
      assert.equal((await t.call('POST', `/api/lessons/${lesson.id}/share`, P01)).status, 401);
      const early = await t.call('POST', `/api/lessons/${lesson.id}/share`, admin);
      assert.equal(early.status, 409, 'still processing');
      assert.equal(t.db.prepare('SELECT shared_at FROM lessons WHERE id = ?').get(lesson.id).shared_at, null);
    });

    it('is one way, logged in lesson_events and admin_events, and makes it visible to everyone', async () => {
      t.db.prepare("UPDATE lessons SET status = 'ready' WHERE id = ?").run(lesson.id);
      assert.equal((await t.call('GET', '/api/lessons', P02)).body.lessons.length, 0);
      t.now = '2026-10-05T05:00:00.000Z';
      const res = await t.call('POST', `/api/lessons/${lesson.id}/share`, admin);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.lesson.shared, true);
      assert.equal(res.body.lesson.owner_code, 'P01');
      assert.equal(t.db.prepare('SELECT shared_at FROM lessons WHERE id = ?').get(lesson.id).shared_at, '2026-10-05T05:00:00.000Z');
      assert.deepEqual(events('P01').at(-1), { type: 'lesson_shared', actor: 'admin', lesson_id: lesson.id, lesson_title: 'plants', detail: null, study_date: '2026-10-05' });
      assert.deepEqual(t.db.prepare("SELECT type, detail FROM admin_events WHERE type = 'lesson_shared'").all(), [{ type: 'lesson_shared', detail: `lesson ${lesson.id} from P01` }]);
      // everyone sees it now; the second share is refused, and there is no way back
      const seen = (await t.call('GET', '/api/lessons', P02)).body.lessons;
      assert.deepEqual(seen.map((l) => [l.id, l.shared, l.mine]), [[lesson.id, true, false]]);
      assert.equal((await t.call('POST', `/api/lessons/${lesson.id}/share`, admin)).status, 409);
      assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM lesson_events WHERE type = 'lesson_shared'").get().n, 1);
    });

    it('the teacher\'s own lessons can\'t be shared (they already are everyone\'s)', async () => {
      const teacher = seedLesson(t.db, { title: 'Teacher' });
      assert.equal((await t.call('POST', `/api/lessons/${teacher.lessonId}/share`, admin)).status, 409);
    });

    it('a missing lesson is a 404', async () => {
      assert.equal((await t.call('POST', '/api/lessons/9999/share', admin)).status, 404);
    });
  });

  describe('processing', () => {
    // a provider stub that works, or fails the way a test says
    function stubAi({ fail, onCall } = {}) {
      return {
        async generateJSON({ schema, label, user }) {
          await onCall?.(label, user);
          fail?.(label);
          let value;
          if (label.startsWith('the review sections')) value = { sections: [{ title: 'S', content: 'Content that is long enough.', check_questions: [{ question: 'Q?', answer: 'A.' }] }] };
          else if (label.startsWith('the merged key terms')) value = keepAllCandidates(user);
          else if (label.startsWith('the key points') || label.startsWith('the merged')) value = { key_points: ['A takeaway.'] };
          else if (label.startsWith('the flashcards')) value = { cards: [] };
          else if (label.startsWith('the quiz')) value = { cards: [] };
          else value = { terms: [{ term: 'Term', definition: 'Defined.', evidence: quoteFromPrompt(user) }] };
          return schema.parse(value);
        },
      };
    }
    let runner;
    const startWith = async (ai) => {
      await t.close();
      const db = openDb(':memory:');
      runMigrations(db);
      runner = createPipelineRunner({ db, ai, log: quiet });
      t = await startStudyApp({ db, ai, runner });
      addCodes(t.db, 'P01', 'P02');
      turnOn(20);
    };
    afterEach(() => {
      runner = null;
    });

    it('runs one lesson at a time, the teacher\'s and the students\' in upload order', async () => {
      const active = new Set();
      let overlap = false;
      const order = [];
      const ai = stubAi({
        async onCall(label, user) {
          const who = /TEACHERMARK/.test(user) ? 'teacher' : /STUDENTMARK/.test(user) ? 'student' : null;
          if (!who) return;
          if (!order.includes(who)) order.push(who);
          active.add(who);
          if (active.size > 1) overlap = true;
          await sleep(3);
          active.delete(who);
        },
      });
      await startWith(ai);
      const teacher = await upload(await makeDocx(['TEACHERMARK Photosynthesis converts light energy into chemical energy.']), 'teacher.docx', admin);
      const student = await upload(await makeDocx(['STUDENTMARK Mitosis divides one cell into two identical cells.']), 'student.docx');
      assert.equal(teacher.status, 201);
      assert.equal(student.status, 201);
      await runner.idle();
      assert.equal(overlap, false, 'two lessons were prepared at the same time');
      assert.deepEqual(order, ['teacher', 'student']);
      const rows = t.db.prepare('SELECT id, status, origin FROM lessons ORDER BY id').all();
      assert.deepEqual(rows.map((r) => [r.origin, r.status]), [['admin', 'ready'], ['student', 'ready']]);
      assert.ok(t.db.prepare('SELECT COUNT(*) AS n FROM sections WHERE lesson_id = ?').get(student.body.lesson.id).n > 0, 'the same pipeline makes the sections');
    });

    it('a student\'s upload is prepared with the Default AI only: no section versions are made', async () => {
      await startWith(stubAi());
      const { lesson } = (await upload(await goodDocx(), 'plants.docx')).body;
      await runner.idle();
      assert.equal(t.db.prepare('SELECT status FROM lessons WHERE id = ?').get(lesson.id).status, 'ready');
      assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE lesson_id = ? AND stage = 'section_versions'").get(lesson.id).n, 0);
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM sections WHERE lesson_id = ? AND (simple_version IS NOT NULL OR filipino_version IS NOT NULL)').get(lesson.id).n, 0);
    });

    it('a failed lesson shows the student a plain message, admin the real one; the retry is free and only the owner\'s', async () => {
      let failing = true;
      await startWith(stubAi({ fail: () => failing && (() => { throw new AiError('auth', 'The provider said: API key sk-SECRET-123 is not valid. Check Settings.', 502); })() }));
      const { lesson } = (await upload(await goodDocx(), 'plants.docx')).body;
      await runner.idle();

      const row = (await t.call('GET', '/api/lessons', P01)).body.lessons.find((l) => l.id === lesson.id);
      assert.equal(row.status, 'failed');
      assert.equal(row.error, UPLOAD_FAILED_MESSAGE);
      assert.equal(row.can_retry, true);
      const status = await t.call('GET', `/api/lessons/${lesson.id}/status`, P01);
      assert.equal(status.body.can_retry, true);
      for (const text of [JSON.stringify(row), JSON.stringify(status.body), JSON.stringify((await t.call('GET', `/api/lessons/${lesson.id}`, P01)).body)]) {
        assert.ok(!/sk-SECRET|Settings|provider said/i.test(text), text);
      }
      // admin sees the real reason
      const adminRow = (await t.call('GET', '/api/lessons', admin)).body.lessons.find((l) => l.id === lesson.id);
      assert.match(adminRow.error, /sk-SECRET/);
      // logged as a failed upload, with the stage
      assert.deepEqual(events('P01').filter((e) => e.type === 'lesson_upload_failed').map((e) => e.detail), ['processing:sections']);

      // another student can't retry it; the owner can, and it doesn't use up an upload
      assert.equal((await t.call('POST', `/api/lessons/${lesson.id}/retry`, P02)).status, 404);
      const before = (await t.call('GET', '/api/my-uploads', P01)).body.used_today;
      failing = false;
      const retry = await t.call('POST', `/api/lessons/${lesson.id}/retry`, P01);
      assert.equal(retry.status, 202, JSON.stringify(retry.body));
      await runner.idle();
      assert.equal(t.db.prepare('SELECT status FROM lessons WHERE id = ?').get(lesson.id).status, 'ready');
      assert.equal((await t.call('GET', '/api/my-uploads', P01)).body.used_today, before);
      assert.equal(events('P01').filter((e) => e.type === 'lesson_uploaded').length, 1);
    });

    it('a retry only works on a failed lesson', async () => {
      await startWith(stubAi());
      const { lesson } = (await upload(await goodDocx(), 'plants.docx')).body;
      await runner.idle();
      assert.equal((await t.call('POST', `/api/lessons/${lesson.id}/retry`, P01)).status, 409);
    });

    it('a restart that interrupts a student\'s lesson leaves a plain message too', async () => {
      turnOn(20); // the default test runner never starts the job, so it is still queued when the "restart" comes
      const { lesson } = (await upload(await goodDocx(), 'plants.docx')).body;
      const { failInterruptedJobs } = await import('../src/pipeline/jobs.js');
      failInterruptedJobs(t.db);
      const row = (await t.call('GET', '/api/lessons', P01)).body.lessons.find((l) => l.id === lesson.id);
      assert.equal(row.status, 'failed');
      assert.equal(row.error, UPLOAD_FAILED_MESSAGE);
    });

    it('a lesson whose file has no readable text in it fails with a message about the file, which the student does see', async () => {
      turnOn(20);
      // text that passes the upload check but yields no chunks is rare; blank it before the (here manual) runner starts
      const { lesson } = (await upload(await goodDocx(), 'plants.docx')).body;
      t.db.prepare("UPDATE lessons SET raw_text = ' ' WHERE id = ?").run(lesson.id);
      runner = createPipelineRunner({ db: t.db, ai: stubAi(), log: quiet });
      runner.enqueue(lesson.id);
      await runner.idle();
      const row = (await t.call('GET', '/api/lessons', P01)).body.lessons.find((l) => l.id === lesson.id);
      assert.equal(row.status, 'failed');
      assert.notEqual(row.error, UPLOAD_FAILED_MESSAGE);
      assert.match(row.error, /text/i);
    });
  });
});
