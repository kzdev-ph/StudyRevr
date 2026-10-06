import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, runMigrations } from '../src/db/index.js';
import { saveStudentKey } from '../src/services/student-ai.js';
import { addCodes, startStudyApp, TEST_PIN } from './helpers.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'delete-participant.js');
const SECRET = 'sk-wipe-test-SECRET-7654321';
const NOW = new Date('2026-10-05T04:00:00.000Z');

// After a student key is deleted, it must not be readable anywhere on disk: neither in the database file nor in the
// write-ahead log (-wal), where the old page lives until a checkpoint copies the new one over it. The database stays
// open while we look, like the running server.
describe('deleted student keys leave no trace on disk', () => {
  let dir;
  let dbPath;
  let db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyrevr-wipe-'));
    dbPath = path.join(dir, 'study.db');
    db = openDb(dbPath);
    runMigrations(db);
    addCodes(db, 'P01', 'P02');
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const participantId = (code) => db.prepare('SELECT id FROM participants WHERE code = ?').get(code).id;
  const keyFor = (code, apiKey = SECRET) => saveStudentKey(db, participantId(code), { provider: 'deepseek', model: 'deepseek-chat', apiKey }, NOW);
  const onDisk = (secret = SECRET) => ['', '-wal'].filter((suffix) => fs.existsSync(dbPath + suffix) && fs.readFileSync(dbPath + suffix).includes(secret));

  it('the scan can see a saved key (so the checks below mean something)', () => {
    keyFor('P01');
    assert.deepEqual(onDisk(), ['-wal']);
  });

  it('Remove my key', async () => {
    const t = await startStudyApp({ db });
    keyFor('P01');
    assert.deepEqual(onDisk(), ['-wal']);
    const res = await t.call('DELETE', '/api/my-ai/key', { as: 'P01' });
    assert.equal(res.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM participant_ai_keys').get().n, 0);
    assert.deepEqual(onDisk(), []);
    await t.close();
  });

  it('Delete all student keys', async () => {
    const t = await startStudyApp({ db });
    keyFor('P01');
    keyFor('P02', 'sk-wipe-test-OTHER-1234567');
    assert.deepEqual(onDisk(), ['-wal']);
    const res = await t.call('DELETE', '/api/admin/student-keys', { pin: TEST_PIN });
    assert.equal(res.body.deleted, 2);
    assert.deepEqual(onDisk(), []);
    assert.deepEqual(onDisk('sk-wipe-test-OTHER-1234567'), []);
    await t.close();
  });

  it('replacing a saved key leaves the old one nowhere either', () => {
    keyFor('P01');
    keyFor('P01', 'sk-wipe-test-NEWER-1234567');
    assert.deepEqual(onDisk(), []);
    assert.equal(onDisk('sk-wipe-test-NEWER-1234567').length, 1, 'the new key is stored, in the file now that the log is emptied');
  });

  it('npm run participant:delete, with the server (another connection) still running', async () => {
    keyFor('P01');
    assert.deepEqual(onDisk(), ['-wal']);
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, [SCRIPT, 'P01', '--yes'], { env: { ...process.env, DB_PATH: dbPath }, stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '';
      child.stdout.on('data', (d) => { text += d; });
      child.stderr.on('data', (d) => { text += d; });
      child.on('close', (code) => resolve({ code, text }));
    });
    assert.equal(out.code, 0, out.text);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM participants WHERE code = 'P01'").get().n, 0);
    assert.deepEqual(onDisk(), []);
  });
});
