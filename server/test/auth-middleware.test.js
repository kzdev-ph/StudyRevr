import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { revokeSessions } from '../src/auth/sessions.js';
import { addCodes, seedLesson, startStudyApp, tokenFor } from './helpers.js';

const NOON = '2026-10-05T04:00:00.000Z';

describe('token auth in the middleware', () => {
  let t;
  afterEach(() => t?.close());

  const withToken = (token, path, headers = {}) => globalThis.fetch(`${t.base}${path}`, { headers: { authorization: `Bearer ${token}`, ...headers } });
  const lastSeen = (code) =>
    t.db.prepare('SELECT s.last_seen_at AS at FROM auth_sessions s JOIN accounts a ON a.id = s.account_id JOIN participants p ON p.id = a.participant_id WHERE p.code = ?').get(code).at;
  const start = async () => {
    t = await startStudyApp({ now: NOON });
    addCodes(t.db, 'P01', 'P02');
  };

  it('a token identifies the participant on GET /api/stats and POST /api/sessions', async () => {
    await start();
    const { lessonId } = seedLesson(t.db);
    const stats = await t.call('GET', '/api/stats', { as: 'P01' });
    assert.equal(stats.status, 200);
    const session = await t.call('POST', '/api/sessions', { as: 'P01', body: { lesson_id: lessonId, activity: 'reading' } });
    assert.equal(session.status, 201);
    const owner = t.db.prepare('SELECT p.code FROM study_sessions s JOIN participants p ON p.id = s.participant_id').get();
    assert.equal(owner.code, 'P01');
  });

  it('a token that is not known is 401 session_unknown', async () => {
    await start();
    const res = await withToken('not-a-real-token', '/api/stats');
    assert.equal(res.status, 401);
    const { error } = await res.json();
    assert.equal(error.code, 'session_unknown');
    assert.equal(error.message, 'Please sign in again.');
  });

  it('a revoked token is 401 with the code of the reason', async () => {
    await start();
    const cases = [
      ['signed_out', 'session_unknown', 'Please sign in again.'],
      ['signed_out_elsewhere', 'signed_out_elsewhere', 'You were signed out because your account was opened on another device.'],
      ['signed_out_by_admin', 'signed_out_by_admin', 'Your teacher signed you out. Sign in again.'],
      ['password_reset', 'password_reset', 'Your teacher reset your password. Sign in with the new one.'],
    ];
    for (const [reason, code, message] of cases) {
      const token = tokenFor(t.db, 'P01', new Date(t.now));
      assert.equal((await withToken(token, '/api/stats')).status, 200, `${reason} before`);
      const account = t.db.prepare("SELECT a.id, a.participant_id FROM accounts a JOIN participants p ON p.id = a.participant_id WHERE p.code = 'P01'").get();
      revokeSessions(t.db, { accountId: account.id, participantId: account.participant_id, reason, now: new Date(t.now) });
      const res = await withToken(token, '/api/stats');
      assert.equal(res.status, 401, reason);
      const { error } = await res.json();
      assert.equal(error.code, code, reason);
      assert.equal(error.message, message, reason);
      // a fresh login for the next case
      t.db.prepare('DELETE FROM auth_sessions').run();
      t.db.prepare('DELETE FROM accounts').run();
      await t.close();
      await start();
    }
  });

  it('an account that must change its password is 403 password_change_required', async () => {
    await start();
    const token = tokenFor(t.db, 'P01', new Date(t.now));
    t.db.prepare("UPDATE accounts SET must_change_password = 1 WHERE email = 'p01@test.invalid'").run();
    const res = await withToken(token, '/api/stats');
    assert.equal(res.status, 403);
    const { error } = await res.json();
    assert.equal(error.code, 'password_change_required');
    assert.equal(error.message, 'Choose a new password first.');
  });

  it('last_seen_at moves only after 10 seconds on the clock', async () => {
    await start();
    assert.equal((await t.call('GET', '/api/stats', { as: 'P01' })).status, 200);
    assert.equal(lastSeen('P01'), NOON);
    t.now = '2026-10-05T04:00:09.000Z';
    await t.call('GET', '/api/stats', { as: 'P01' });
    assert.equal(lastSeen('P01'), NOON, 'after 9 seconds');
    t.now = '2026-10-05T04:00:11.000Z';
    await t.call('GET', '/api/stats', { as: 'P01' });
    assert.equal(lastSeen('P01'), '2026-10-05T04:00:11.000Z', 'after 11 seconds');
  });

  it('an X-Participant header is ignored: the token alone says who is asking', async () => {
    await start();
    const { lessonId } = seedLesson(t.db);
    const token = tokenFor(t.db, 'P01', new Date(t.now));
    const res = await globalThis.fetch(`${t.base}/api/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-participant': 'P02', 'content-type': 'application/json' },
      body: JSON.stringify({ lesson_id: lessonId, activity: 'reading' }),
    });
    assert.equal(res.status, 201);
    const owner = t.db.prepare('SELECT p.code FROM study_sessions s JOIN participants p ON p.id = s.participant_id').get();
    assert.equal(owner.code, 'P01');
  });
});
