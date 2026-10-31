import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, runMigrations } from '../src/db/index.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');

// A database as it was before 020 (migrations 001-019).
function db019() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyrevr-mig-'));
  for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f < '020')) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
  const db = openDb(':memory:');
  runMigrations(db, dir);
  fs.rmSync(dir, { recursive: true });
  return db;
}

describe('migration 020: text_warning', () => {
  it('adds the column; lessons made before it are NULL, and a code can be stored', () => {
    const db = db019();
    const id = Number(db.prepare("INSERT INTO lessons (title, filename, raw_text, word_count, status) VALUES ('L', 'l.pdf', 't', 1, 'ready')").run().lastInsertRowid);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('lessons') WHERE name = 'text_warning'").get().n, 0);

    assert.equal(runMigrations(db)[0], '020_text_warning.sql');

    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('lessons') WHERE name = 'text_warning'").get().n, 1);
    assert.equal(db.prepare('SELECT text_warning FROM lessons WHERE id = ?').get(id).text_warning, null);
    db.prepare("UPDATE lessons SET text_warning = 'damaged_text' WHERE id = ?").run(id);
    assert.equal(db.prepare('SELECT text_warning FROM lessons WHERE id = ?').get(id).text_warning, 'damaged_text');
    db.close();
  });
});
