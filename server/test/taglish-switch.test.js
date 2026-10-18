import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb, runMigrations } from '../src/db/index.js';
import { makeBackup, removeTemp } from '../src/services/backup.js';
import { addCodes, seedLesson, startStudyApp, TEST_PIN } from './helpers.js';

// Admin's "Show Filipino/Taglish to students" (settings `show_taglish`, default off): while it is off a student gets no
// Filipino/Taglish version and the server refuses the tap; admin's Prepare still makes the versions. Each change is one
// admin_events row (setting_changed, show_taglish=true|false), like every admin setting.
const VERSION = JSON.stringify({ title: 'Isa', content: 'Ang paksa.', check_questions: [] });

describe('Show Filipino/Taglish to students', () => {
  let t;
  let lessonId;
  let sectionId;
  const enqueued = [];

  before(async () => {
    t = await startStudyApp({ showTaglish: false, runner: { enqueue: (id) => enqueued.push(id) } });
    addCodes(t.db, 'P01');
    ({ lessonId } = seedLesson(t.db));
    sectionId = t.db.prepare('SELECT id FROM sections WHERE lesson_id = ? ORDER BY position').get(lessonId).id;
    t.db.prepare('UPDATE sections SET filipino_version = ? WHERE id = ?').run(VERSION, sectionId);
  });
  after(() => t.close());

  const changes = () => t.db.prepare("SELECT detail FROM admin_events WHERE type = 'setting_changed' AND detail LIKE 'show_taglish=%' ORDER BY id").all().map((r) => r.detail);
  const setSwitch = (value) => t.call('PUT', '/api/settings', { pin: TEST_PIN, body: { show_taglish: value } });
  const translate = () => t.call('POST', `/api/sections/${sectionId}/translate`, { as: 'P01' });
  const tap = () => t.call('POST', '/api/events', { as: 'P01', body: { type: 'section_translate', lesson_id: lessonId, section_index: 0 } });

  it('is off by default and the migrations log nothing for it', async () => {
    assert.equal((await t.call('GET', '/api/settings', { pin: TEST_PIN })).body.show_taglish, false);
    assert.deepEqual(changes(), []);
  });

  it('while off, a student sees no version and the tap and its event are refused', async () => {
    const lesson = await t.call('GET', `/api/lessons/${lessonId}`, { as: 'P01' });
    assert.equal(lesson.body.lesson.show_taglish, false);
    assert.ok(lesson.body.sections.every((s) => s.filipino_version === null));
    const res = await translate();
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'taglish_off');
    assert.equal((await tap()).status, 403);
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'section_translate'").get().n, 0);
    // Explain simpler is not affected
    assert.equal((await t.call('POST', '/api/events', { as: 'P01', body: { type: 'section_simplify', lesson_id: lessonId, section_index: 0 } })).status, 201);
  });

  it('while off, admin still sees the versions and can run Prepare', async () => {
    const lesson = await t.call('GET', `/api/lessons/${lessonId}`, { pin: TEST_PIN });
    assert.deepEqual(lesson.body.sections.find((s) => s.id === sectionId).filipino_version.title, 'Isa');
    const prepare = await t.call('POST', `/api/lessons/${lessonId}/section-versions`, { pin: TEST_PIN });
    assert.equal(prepare.status, 202);
    assert.deepEqual(enqueued, [lessonId]);
  });

  it('turned on, students get the version and the tap is logged; each change is one admin_events row', async () => {
    assert.equal((await setSwitch(true)).status, 200);
    assert.equal((await setSwitch(true)).status, 200); // saved again unchanged: no second row
    assert.deepEqual(changes(), ['show_taglish=true']);
    const lesson = await t.call('GET', `/api/lessons/${lessonId}`, { as: 'P01' });
    assert.equal(lesson.body.lesson.show_taglish, true);
    assert.equal(lesson.body.sections.find((s) => s.id === sectionId).filipino_version.title, 'Isa');
    const res = await translate();
    assert.equal(res.status, 200);
    assert.equal(res.body.cached, true);
    assert.equal((await tap()).status, 201);

    assert.equal((await setSwitch(false)).status, 200);
    assert.deepEqual(changes(), ['show_taglish=true', 'show_taglish=false']);
    assert.equal((await translate()).status, 403);
  });
});

describe('a backup carries the Filipino/Taglish switch', () => {
  for (const value of ['true', 'false']) {
    it(`keeps show_taglish=${value}`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyrevr-taglish-'));
      const db = openDb(path.join(dir, 'source.db'));
      runMigrations(db);
      db.prepare("INSERT INTO settings (key, value) VALUES ('show_taglish', ?)").run(value);
      const { file } = await makeBackup(db);
      try {
        const copy = new Database(file, { readonly: true });
        assert.equal(copy.prepare("SELECT value FROM settings WHERE key = 'show_taglish'").get().value, value);
        copy.close();
      } finally {
        removeTemp(file);
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
