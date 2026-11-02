import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, runMigrations } from '../src/db/index.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
const AT = '2026-10-05T10:00:00.000Z';

// A database as it was before 022 (migrations 001-021).
function db021() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyrevr-mig-'));
  for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f < '022')) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
  const db = openDb(':memory:');
  runMigrations(db, dir);
  fs.rmSync(dir, { recursive: true });
  return db;
}

function addAccount(db, code = 'P01', email = 'a@x.com') {
  const participantId = Number(db.prepare('INSERT INTO participants (code, created_at) VALUES (?, ?)').run(code, AT).lastInsertRowid);
  const accountId = Number(db.prepare('INSERT INTO accounts (participant_id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run(participantId, email, 'x', AT).lastInsertRowid);
  return { participantId, accountId };
}

describe('migration 022: email_verified and email_tokens', () => {
  it('an account made before it reads as verified, and email_tokens exists afterwards', () => {
    const db = db021();
    const { accountId } = addAccount(db);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'email_tokens'").get().n, 0);

    assert.equal(runMigrations(db)[0], '022_email_verification.sql');

    assert.equal(db.prepare('SELECT email_verified FROM accounts WHERE id = ?').get(accountId).email_verified, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'email_tokens'").get().n, 1);
    assert.throws(() => db.prepare('UPDATE accounts SET email_verified = 2 WHERE id = ?').run(accountId));
    db.close();
  });

  it('deleting the participant removes its email_tokens rows', () => {
    const db = db021();
    runMigrations(db);
    const { participantId, accountId } = addAccount(db);
    db.prepare("INSERT INTO email_tokens (account_id, purpose, token_hash, created_at, expires_at) VALUES (?, 'verify', 'h1', ?, ?)").run(accountId, AT, AT);
    db.prepare("INSERT INTO email_tokens (account_id, purpose, token_hash, created_at, expires_at) VALUES (?, 'reset', 'h2', ?, ?)").run(accountId, AT, AT);
    assert.throws(() => db.prepare("INSERT INTO email_tokens (account_id, purpose, token_hash, created_at, expires_at) VALUES (?, 'other', 'h3', ?, ?)").run(accountId, AT, AT));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email_tokens').get().n, 2);

    db.prepare('DELETE FROM participants WHERE id = ?').run(participantId);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email_tokens').get().n, 0);
    db.close();
  });

  it('two live auth_sessions for one account still throw (one live login)', () => {
    const db = db021();
    runMigrations(db);
    const { accountId } = addAccount(db);
    const add = (hash) => db.prepare('INSERT INTO auth_sessions (account_id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)').run(accountId, hash, AT, AT);
    add('t1');
    assert.throws(() => add('t2'), /UNIQUE/);
    db.close();
  });
});
