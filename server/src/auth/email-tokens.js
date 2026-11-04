import { newToken, tokenHash } from './sessions.js';

// One-time links sent by email (see migration 022): the browser gets the token, the database holds only its sha256.
// All functions here are plain database work; the routes decide what to say to the browser.

export const VERIFY_TTL_MS = 24 * 60 * 60_000;
export const RESET_TTL_MS = 30 * 60_000;
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

const TTL_MS = { verify: VERIFY_TTL_MS, reset: RESET_TTL_MS };

// Makes a new link for the account and returns its token (the only time it exists outside the email). Expired rows
// are swept, and the account's older link of the same purpose stops working (`replace: false` keeps it until
// dropOlderEmailTokens, once the new one was sent).
export function issueEmailToken(db, { accountId, purpose, now, replace = true }) {
  const token = newToken();
  const at = now.toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM email_tokens WHERE expires_at <= ?').run(at);
    if (replace) db.prepare('DELETE FROM email_tokens WHERE account_id = ? AND purpose = ?').run(accountId, purpose);
    db.prepare('INSERT INTO email_tokens (account_id, purpose, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
      accountId,
      purpose,
      tokenHash(token),
      at,
      new Date(now.getTime() + TTL_MS[purpose]).toISOString(),
    );
  })();
  return token;
}

// The account's links of this purpose other than `token` stop working.
export function dropOlderEmailTokens(db, { accountId, purpose, token }) {
  db.prepare('DELETE FROM email_tokens WHERE account_id = ? AND purpose = ? AND token_hash <> ?').run(accountId, purpose, tokenHash(token));
}

// The live link row with its account, or null (malformed, unknown, used, replaced, expired or the wrong purpose).
export function findEmailToken(db, { token, purpose, now }) {
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return null;
  return (
    db
      .prepare(
        `SELECT t.id, t.account_id, a.participant_id, a.email
         FROM email_tokens t JOIN accounts a ON a.id = t.account_id
         WHERE t.token_hash = ? AND t.purpose = ? AND t.expires_at > ?`,
      )
      .get(tokenHash(token), purpose, now.toISOString()) ?? null
  );
}

// Uses the link up. False means another request used it first.
export function consumeEmailToken(db, id) {
  return db.prepare('DELETE FROM email_tokens WHERE id = ?').run(id).changes === 1;
}

export function markVerified(db, accountId) {
  db.transaction(() => {
    db.prepare('UPDATE accounts SET email_verified = 1 WHERE id = ?').run(accountId);
    db.prepare("DELETE FROM email_tokens WHERE account_id = ? AND purpose = 'verify'").run(accountId);
  })();
}
