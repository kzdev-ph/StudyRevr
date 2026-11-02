import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, runMigrations } from '../src/db/index.js';
import { hashPassword, temporaryPassword, verifyPassword } from '../src/auth/passwords.js';
import {
  clearFailedLogins,
  createAccount,
  findAccountByEmail,
  recordFailedLogin,
  lockedMs,
  setTestLogin,
} from '../src/auth/accounts.js';
import { createAuthSession, findByToken, revokeSessions } from '../src/auth/sessions.js';
import {
  RESET_TTL_MS,
  VERIFY_TTL_MS,
  consumeEmailToken,
  findEmailToken,
  issueEmailToken,
  markVerified,
} from '../src/auth/email-tokens.js';

const NOW = new Date('2026-10-05T10:00:00.000Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();

function freshDb() {
  const db = openDb(':memory:');
  runMigrations(db);
  return db;
}

const signUp = (db, email = 'juan@x.com') => createAccount(db, { email, passwordHash: 'x', now: NOW });

describe('passwords', () => {
  it('round trips, and rejects a wrong password or a malformed hash', async () => {
    const hash = await hashPassword('correct horse');
    assert.match(hash, /^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
    assert.equal(await verifyPassword('correct horse', hash), true);
    assert.equal(await verifyPassword('wrong horse', hash), false);
    for (const bad of ['', 'nope', 'scrypt$1$2', 'scrypt$x$8$1$aa$bb', 'bcrypt$16384$8$1$aa$bb', null, undefined]) {
      assert.equal(await verifyPassword('correct horse', bad), false, String(bad));
    }
  });

  it('the same password typed composed or decomposed (ñ) is one password', async () => {
    const composed = 'mañana por la mañana';
    const decomposed = composed.normalize('NFD');
    assert.notEqual(composed, decomposed);
    assert.equal(await verifyPassword(decomposed, await hashPassword(composed)), true);
    assert.equal(await verifyPassword(composed, await hashPassword(decomposed)), true);
    assert.equal(await verifyPassword('manana por la manana', await hashPassword(composed)), false);
  });

  it('salts every hash, and temporary passwords have the right shape', async () => {
    assert.notEqual(await hashPassword('same'), await hashPassword('same'));
    for (let i = 0; i < 20; i++) assert.match(temporaryPassword(), /^[abcdefghjkmnpqrstuvwxyz23456789]{10}$/);
  });
});

describe('accounts', () => {
  it('hands out P01, P02 and never P00; a withdrawn code is not reused', () => {
    const db = freshDb();
    assert.equal(signUp(db, 'a@x.com').code, 'P01');
    const second = signUp(db, 'b@x.com');
    assert.equal(second.code, 'P02');
    db.prepare('DELETE FROM participants WHERE id = ?').run(second.participantId);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM accounts').get().n, 1);
    assert.equal(signUp(db, 'c@x.com').code, 'P03');
    db.close();
  });

  it('treats emails case-insensitively and ignores spaces', () => {
    const db = freshDb();
    signUp(db, 'JUAN@x.com ');
    assert.equal(findAccountByEmail(db, ' Juan@X.com').email, 'juan@x.com');
    assert.throws(() => signUp(db, 'juan@x.com'), (e) => e.status === 409 && e.extra.code === 'email_taken');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM participants').get().n, 2); // P00 and P01 only
    db.close();
  });

  it('refuses a second live login session for one account', () => {
    const db = freshDb();
    const { accountId } = signUp(db);
    createAuthSession(db, accountId, NOW);
    assert.throws(() => createAuthSession(db, accountId, NOW), /UNIQUE/);
    db.close();
  });
});

describe('email tokens', () => {
  const verified = (db, id) => db.prepare('SELECT email_verified FROM accounts WHERE id = ?').get(id).email_verified;

  it('a sign-up with verified: false is stored as 0, and the test login stays verified', () => {
    const db = freshDb();
    const { accountId } = createAccount(db, { email: 'new@x.com', passwordHash: 'x', now: NOW, verified: false });
    assert.equal(verified(db, accountId), 0);
    assert.equal(signUp(db, 'old@x.com').accountId > 0, true);
    assert.equal(findAccountByEmail(db, 'old@x.com').email_verified, 1);

    const test = setTestLogin(db, { email: 'p00@x.com', passwordHash: 'x', now: NOW });
    assert.equal(verified(db, test.accountId), 1);
    db.prepare('UPDATE accounts SET email_verified = 0 WHERE id = ?').run(test.accountId);
    setTestLogin(db, { email: 'p00@x.com', passwordHash: 'y', now: NOW });
    assert.equal(verified(db, test.accountId), 1);
    db.close();
  });

  it('issue then find works; a newer link replaces the older one', () => {
    const db = freshDb();
    const { accountId, participantId } = signUp(db);
    const first = issueEmailToken(db, { accountId, purpose: 'reset', now: NOW });
    assert.match(first, /^[A-Za-z0-9_-]{43}$/);
    const found = findEmailToken(db, { token: first, purpose: 'reset', now: NOW });
    assert.deepEqual([found.account_id, found.participant_id, found.email], [accountId, participantId, 'juan@x.com']);
    assert.equal(db.prepare('SELECT token_hash FROM email_tokens').get().token_hash.includes(first), false);

    const second = issueEmailToken(db, { accountId, purpose: 'reset', now: NOW });
    assert.equal(findEmailToken(db, { token: first, purpose: 'reset', now: NOW }), null);
    assert.ok(findEmailToken(db, { token: second, purpose: 'reset', now: NOW }));
    // a link of the other purpose is not replaced
    const verify = issueEmailToken(db, { accountId, purpose: 'verify', now: NOW });
    assert.ok(findEmailToken(db, { token: second, purpose: 'reset', now: NOW }));
    assert.ok(findEmailToken(db, { token: verify, purpose: 'verify', now: NOW }));
    db.close();
  });

  it('expires after the purpose time, and is null for the wrong purpose or a malformed token', () => {
    const db = freshDb();
    const { accountId } = signUp(db);
    const reset = issueEmailToken(db, { accountId, purpose: 'reset', now: NOW });
    const verify = issueEmailToken(db, { accountId, purpose: 'verify', now: NOW });
    const after = (ms) => new Date(NOW.getTime() + ms);
    assert.ok(findEmailToken(db, { token: reset, purpose: 'reset', now: after(RESET_TTL_MS - 1) }));
    assert.equal(findEmailToken(db, { token: reset, purpose: 'reset', now: after(RESET_TTL_MS) }), null);
    assert.ok(findEmailToken(db, { token: verify, purpose: 'verify', now: after(RESET_TTL_MS) }));
    assert.equal(findEmailToken(db, { token: verify, purpose: 'verify', now: after(VERIFY_TTL_MS) }), null);

    assert.equal(findEmailToken(db, { token: reset, purpose: 'verify', now: NOW }), null);
    for (const bad of ['', 'short', `${reset}x`, reset.slice(1), `${reset.slice(1)}!`, null, undefined, 42, {}]) {
      assert.equal(findEmailToken(db, { token: bad, purpose: 'reset', now: NOW }), null, String(bad));
    }

    // issuing sweeps rows that have expired
    issueEmailToken(db, { accountId, purpose: 'verify', now: after(VERIFY_TTL_MS + 1) });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM email_tokens WHERE purpose = 'reset'").get().n, 0);
    db.close();
  });

  it('consume works once; markVerified verifies and drops the verify links', () => {
    const db = freshDb();
    const { accountId } = createAccount(db, { email: 'new@x.com', passwordHash: 'x', now: NOW, verified: false });
    const token = issueEmailToken(db, { accountId, purpose: 'verify', now: NOW });
    const reset = issueEmailToken(db, { accountId, purpose: 'reset', now: NOW });
    const { id } = findEmailToken(db, { token, purpose: 'verify', now: NOW });
    assert.equal(consumeEmailToken(db, id), true);
    assert.equal(consumeEmailToken(db, id), false);
    assert.equal(findEmailToken(db, { token, purpose: 'verify', now: NOW }), null);

    const again = issueEmailToken(db, { accountId, purpose: 'verify', now: NOW });
    markVerified(db, accountId);
    assert.equal(verified(db, accountId), 1);
    assert.equal(findEmailToken(db, { token: again, purpose: 'verify', now: NOW }), null);
    assert.ok(findEmailToken(db, { token: reset, purpose: 'reset', now: NOW }));
    db.close();
  });
});

describe('revokeSessions', () => {
  it('sets the reason and ends only study sessions that were active recently', () => {
    const db = freshDb();
    const { accountId, participantId } = signUp(db);
    const token = createAuthSession(db, accountId, NOW);
    const add = (lastActive) =>
      Number(
        db
          .prepare("INSERT INTO study_sessions (participant_id, activity, started_at, last_active_at, active_ms, study_date) VALUES (?, 'reading', ?, ?, 1000, '2026-10-05')")
          .run(participantId, minutesAgo(30), lastActive).lastInsertRowid,
      );
    const recent = add(minutesAgo(1));
    const old = add(minutesAgo(10));

    assert.equal(revokeSessions(db, { accountId, participantId, reason: 'signed_out_elsewhere', now: NOW }), 1);
    const found = findByToken(db, token);
    assert.equal(found.revoked_reason, 'signed_out_elsewhere');
    assert.equal(found.code, 'P01');
    assert.ok(found.revoked_at);
    const row = (id) => db.prepare('SELECT ended_at, end_reason FROM study_sessions WHERE id = ?').get(id);
    assert.deepEqual(row(recent), { ended_at: minutesAgo(1), end_reason: 'signed_out_elsewhere' });
    assert.deepEqual(row(old), { ended_at: null, end_reason: null });

    // a password reset reads as an admin sign-out in the study data
    createAuthSession(db, accountId, NOW);
    const again = add(minutesAgo(2));
    revokeSessions(db, { accountId, participantId, reason: 'password_reset', now: NOW });
    assert.equal(row(again).end_reason, 'signed_out_by_admin');
    db.close();
  });
});

describe('lockout', () => {
  const fail = (db, id, now, times) => {
    let last;
    for (let i = 0; i < times; i++) last = recordFailedLogin(db, { id }, now);
    return last;
  };
  const account = (db, id) => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);

  it('locks for 60 s, then 120 s, and caps at 15 minutes', () => {
    const db = freshDb();
    const { accountId } = signUp(db);
    assert.equal(fail(db, accountId, NOW, 4).lockedMs, 0);
    assert.equal(lockedMs(account(db, accountId), NOW), 0);
    assert.equal(fail(db, accountId, NOW, 1).lockedMs, 60_000);
    assert.equal(lockedMs(account(db, accountId), NOW), 60_000);
    assert.equal(account(db, accountId).failed_logins, 0);

    let now = new Date(NOW.getTime() + 61_000); // the first lock has expired
    assert.equal(lockedMs(account(db, accountId), now), 0);
    assert.equal(fail(db, accountId, now, 5).lockedMs, 120_000);

    const waits = [];
    for (let i = 0; i < 6; i++) {
      now = new Date(now.getTime() + 1_000_000);
      waits.push(fail(db, accountId, now, 5).lockedMs);
    }
    assert.deepEqual(waits, [240_000, 480_000, 900_000, 900_000, 900_000, 900_000]);
    db.close();
  });

  it('clearFailedLogins resets everything', () => {
    const db = freshDb();
    const { accountId } = signUp(db);
    fail(db, accountId, NOW, 5);
    fail(db, accountId, NOW, 2);
    clearFailedLogins(db, accountId);
    const a = account(db, accountId);
    assert.deepEqual([a.failed_logins, a.lockouts, a.locked_until], [0, 0, null]);
    db.close();
  });
});
