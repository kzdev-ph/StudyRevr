import crypto from 'node:crypto';
import { endOpenSessions } from '../sessions/store.js';

// Login sessions (see migration 018): the browser holds a random token, the database holds only its sha256.
// At most one session per account is live; signing in elsewhere revokes the old one.

// last_seen_at is written at most this often, so a busy page does not write on every request.
export const TOUCH_MS = 10_000;

// The study-session end reason that goes with each login-session revoke reason.
const STUDY_END_REASON = {
  signed_out: 'signed_out',
  signed_out_elsewhere: 'signed_out_elsewhere',
  signed_out_by_admin: 'signed_out_by_admin',
  password_reset: 'signed_out_by_admin',
};

export const newToken = () => crypto.randomBytes(32).toString('base64url');

export const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// Starts a login session and returns the token (the only time it exists outside the browser).
export function createAuthSession(db, accountId, now) {
  const token = newToken();
  const at = now.toISOString();
  db.prepare('INSERT INTO auth_sessions (account_id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)').run(accountId, tokenHash(token), at, at);
  return token;
}

export function findByToken(db, token) {
  if (!token || typeof token !== 'string') return null;
  return (
    db
      .prepare(
        `SELECT s.id, s.account_id, a.participant_id, p.code, a.email, a.must_change_password, s.last_seen_at, s.revoked_at, s.revoked_reason
         FROM auth_sessions s JOIN accounts a ON a.id = s.account_id JOIN participants p ON p.id = a.participant_id
         WHERE s.token_hash = ?`,
      )
      .get(tokenHash(token)) ?? null
  );
}

export function activeSession(db, accountId) {
  return db.prepare('SELECT id, account_id, created_at, last_seen_at FROM auth_sessions WHERE account_id = ? AND revoked_at IS NULL').get(accountId) ?? null;
}

export function touch(db, session, now) {
  if (now.getTime() - Date.parse(session.last_seen_at) < TOUCH_MS) return;
  db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?').run(now.toISOString(), session.id);
}

// Revokes the account's live session and closes the participant's open study sessions. Returns how many login
// sessions were revoked (0 or 1). With `sessionId` only that login session is revoked, and when it was already gone
// (signed in elsewhere in the meantime) the study sessions are left alone, as they belong to the newer login.
export function revokeSessions(db, { accountId, participantId, reason, now, sessionId }) {
  return db.transaction(() => {
    const revoked = sessionId
      ? db
          .prepare('UPDATE auth_sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL')
          .run(now.toISOString(), reason, sessionId, accountId).changes
      : db
          .prepare('UPDATE auth_sessions SET revoked_at = ?, revoked_reason = ? WHERE account_id = ? AND revoked_at IS NULL')
          .run(now.toISOString(), reason, accountId).changes;
    if (revoked || !sessionId) endOpenSessions(db, { participantId, reason: STUDY_END_REASON[reason], now });
    return revoked;
  })();
}

// A password change swaps the login session: the old token stops working and a new one is returned. The open study
// session is not touched (the student is still on this device). Returns the new token, or null when `sessionId`
// was no longer live.
export function replaceSession(db, { accountId, sessionId, now }) {
  return db.transaction(() => {
    const revoked = db
      .prepare("UPDATE auth_sessions SET revoked_at = ?, revoked_reason = 'signed_out' WHERE id = ? AND account_id = ? AND revoked_at IS NULL")
      .run(now.toISOString(), sessionId, accountId).changes;
    return revoked ? createAuthSession(db, accountId, now) : null;
  })();
}
