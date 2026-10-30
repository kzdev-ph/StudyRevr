import { HttpError } from '../middleware/errors.js';
import { getSetting, setSetting } from '../services/settings.js';

// Accounts (see migration 018): an email and password that open one participant. All functions here are plain
// database work; the routes decide what to say to the browser.

export const MAX_FAILED = 5;
export const LOCK_BASE_MS = 60_000;
export const LOCK_MAX_MS = 900_000;
const MAX_STUDY_NUMBER = 999;

const ACCOUNT_COLUMNS = 'a.id, a.participant_id, p.code, a.email, a.password_hash, a.must_change_password, a.failed_logins, a.lockouts, a.locked_until, a.created_at, a.password_changed_at';
const FROM = 'FROM accounts a JOIN participants p ON p.id = a.participant_id';

export const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();

export function findAccountByEmail(db, email) {
  return db.prepare(`SELECT ${ACCOUNT_COLUMNS} ${FROM} WHERE a.email = ?`).get(normalizeEmail(email));
}

export function findAccountByCode(db, code) {
  return db.prepare(`SELECT ${ACCOUNT_COLUMNS} ${FROM} WHERE p.code = ?`).get(String(code ?? '').trim().toUpperCase());
}

// The next study code. Never reuses a number: last_study_number remembers the highest one handed out, even after
// that participant is withdrawn (deleted). P00 is the researcher's test data and is never handed out.
// Call inside a transaction.
export function nextStudyCode(db) {
  let highest = 0;
  for (const { code } of db.prepare("SELECT code FROM participants WHERE code <> 'P00'").all()) {
    const m = /^P(\d+)$/.exec(code);
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  const n = Math.max(Number(getSetting(db, 'last_study_number')) || 0, highest) + 1;
  if (n > MAX_STUDY_NUMBER) throw new HttpError(503, 'Sign-ups are full right now. Please ask the researcher.', { code: 'signups_full' });
  setSetting(db, 'last_study_number', String(n));
  return `P${String(n).padStart(2, '0')}`;
}

export function createAccount(db, { email, passwordHash, now }) {
  const at = now.toISOString();
  return db.transaction(() => {
    const address = normalizeEmail(email);
    if (db.prepare('SELECT 1 FROM accounts WHERE email = ?').get(address)) {
      throw new HttpError(409, 'An account with this email already exists. Sign in instead.', { code: 'email_taken' });
    }
    const code = nextStudyCode(db);
    const participantId = Number(db.prepare('INSERT INTO participants (code, created_at) VALUES (?, ?)').run(code, at).lastInsertRowid);
    const accountId = Number(
      db
        .prepare('INSERT INTO accounts (participant_id, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
        .run(participantId, address, passwordHash, at).lastInsertRowid,
    );
    return { accountId, participantId, code };
  })();
}

// Milliseconds of lockout left (0 when the account is not locked).
export function lockedMs(account, now) {
  if (!account.locked_until) return 0;
  return Math.max(0, Date.parse(account.locked_until) - now.getTime());
}

export const lockedError = (ms) =>
  new HttpError(429, `Too many wrong passwords. Try again in ${Math.ceil(ms / 60_000)} min.`, { code: 'login_locked', retry_after_s: Math.ceil(ms / 1000) });

// Reads the lock fresh from the database and throws lockedError while it holds. Call it after awaiting a password
// check: guesses that started before the lock was set must not count, and must not sign in even when correct.
export function assertNotLocked(db, accountId, now) {
  const row = db.prepare('SELECT locked_until FROM accounts WHERE id = ?').get(accountId);
  const wait = row ? lockedMs(row, now) : 0;
  if (wait > 0) throw lockedError(wait);
}

// A wrong password. The 5th in a row locks the account for 1 minute, then 2, 4, 8 ... up to 15.
export function recordFailedLogin(db, account, now) {
  return db.transaction(() => {
    const failed = (db.prepare('SELECT failed_logins FROM accounts WHERE id = ?').get(account.id)?.failed_logins ?? 0) + 1;
    if (failed < MAX_FAILED) {
      db.prepare('UPDATE accounts SET failed_logins = ? WHERE id = ?').run(failed, account.id);
      return { lockedMs: 0 };
    }
    const lockouts = db.prepare('SELECT lockouts FROM accounts WHERE id = ?').get(account.id).lockouts;
    const wait = Math.min(LOCK_BASE_MS * 2 ** lockouts, LOCK_MAX_MS);
    db.prepare('UPDATE accounts SET failed_logins = 0, lockouts = lockouts + 1, locked_until = ? WHERE id = ?').run(
      new Date(now.getTime() + wait).toISOString(),
      account.id,
    );
    return { lockedMs: wait };
  })();
}

export function clearFailedLogins(db, accountId) {
  db.prepare('UPDATE accounts SET failed_logins = 0, lockouts = 0, locked_until = NULL WHERE id = ?').run(accountId);
}

// Stores a new password hash. `mustChange` is set after an admin reset (a temporary password).
export function setPassword(db, accountId, hash, { mustChange = false, now }) {
  db.prepare('UPDATE accounts SET password_hash = ?, must_change_password = ?, password_changed_at = ? WHERE id = ?').run(
    hash,
    mustChange ? 1 : 0,
    now.toISOString(),
    accountId,
  );
}

// Every account for the admin Accounts screen, ordered by study ID. The email and the study ID appear together here
// only: this is the one place that links them, and it sits behind the admin PIN. `signed_in`: a live login session
// exists; `active_now`: that session was seen within `timeoutMs`.
export function listAccounts(db, now, timeoutMs) {
  const rows = db
    .prepare(
      `SELECT p.code, a.email, a.created_at, a.locked_until, a.must_change_password,
              (SELECT MAX(s.last_seen_at) FROM auth_sessions s WHERE s.account_id = a.id) AS last_seen_at,
              (SELECT MAX(s.last_seen_at) FROM auth_sessions s WHERE s.account_id = a.id AND s.revoked_at IS NULL) AS live_seen_at
       ${FROM} ORDER BY p.code`,
    )
    .all();
  return rows.map((r) => ({
    code: r.code,
    email: r.email,
    created_at: r.created_at,
    test: r.code === 'P00',
    signed_in: r.live_seen_at !== null,
    active_now: r.live_seen_at !== null && now.getTime() - Date.parse(r.live_seen_at) < timeoutMs,
    last_seen_at: r.last_seen_at,
    locked_until: lockedMs(r, now) > 0 ? r.locked_until : null,
    must_change_password: Boolean(r.must_change_password),
  }));
}

// The account of P00, the researcher's test login: made on first use, otherwise its email and password are replaced
// (and the old failures forgotten). Throws 409 when the email belongs to another account. Call inside a transaction.
export function setTestLogin(db, { email, passwordHash, now }) {
  const address = normalizeEmail(email);
  const participant = db.prepare("SELECT id FROM participants WHERE code = 'P00'").get();
  if (!participant) throw new HttpError(404, 'There is no P00 participant in this database.');
  const taken = db.prepare('SELECT participant_id FROM accounts WHERE email = ?').get(address);
  if (taken && taken.participant_id !== participant.id) {
    throw new HttpError(409, 'That email belongs to another account.', { code: 'email_taken' });
  }
  const own = db.prepare('SELECT id FROM accounts WHERE participant_id = ?').get(participant.id);
  if (own) {
    db.prepare('UPDATE accounts SET email = ?, password_hash = ?, must_change_password = 0, password_changed_at = ? WHERE id = ?').run(address, passwordHash, now.toISOString(), own.id);
    clearFailedLogins(db, own.id);
    return { accountId: own.id, participantId: participant.id };
  }
  const accountId = Number(
    db.prepare('INSERT INTO accounts (participant_id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run(participant.id, address, passwordHash, now.toISOString()).lastInsertRowid,
  );
  return { accountId, participantId: participant.id };
}
