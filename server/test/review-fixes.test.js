import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, runMigrations } from '../src/db/index.js';
import { createAccount, setTestLogin } from '../src/auth/accounts.js';
import { findEmailToken, issueEmailToken } from '../src/auth/email-tokens.js';
import { sendResetEmail } from '../src/services/account-email.js';

// Fixes from the code review of 0564fb3 that had no test of their own (sign-in limits: auth-routes; grounding: evidence;
// export filter: export; word starts: text-damage; one-character twins: quiz-statements).

const NOW = new Date('2026-11-05T10:00:00.000Z');

function freshDb() {
  const db = openDb(':memory:');
  runMigrations(db);
  return db;
}

describe('email links', () => {
  it('changing the test login (P00) stops the links mailed to its old address', () => {
    const db = freshDb();
    const { accountId } = setTestLogin(db, { email: 'p00@x.com', passwordHash: 'x', now: NOW });
    const link = issueEmailToken(db, { accountId, purpose: 'reset', now: NOW });
    setTestLogin(db, { email: 'new-p00@x.com', passwordHash: 'y', now: NOW });
    assert.equal(findEmailToken(db, { token: link, purpose: 'reset', now: NOW }), null);
    db.close();
  });

  const resend = async (sendWorks) => {
    const db = freshDb();
    const { accountId } = createAccount(db, { email: 'ana@x.com', passwordHash: 'x', now: NOW, verified: true });
    const old = issueEmailToken(db, { accountId, purpose: 'reset', now: NOW });
    const mailer = { configured: true, send: async () => sendWorks };
    const sent = await sendResetEmail({ db, mailer, linkBase: 'http://x', account: { id: accountId, email: 'ana@x.com' }, now: NOW });
    const oldWorks = Boolean(findEmailToken(db, { token: old, purpose: 'reset', now: NOW }));
    const live = db.prepare("SELECT COUNT(*) AS n FROM email_tokens WHERE account_id = ? AND purpose = 'reset'").get(accountId).n;
    db.close();
    return { sent, oldWorks, live };
  };

  it('a new link that could not be sent leaves the old link working', async () => {
    assert.deepEqual(await resend(false), { sent: false, oldWorks: true, live: 2 });
  });

  it('once the new link is sent, the old one stops working', async () => {
    assert.deepEqual(await resend(true), { sent: true, oldWorks: false, live: 1 });
  });
});
