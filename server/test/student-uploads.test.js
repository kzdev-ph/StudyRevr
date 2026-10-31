import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Document, Packer, Paragraph } from 'docx';
import PptxGenJS from 'pptxgenjs';
import { AiError } from '../src/ai/client.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { createPipelineRunner } from '../src/pipeline/runner.js';
import http from 'node:http';
import { CARDS_FAILED_MESSAGE, PREPARE_FAILED_MESSAGE, TEXT_WARNINGS, UPLOAD_FAILED_MESSAGE } from '../src/services/lesson-access.js';
import { BURST_MAX, QUEUE_LIMIT, createUploadGuard } from '../src/services/student-upload.js';
import { addCodes, cleanReview, keepAllCandidates, quoteFromPrompt, seedLesson, startStudyApp, TEST_PIN, tokenFor } from './helpers.js';

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
    if (who.as) headers.authorization = `Bearer ${tokenFor(t.db, who.as, new Date(t.now))}`;
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

  describe('the limits on the request itself', () => {
    beforeEach(() => turnOn(20));

    // a request written by hand, so a test controls the headers and how much of the body is sent
    const rawPost = ({ headers, write, abortAfterMs }) =>
      new Promise((resolve, reject) => {
        const url = new URL(t.base);
        const req = http.request({ host: url.hostname, port: url.port, path: '/api/lessons', method: 'POST', headers: { authorization: `Bearer ${tokenFor(t.db, 'P01', new Date(t.now))}`, ...headers } }, (res) => {
          let text = '';
          res.on('data', (c) => { text += c; });
          res.on('end', () => resolve({ status: res.statusCode, connection: res.headers.connection, body: text ? JSON.parse(text) : null }));
        });
        req.on('error', (e) => (abortAfterMs ? resolve({ aborted: true }) : reject(e)));
        req.flushHeaders(); // the headers go out now; the body (if any) never does
        if (write) req.write(write);
        if (abortAfterMs) setTimeout(() => req.destroy(), abortAfterMs);
        else if (!headers['content-length']) req.end();
      });

    it('a Content-Length far over the limit is refused at once, before any of the body is read, and logged', async () => {
      const res = await rawPost({ headers: { 'content-type': 'multipart/form-data; boundary=xx', 'content-length': String(50 * 1024 * 1024) } });
      assert.equal(res.status, 413);
      assert.equal(res.body.error.code, 'too_large');
      assert.equal(res.connection, 'close');
      assert.deepEqual(events('P01').map((e) => [e.type, e.detail]), [['lesson_upload_failed', 'too_large']]);
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM lessons').get().n, 0);
    });

    it('is refused for the teacher too (no event: it is not a student)', async () => {
      const res = await rawPost({ headers: { 'x-admin-pin': TEST_PIN, authorization: `Bearer ${tokenFor(t.db, 'P00', new Date(t.now))}`, 'content-type': 'multipart/form-data; boundary=xx', 'content-length': String(50 * 1024 * 1024) } });
      assert.equal(res.status, 413);
      assert.deepEqual(events('P00'), []);
    });

    it('a form with more than the file and a title is refused', async () => {
      const form = new FormData();
      form.append('file', new Blob([await goodDocx()], { type: DOCX_MIME }), 'plants.docx');
      for (const k of ['title', 'extra', 'more']) form.append(k, 'x');
      const res = await globalThis.fetch(`${t.base}/api/lessons`, { method: 'POST', headers: { authorization: `Bearer ${tokenFor(t.db, 'P01', new Date(t.now))}` }, body: form });
      assert.equal(res.status, 400);
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM lessons').get().n, 0);
      // the same form with the one allowed title works
      const ok = new FormData();
      ok.append('file', new Blob([await goodDocx()], { type: DOCX_MIME }), 'plants.docx');
      ok.append('title', 'Plants');
      assert.equal((await globalThis.fetch(`${t.base}/api/lessons`, { method: 'POST', headers: { authorization: `Bearer ${tokenFor(t.db, 'P01', new Date(t.now))}` }, body: ok })).status, 201);
    });

    it('a title field over its size limit is refused', async () => {
      const form = new FormData();
      form.append('title', 'x'.repeat(2000));
      form.append('file', new Blob([await goodDocx()], { type: DOCX_MIME }), 'plants.docx');
      const res = await globalThis.fetch(`${t.base}/api/lessons`, { method: 'POST', headers: { authorization: `Bearer ${tokenFor(t.db, 'P01', new Date(t.now))}` }, body: form });
      assert.ok([400, 413].includes(res.status), String(res.status));
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM lessons').get().n, 0);
    });

    it('an upload that is cut off half way gives the student their slot back', async () => {
      const aborted = await rawPost({
        headers: { 'content-type': 'multipart/form-data; boundary=xx', 'content-length': '5000' },
        write: '--xx\r\nContent-Disposition: form-data; name="file"; filename="a.docx"\r\n\r\nPK',
        abortAfterMs: 40,
      });
      assert.equal(aborted.aborted, true);
      await sleep(80);
      assert.equal((await upload(await goodDocx(), 'plants.docx')).status, 201, 'not stuck on 409 upload_in_flight');
    });

    it('the in-flight slot: only the holder gives it back, and a late release does not free a newer upload', () => {
      const guard = createUploadGuard();
      const first = guard.start(7);
      assert.equal(guard.has(7), true);
      assert.throws(() => guard.start(7), (e) => e.status === 409);
      first();
      assert.equal(guard.has(7), false);
      const second = guard.start(7);
      first(); // a late 'close' of the first request
      assert.equal(guard.has(7), true, 'the second upload still holds the slot');
      second();
      second();
      assert.equal(guard.has(7), false);
      assert.doesNotThrow(() => guard.start(7));
    });

    it('lessons made at the same moment cannot push the queue over its limit', async () => {
      for (let i = 0; i < QUEUE_LIMIT - 1; i += 1) {
        t.db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status, origin, owner_participant_id) VALUES ('q', 'q.docx', 'text', 1, 'processing', 'student', (SELECT id FROM participants WHERE code = 'P02'))").run();
      }
      addCodes(t.db, 'P03');
      const docx = await goodDocx();
      const [a, b] = await Promise.all([upload(docx, 'a.docx', P01), upload(docx, 'b.docx', { as: 'P03' })]);
      assert.deepEqual([a.status, b.status].sort(), [201, 429]);
      assert.equal([a, b].find((r) => r.status === 429).body.error.code, 'upload_busy');
      assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM lessons WHERE status = 'processing' AND origin = 'student'").get().n, QUEUE_LIMIT);
    });

    it('a title taken from the file name is cut to 200 characters', async () => {
      const res = await upload(await goodDocx(), `${'a'.repeat(300)}.docx`);
      assert.equal(res.status, 201);
      assert.equal(res.body.lesson.title.length, 200);
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

    // a ready lesson of P01's, as a student upload that nothing has touched yet
    const ownLesson = (title) => {
      const seeded = seedLesson(t.db, { title });
      t.db.prepare("UPDATE lessons SET origin = 'student', owner_participant_id = (SELECT id FROM participants WHERE code = 'P01') WHERE id = ?").run(seeded.lessonId);
      t.db.prepare("INSERT INTO quiz_distractors (flashcard_id, choices) SELECT id, '[]' FROM flashcards WHERE lesson_id = ?").run(seeded.lessonId);
      return seeded;
    };
    const studied = async (lessonId, what) => {
      const row = (await t.call('GET', '/api/lessons', P01)).body.lessons.find((l) => l.id === lessonId);
      assert.equal(row.can_delete, false, what);
      const del = await t.call('DELETE', `/api/lessons/${lessonId}`, P01);
      assert.equal(del.status, 409, what);
      assert.equal(del.body.error.code, 'lesson_studied', what);
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM lessons WHERE id = ?').get(lessonId).n, 1, what);
    };
    // a session of this kind with active time, started now and closed a minute later
    const sessionWithTime = async (lessonId, activity, ms = 30_000) => {
      const s = (await t.call('POST', '/api/sessions', { ...P01, body: { lesson_id: lessonId, activity } })).body.session;
      t.now = new Date(Date.parse(t.now) + 60_000).toISOString();
      await t.call('POST', `/api/sessions/${s.id}`, { ...P01, body: { active_ms: ms, end_reason: 'left' } });
    };

    it('is blocked by reading time, a flashcard answer or an answered quiz question, and the option goes', async () => {
      const reading = ownLesson('Read');
      await sessionWithTime(reading.lessonId, 'reading');
      await studied(reading.lessonId, 'reading time');

      const cards = ownLesson('Answered');
      await t.call('POST', `/api/flashcards/${cards.cards[0]}/review`, { ...P01, body: { rating: 3, time_ms: 900, deck: null } });
      await studied(cards.lessonId, 'a flashcard answer');

      const quiz = ownLesson('Quizzed');
      const attempt = (await t.call('POST', `/api/lessons/${quiz.lessonId}/quiz/attempts`, { ...P01, body: {} })).body;
      assert.equal((await t.call('POST', `/api/quiz/attempts/${attempt.attempt.id}/answers`, { ...P01, body: { position: 0, choice: 0, time_ms: 1200 } })).status, 200);
      await studied(quiz.lessonId, 'one answered quiz question');
    });

    it('is still allowed after only opening the quiz, or opening the flashcards or the quiz for a while without answering', async () => {
      const lesson2 = ownLesson('Looked');
      const attempt = await t.call('POST', `/api/lessons/${lesson2.lessonId}/quiz/attempts`, { ...P01, body: {} });
      assert.equal(attempt.status, 201);
      const row = (await t.call('GET', '/api/lessons', P01)).body.lessons.find((l) => l.id === lesson2.lessonId);
      assert.equal(row.can_delete, true, 'an unanswered attempt is not studying');
      await sessionWithTime(lesson2.lessonId, 'quiz');
      await sessionWithTime(lesson2.lessonId, 'flashcards');
      assert.equal((await t.call('GET', '/api/lessons', P01)).body.lessons.find((l) => l.id === lesson2.lessonId).can_delete, true, 'quiz and flashcard time without an answer is not studying either');
      assert.equal((await t.call('DELETE', `/api/lessons/${lesson2.lessonId}`, P01)).status, 204);
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM quiz_attempts WHERE lesson_id = ?').get(lesson2.lessonId).n, 0, 'the attempt goes with the lesson');
    });

    it('leaves nothing behind that could count in the teacher-only measures (summary.csv): sessions, taps and attempts go with the lesson', async () => {
      const summaryRow = async (code) => {
        const res = await t.call('GET', '/api/admin/export/summary.csv', admin);
        const [head, ...rows] = res.body.replace(/^\uFEFF/, '').trim().split('\r\n').map((r) => r.split(','));
        const row = rows.find((r) => r[0] === code);
        return Object.fromEntries(head.map((h, i) => [h, row[i]]));
      };
      const lesson2 = ownLesson('Looked');
      await t.call('POST', '/api/events', { ...P01, body: { type: 'section_simplify', lesson_id: lesson2.lessonId, section_index: 0 } });
      await t.call('POST', '/api/sessions', { ...P01, body: { lesson_id: lesson2.lessonId, activity: 'reading' } }); // opened: 0 ms
      await sessionWithTime(lesson2.lessonId, 'flashcards');
      await sessionWithTime(lesson2.lessonId, 'quiz');
      await t.call('POST', `/api/lessons/${lesson2.lessonId}/quiz/attempts`, { ...P01, body: {} });
      const before = await summaryRow('P01');
      assert.notEqual(before.planning_total_min_all, '0', 'the _all columns saw the time');
      assert.equal(before.self_monitoring_simplify_taps_all, '1');
      assert.equal(before.planning_total_min, '0', "the main columns count the teacher's lessons only");

      assert.equal((await t.call('DELETE', `/api/lessons/${lesson2.lessonId}`, P01)).status, 204);
      for (const table of ['events', 'study_sessions', 'quiz_attempts']) {
        assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE lesson_id IS NULL OR lesson_id = ?`).get(lesson2.lessonId).n, 0, `${table} has no row left without its lesson`);
      }
      // P01 now reads exactly like P02, who never did anything: every measure, main and _all
      const after = await summaryRow('P01');
      const idle = await summaryRow('P02');
      for (const [col, value] of Object.entries(idle)) {
        if (col !== 'participant') assert.equal(after[col], value, col);
      }
      assert.ok(events('P01').some((e) => e.type === 'lesson_deleted_by_student'), 'the deleted-lesson event stays');
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

  describe('what a student is shown about an upload', () => {
    beforeEach(() => turnOn(20));

    it('never includes the file name (the title may come from it, but the student chose that file themselves)', async () => {
      const res = await upload(await goodDocx(), 'jane-doe-notes.docx');
      assert.equal(res.status, 201);
      assert.equal(res.body.lesson.title, 'jane-doe-notes');
      assert.ok(!('filename' in res.body.lesson), 'the upload response');
      const id = res.body.lesson.id;
      const list = (await t.call('GET', '/api/lessons', P01)).body.lessons.find((l) => l.id === id);
      assert.ok(!('filename' in list), 'the list');
      const one = (await t.call('GET', `/api/lessons/${id}`, P01)).body.lesson;
      assert.ok(!('filename' in one), 'GET /:id');
      // once shared, another student reads it without the file name too
      t.db.prepare("UPDATE lessons SET status = 'ready', shared_at = '2026-10-05T04:00:00.000Z' WHERE id = ?").run(id);
      const other = (await t.call('GET', `/api/lessons/${id}`, P02)).body.lesson;
      assert.ok(!('filename' in other), 'a shared lesson, read by another student');
      assert.ok(!/jane-doe-notes\.docx/.test(JSON.stringify((await t.call('GET', '/api/lessons', P02)).body)), 'the other student\'s list');
      // admin still gets it
      const adminRow = (await t.call('GET', `/api/lessons/${id}`, admin)).body.lesson;
      assert.equal(adminRow.filename, 'jane-doe-notes.docx');
      assert.equal((await t.call('GET', '/api/lessons', admin)).body.lessons.find((l) => l.id === id).filename, 'jane-doe-notes.docx');
    });

    it('shows the text warning to the owner and admin only, before and after Share', async () => {
      const res = await upload(await goodDocx(), 'plants.docx'); // two sentences: very little text
      assert.equal(res.status, 201);
      assert.equal(res.body.warning, TEXT_WARNINGS.short_text);
      const id = res.body.lesson.id;
      assert.equal(t.db.prepare('SELECT text_warning FROM lessons WHERE id = ?').get(id).text_warning, 'short_text');
      const expected = { code: 'short_text', message: TEXT_WARNINGS.short_text };
      const listed = async (who, path = '/api/lessons') => (await t.call('GET', path, who)).body.lessons.find((l) => l.id === id);

      assert.deepEqual(res.body.lesson.text_warning, expected, 'the upload reply');
      assert.deepEqual((await listed(P01)).text_warning, expected, "the owner's list");
      assert.deepEqual((await t.call('GET', `/api/lessons/${id}`, P01)).body.lesson.text_warning, expected, "the owner's GET /:id");
      assert.deepEqual((await listed(admin, '/api/lessons?counts=1')).text_warning, expected, "admin's ?counts=1 list");
      assert.deepEqual((await t.call('GET', `/api/lessons/${id}`, admin)).body.lesson.text_warning, expected, "admin's GET /:id");
      assert.equal((await t.call('GET', `/api/lessons/${id}`, P02)).status, 404, "another student's private lesson stays a 404");

      // once shared, another student reads it without the warning (no key at all); the owner still sees it
      t.db.prepare("UPDATE lessons SET status = 'ready', shared_at = '2026-10-05T04:00:00.000Z' WHERE id = ?").run(id);
      const other = await listed(P02);
      assert.ok(other, 'visible once shared');
      assert.ok(!('text_warning' in other), "another student's list row");
      assert.ok(!('text_warning' in (await t.call('GET', `/api/lessons/${id}`, P02)).body.lesson), "another student's GET /:id");
      assert.deepEqual((await listed(P01)).text_warning, expected, 'the owner after Share');
    });

    it('a teacher lesson also reaches students without its file name', async () => {
      const seeded = seedLesson(t.db, { title: 'Teacher' });
      const row = (await t.call('GET', '/api/lessons', P01)).body.lessons.find((l) => l.id === seeded.lessonId);
      assert.ok(!('filename' in row));
    });

    it("shows a plain line, not the provider's message, for a failed cards job on their own upload (decks)", async () => {
      const { lesson } = (await upload(await goodDocx(), 'plants.docx')).body;
      t.db.prepare("UPDATE lessons SET status = 'ready' WHERE id = ?").run(lesson.id);
      t.db.prepare("UPDATE jobs SET stage = 'flashcards', status = 'failed', error = 'Provider said: key sk-SECRET-9 rejected. Check Settings.' WHERE lesson_id = ?").run(lesson.id);
      const deck = (await t.call('GET', '/api/flashcards/decks', P01)).body.decks.find((d) => d.lesson_id === lesson.id);
      assert.equal(deck.job.error, CARDS_FAILED_MESSAGE);
      assert.ok(!/sk-SECRET|Settings/.test(JSON.stringify(deck)));
      const adminDeck = (await t.call('GET', '/api/flashcards/decks', admin)).body.decks.find((d) => d.lesson_id === lesson.id);
      assert.match(adminDeck.job.error, /sk-SECRET/);
    });

    it('shows a plain line for a Prepare job that failed (section_versions.error) and keeps the real one for admin', async () => {
      const seeded = seedLesson(t.db, { title: 'Teacher' });
      t.db.prepare("INSERT INTO jobs (lesson_id, stage, status, error) VALUES (?, 'section_versions', 'failed', 'Provider said: key sk-SECRET-9 rejected.')").run(seeded.lessonId);
      const mine = (await t.call('GET', '/api/lessons', P01)).body.lessons.find((l) => l.id === seeded.lessonId);
      assert.equal(mine.section_versions.error, PREPARE_FAILED_MESSAGE);
      assert.ok(!/sk-SECRET/.test(JSON.stringify(mine)));
      const adminRow = (await t.call('GET', '/api/lessons', admin)).body.lessons.find((l) => l.id === seeded.lessonId);
      assert.match(adminRow.section_versions.error, /sk-SECRET/);
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
          else if (label.startsWith('the quiz review')) value = cleanReview(user);
          else if (label.startsWith('the quiz')) value = { cards: [] };
          else value = { terms: [{ term: 'Term', definition: 'Defined.', evidence: quoteFromPrompt(user) }] };
          return schema.parse(value);
        },
      };
    }
    let runner;
    const startWith = async (ai, runnerOptions = {}) => {
      await t.close();
      const db = openDb(':memory:');
      runMigrations(db);
      runner = createPipelineRunner({ db, ai, log: quiet, ...runnerOptions });
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

    it("a student's retry waits when the queue is full (429 upload_busy); the teacher's retry does not", async () => {
      await startWith(stubAi({ fail: () => { throw new AiError('timeout', 'slow', 504); } }));
      const { lesson } = (await upload(await goodDocx(), 'plants.docx')).body;
      await runner.idle();
      assert.equal(t.db.prepare('SELECT status FROM lessons WHERE id = ?').get(lesson.id).status, 'failed');
      for (let i = 0; i < QUEUE_LIMIT; i += 1) {
        t.db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status, origin, owner_participant_id) VALUES ('q', 'q.docx', 'text', 1, 'processing', 'student', (SELECT id FROM participants WHERE code = 'P02'))").run();
      }
      const busy = await t.call('POST', `/api/lessons/${lesson.id}/retry`, P01);
      assert.equal(busy.status, 429);
      assert.equal(busy.body.error.code, 'upload_busy');
      assert.equal(t.db.prepare('SELECT status FROM lessons WHERE id = ?').get(lesson.id).status, 'failed', 'nothing was queued');
      assert.equal((await t.call('POST', `/api/lessons/${lesson.id}/retry`, admin)).status, 202);
    });

    it('a student upload that fails is logged with the runner\'s clock, not the machine\'s', async () => {
      const at = new Date('2031-02-03T04:05:06.000Z');
      await startWith(stubAi({ fail: () => { throw new AiError('timeout', 'slow', 504); } }), { clock: () => at });
      const { lesson } = (await upload(await goodDocx(), 'plants.docx')).body;
      await runner.idle();
      const row = t.db.prepare("SELECT created_at FROM lesson_events WHERE type = 'lesson_upload_failed' AND lesson_id = ?").get(lesson.id);
      assert.equal(row.created_at, at.toISOString());
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
      failInterruptedJobs(t.db, new Date('2026-10-05T05:00:00.000Z'));
      const row = (await t.call('GET', '/api/lessons', P01)).body.lessons.find((l) => l.id === lesson.id);
      assert.equal(row.status, 'failed');
      assert.equal(row.error, UPLOAD_FAILED_MESSAGE);
    });

    it("a restart also logs the interrupted upload as a failure (processing:interrupted) at the restart's time; the teacher's lessons are not student events", async () => {
      turnOn(20);
      const { lesson } = (await upload(await goodDocx(), 'plants.docx')).body;
      const teacher = (await upload(await goodDocx('Mitosis'), 'teacher.docx', admin)).body.lesson;
      const { failInterruptedJobs } = await import('../src/pipeline/jobs.js');
      failInterruptedJobs(t.db, new Date('2026-10-05T05:00:00.000Z'));
      const failed = t.db.prepare("SELECT lesson_id, detail, created_at, study_date FROM lesson_events WHERE type = 'lesson_upload_failed'").all();
      assert.deepEqual(failed, [{ lesson_id: lesson.id, detail: 'processing:interrupted', created_at: '2026-10-05T05:00:00.000Z', study_date: '2026-10-05' }]);
      assert.equal(failed.some((e) => e.lesson_id === teacher.id), false);
      // a second restart finds nothing left to interrupt
      failInterruptedJobs(t.db, new Date('2026-10-05T06:00:00.000Z'));
      assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM lesson_events WHERE type = 'lesson_upload_failed'").get().n, 1);
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
