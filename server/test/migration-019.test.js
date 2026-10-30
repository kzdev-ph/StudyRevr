import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, runMigrations } from '../src/db/index.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');

// A database as it was before 019 (migrations 001-018).
function db018() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyrevr-mig-'));
  for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f < '019')) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
  const db = openDb(':memory:');
  runMigrations(db, dir);
  fs.rmSync(dir, { recursive: true });
  return db;
}

describe('migration 019: session end reasons', () => {
  it('keeps existing rows with their ids and accepts the new reasons only', () => {
    const db = db018();
    const p00 = db.prepare("SELECT id FROM participants WHERE code = 'P00'").get().id;
    const insert = db.prepare(
      `INSERT INTO study_sessions (id, participant_id, activity, started_at, last_active_at, ended_at, active_ms, end_reason, study_date)
       VALUES (?, ?, 'reading', '2026-10-01T05:00:00.000Z', '2026-10-01T05:10:00.000Z', '2026-10-01T05:10:00.000Z', 600000, ?, '2026-10-01')`,
    );
    insert.run(7, p00, 'left');
    assert.equal(runMigrations(db)[0], '019_session_end_reasons.sql');

    assert.deepEqual(db.prepare('SELECT id, participant_id, active_ms, end_reason, study_date FROM study_sessions').all(), [
      { id: 7, participant_id: p00, active_ms: 600000, end_reason: 'left', study_date: '2026-10-01' },
    ]);
    insert.run(8, p00, 'signed_out_elsewhere');
    insert.run(9, p00, 'signed_out_by_admin');
    assert.throws(() => insert.run(10, p00, 'bogus'), /CHECK/);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'study_sessions' AND name LIKE 'idx_%' ORDER BY name").all(), [
      { name: 'idx_study_sessions_lesson' },
      { name: 'idx_study_sessions_participant' },
    ]);
    db.close();
  });

  it('copes with rows that point at nothing, and keeps the AUTOINCREMENT counter', () => {
    const db = db018();
    const p00 = db.prepare("SELECT id FROM participants WHERE code = 'P00'").get().id;
    const lessonId = Number(db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status, created_at) VALUES ('L', 'l.pptx', 't', 1, 'ready', '2026-10-01T00:00:00.000Z')").run().lastInsertRowid);
    const insert = db.prepare(
      `INSERT INTO study_sessions (id, participant_id, lesson_id, activity, started_at, last_active_at, ended_at, active_ms, end_reason, study_date)
       VALUES (?, ?, ?, 'reading', '2026-10-01T05:00:00.000Z', '2026-10-01T05:10:00.000Z', '2026-10-01T05:10:00.000Z', 600000, 'left', '2026-10-01')`,
    );
    insert.run(1, p00, lessonId);
    // rows an older database can hold from before foreign keys were enforced: a lesson that is gone, a participant that is gone
    db.pragma('foreign_keys = OFF');
    insert.run(2, p00, 999);
    insert.run(3, 999, null);
    // the highest id was handed out and then deleted
    insert.run(40, p00, null);
    db.prepare('DELETE FROM study_sessions WHERE id = 40').run();
    db.pragma('foreign_keys = ON');

    assert.equal(runMigrations(db)[0], '019_session_end_reasons.sql');

    assert.deepEqual(db.prepare('SELECT id, participant_id, lesson_id FROM study_sessions ORDER BY id').all(), [
      { id: 1, participant_id: p00, lesson_id: lessonId },
      { id: 2, participant_id: p00, lesson_id: null }, // kept, its lesson link cleared
    ]); // the row of the missing participant is not carried over
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    const next = db
      .prepare("INSERT INTO study_sessions (participant_id, activity, started_at, last_active_at, study_date) VALUES (?, 'reading', '2026-10-02T05:00:00.000Z', '2026-10-02T05:00:00.000Z', '2026-10-02')")
      .run(p00).lastInsertRowid;
    assert.equal(Number(next), 41); // 40 is not reused
    db.close();
  });
});
