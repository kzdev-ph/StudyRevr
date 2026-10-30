import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from '../src/auth/passwords.js';
import { startStudyApp, TEST_PIN } from './helpers.js';

const START = '2026-10-05T04:00:00.000Z';
const PASSWORD = 'correct horse battery';
const SECOND = 1000;

describe('auth routes', () => {
  let t;
  afterEach(() => t?.close());

  const start = async () => {
    t = await startStudyApp({ now: START });
  };
  const at = (seconds) => (t.now = new Date(Date.parse(START) + seconds * SECOND).toISOString());

  // t.call signs in through tokenFor; these routes are tested with the tokens the routes themselves hand out
  const api = async (method, path, { token, body } = {}) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await globalThis.fetch(`${t.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, text, body: text ? JSON.parse(text) : null };
  };
  const signup = (email = 'ana@example.com', password = PASSWORD) => api('POST', '/api/auth/signup', { body: { email, password } });
  const login = (body) => api('POST', '/api/auth/login', { body: { email: 'ana@example.com', password: PASSWORD, ...body } });
  const wrong = () => login({ password: 'not the password' });
  const startStudy = (token) => api('POST', '/api/sessions', { token, body: { lesson_id: null, activity: 'reading' } });
  const endReason = (sessionId) => t.db.prepare('SELECT end_reason FROM study_sessions WHERE id = ?').get(sessionId).end_reason;
  // a random token can contain "P1" by chance, so the check on the rest of the answer leaves the token out
  const withoutToken = (res) => JSON.stringify({ ...res.body, token: undefined });
  const liveLogins = () => t.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL').get().n;

  describe('sign up', () => {
    it('gives a token that works, and no study ID anywhere in the answer', async () => {
      await start();
      const res = await signup();
      assert.equal(res.status, 201);
      assert.deepEqual(res.body.account, { email: 'ana@example.com', must_change_password: false });
      assert.ok(res.body.token);
      assert.doesNotMatch(withoutToken(res), /P\d/);
      const stats = await api('GET', '/api/stats', { token: res.body.token });
      assert.equal(stats.status, 200);
      assert.doesNotMatch(stats.text, /P\d/); // the Stats answer does not carry the study ID either
      assert.equal('participant' in stats.body, false);
      // the account got the next study code, but only the database knows it
      assert.equal(t.db.prepare('SELECT p.code FROM accounts a JOIN participants p ON p.id = a.participant_id').get().code, 'P01');
    });

    it('stores the email trimmed and lowercased, and the password only as a hash', async () => {
      await start();
      assert.equal((await signup('  Ana@Example.COM ')).status, 201);
      const row = t.db.prepare('SELECT email, password_hash FROM accounts').get();
      assert.equal(row.email, 'ana@example.com');
      assert.ok(row.password_hash.startsWith('scrypt$'));
      assert.ok(!row.password_hash.includes(PASSWORD));
    });

    it('a duplicate email in another case is 409', async () => {
      await start();
      await signup('ana@example.com');
      const again = await signup('ANA@Example.com');
      assert.equal(again.status, 409);
      assert.equal(again.body.error.code, 'email_taken');
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 1);
    });

    it('is 403 signups_off while sign-ups are switched off', async () => {
      await start();
      assert.equal((await t.call('PUT', '/api/settings', { pin: TEST_PIN, body: { allow_signups: false } })).status, 200);
      const res = await signup();
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'signups_off');
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 0);
    });

    it('answers 400 for a bad email, a short password or an extra field', async () => {
      await start();
      for (const body of [{ email: 'not-an-email', password: PASSWORD }, { email: 'a@b.co', password: 'short' }, { email: 'a@b.co', password: PASSWORD, extra: 1 }, {}]) {
        assert.equal((await api('POST', '/api/auth/signup', { body })).status, 400, JSON.stringify(Object.keys(body)));
      }
    });

    it('answers 400 password_too_common for a very common password or the email name, and accepts a passphrase', async () => {
      await start();
      for (const password of ['password', 'Password1', '12345678', '  PASSWORD  ', 'ana.reyes']) {
        const res = await signup(password === 'ana.reyes' ? 'ana.reyes@example.com' : 'ana@example.com', password);
        assert.equal(res.status, 400, password);
        assert.equal(res.body.error.code, 'password_too_common', password);
        assert.equal(res.body.error.message, 'That password is too common. Try a longer phrase.');
      }
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 0);
      assert.equal((await signup('ana@example.com', 'blue-river-lamp-42')).status, 201);
    });

    it('allows 10 sign-ups per IP in 10 minutes, then 429 until the window passes', async () => {
      await start();
      for (let i = 0; i < 10; i++) assert.equal((await signup(`s${i}@example.com`)).status, 201);
      const blocked = await signup('s10@example.com');
      assert.equal(blocked.status, 429);
      assert.equal(blocked.body.error.code, 'signup_rate_limited');
      at(601);
      assert.equal((await signup('s10@example.com')).status, 201);
    });
  });

  describe('lockout', () => {
    it('a wrong password and an unknown email give the same answer', async () => {
      await start();
      await signup();
      const a = await wrong();
      const b = await login({ email: 'nobody@example.com' });
      assert.equal(a.status, 401);
      assert.deepEqual(a.body, b.body);
      assert.equal(a.body.error.code, 'login_failed');
    });

    it('5 wrong passwords lock the account for 61 s, even for the right password; then login works', async () => {
      await start();
      await signup();
      for (let i = 0; i < 4; i++) assert.equal((await wrong()).status, 401);
      const fifth = await wrong();
      assert.equal(fifth.status, 429);
      assert.equal(fifth.body.error.code, 'login_locked');
      assert.equal(fifth.body.error.retry_after_s, 60);
      assert.match(fifth.body.error.message, /Try again in 1 min/);
      at(30);
      assert.equal((await login()).status, 429); // the right password does not help while locked
      at(61);
      assert.equal((await login()).status, 200);
    });

    it('a second lock lasts 120 s', async () => {
      await start();
      await signup();
      for (let i = 0; i < 5; i++) await wrong();
      at(61);
      for (let i = 0; i < 4; i++) assert.equal((await wrong()).status, 401);
      const second = await wrong();
      assert.equal(second.status, 429);
      assert.equal(second.body.error.retry_after_s, 120);
      at(61 + 119);
      assert.equal((await login()).status, 429);
      at(61 + 121);
      assert.equal((await login()).status, 200);
    });

    it('parallel guesses: at most 5 count, the rest answer 429, and the right password in the pile signs nobody in', async () => {
      await start();
      await signup();
      const results = await Promise.all([...Array.from({ length: 20 }, () => wrong()), login()]);
      const codes = results.map((r) => r.body?.error?.code);
      assert.ok(codes.filter((c) => c === 'login_failed').length <= 5);
      assert.ok(codes.filter((c) => c === 'login_locked').length >= 16);
      assert.equal(results.filter((r) => r.status === 200).length, 0);
      assert.equal(results.at(-1).status, 429);
      assert.equal(t.db.prepare('SELECT lockouts FROM accounts').get().lockouts, 1); // locked once; late guesses did not lock it again
    });

    it('password: 5 wrong current passwords lock the account, and sign-in is locked too', async () => {
      await start();
      const { token } = (await signup()).body;
      const change = (current) => api('POST', '/api/auth/password', { token, body: { current, next: 'a brand new one' } });
      for (let i = 0; i < 4; i++) assert.equal((await change('nope nope nope')).status, 401);
      const fifth = await change('nope nope nope');
      assert.equal(fifth.status, 429);
      assert.equal(fifth.body.error.code, 'login_locked');
      assert.equal((await change(PASSWORD)).status, 429); // the right one does not help while locked
      const res = await login();
      assert.equal(res.status, 429);
      assert.equal(res.body.error.code, 'login_locked');
      at(61);
      assert.equal((await change(PASSWORD)).status, 200);
    });

    it('a good login starts the count again', async () => {
      await start();
      await signup();
      for (let i = 0; i < 4; i++) await wrong();
      at(61);
      assert.equal((await login()).status, 200);
      for (let i = 0; i < 4; i++) assert.equal((await wrong()).status, 401);
    });
  });

  describe('one device at a time', () => {
    it('a device seen within the timeout gets 409 and nothing changes; takeover signs the old one out', async () => {
      await start();
      const old = (await signup()).body.token;
      at(10);
      const study = (await startStudy(old)).body.session.id;
      at(30);
      const asked = await login();
      assert.equal(asked.status, 409);
      assert.equal(asked.body.error.code, 'active_elsewhere');
      assert.equal(asked.body.token, undefined);
      assert.equal(liveLogins(), 1);
      assert.equal((await api('GET', '/api/auth/me', { token: old })).status, 200);
      assert.equal(endReason(study), null);

      const taken = await login({ takeover: true });
      assert.equal(taken.status, 200);
      assert.doesNotMatch(withoutToken(taken), /P\d/);
      assert.equal(liveLogins(), 1);
      const gone = await api('GET', '/api/auth/me', { token: old });
      assert.equal(gone.status, 401);
      assert.equal(gone.body.error.code, 'signed_out_elsewhere');
      assert.equal(endReason(study), 'signed_out_elsewhere');
      assert.equal((await api('GET', '/api/auth/me', { token: taken.body.token })).status, 200);
    });

    it('a device idle for longer than the timeout is replaced without a prompt', async () => {
      await start();
      const old = (await signup()).body.token;
      at(59);
      assert.equal((await login()).status, 409);
      at(61);
      const res = await login();
      assert.equal(res.status, 200);
      assert.equal((await api('GET', '/api/auth/me', { token: old })).body.error.code, 'signed_out_elsewhere');
    });

    it('the timeout is the admin setting', async () => {
      await start();
      await t.call('PUT', '/api/settings', { pin: TEST_PIN, body: { session_timeout_seconds: 300 } });
      await signup();
      at(100);
      assert.equal((await login()).status, 409);
      at(301);
      assert.equal((await login()).status, 200);
    });

    it('a token used again three days later on the same device still works', async () => {
      await start();
      const { token } = (await signup()).body;
      at(3 * 24 * 3600);
      assert.equal((await api('GET', '/api/auth/me', { token })).status, 200);
      assert.equal((await api('GET', '/api/stats', { token })).status, 200);
    });
  });

  describe('logout, me, password', () => {
    it('logout revokes the token and ends the open study session as signed_out', async () => {
      await start();
      const { token } = (await signup()).body;
      const study = (await startStudy(token)).body.session.id;
      at(20);
      assert.equal((await api('POST', '/api/auth/logout', { token })).status, 204);
      assert.equal((await api('GET', '/api/stats', { token })).status, 401);
      assert.equal(endReason(study), 'signed_out');
      assert.equal(liveLogins(), 0);
      assert.equal((await login()).status, 200); // and signing in again is no problem
    });

    it('logout revokes only the caller\'s own login session; a stale token cannot end the newer login\'s study', async () => {
      await start();
      const old = (await signup()).body.token;
      at(10);
      const taken = await login({ takeover: true });
      const study = (await startStudy(taken.body.token)).body.session.id;
      assert.equal((await api('POST', '/api/auth/logout', { token: old })).status, 401); // already revoked: no session to log out
      assert.equal(endReason(study), null);
      assert.equal((await api('POST', '/api/auth/logout', { token: taken.body.token })).status, 204);
      assert.equal(endReason(study), 'signed_out');
    });

    it('test helper: t.call as a code gets a fresh login after its token was revoked', async () => {
      await start();
      t.db.prepare("INSERT INTO participants (code) VALUES ('P05')").run();
      assert.equal((await t.call('GET', '/api/stats', { as: 'P05' })).status, 200);
      const { account_id: accountId } = t.db.prepare('SELECT account_id FROM auth_sessions').get();
      t.db.prepare("UPDATE auth_sessions SET revoked_at = ?, revoked_reason = 'signed_out' WHERE account_id = ?").run(t.now, accountId);
      assert.equal((await t.call('GET', '/api/stats', { as: 'P05' })).status, 200);
      assert.equal(liveLogins(), 1);
    });

    it('logout, me and password need a token', async () => {
      await start();
      for (const [method, path] of [['POST', '/api/auth/logout'], ['GET', '/api/auth/me'], ['POST', '/api/auth/password']]) {
        const res = await api(method, path, { body: method === 'POST' ? {} : undefined });
        assert.equal(res.status, 401, `${method} ${path}`);
      }
    });

    it('me gives the email and the must-change flag, and moves last_seen', async () => {
      await start();
      const { token } = (await signup()).body;
      t.db.prepare('UPDATE accounts SET must_change_password = 1').run();
      at(15);
      const me = await api('GET', '/api/auth/me', { token });
      assert.equal(me.status, 200);
      assert.deepEqual(me.body, { account: { email: 'ana@example.com', must_change_password: true } });
      assert.equal(t.db.prepare('SELECT last_seen_at FROM auth_sessions').get().last_seen_at, t.now);
    });

    it('password: a wrong current password is 401; the right one changes it, clears the flag and swaps the token', async () => {
      await start();
      const { token } = (await signup()).body;
      const study = (await startStudy(token)).body.session.id;
      t.db.prepare('UPDATE accounts SET must_change_password = 1').run();
      const bad = await api('POST', '/api/auth/password', { token, body: { current: 'nope nope nope', next: 'a brand new one' } });
      assert.equal(bad.status, 401);
      assert.equal(bad.body.error.code, 'wrong_password');
      assert.equal((await api('POST', '/api/auth/password', { token, body: { current: PASSWORD, next: 'short' } })).status, 400);

      assert.equal((await api('POST', '/api/auth/password', { token, body: { current: PASSWORD, next: PASSWORD } })).status, 400); // not a change

      const changed = await api('POST', '/api/auth/password', { token, body: { current: PASSWORD, next: 'a brand new one' } });
      assert.equal(changed.status, 200);
      assert.deepEqual(changed.body.account, { email: 'ana@example.com', must_change_password: false });
      assert.ok(changed.body.token && changed.body.token !== token);
      assert.doesNotMatch(withoutToken(changed), /P\d/);
      assert.equal(t.db.prepare('SELECT must_change_password FROM accounts').get().must_change_password, 0);
      // the old token is dead, the new one works, and the study session was not ended
      assert.equal((await api('GET', '/api/auth/me', { token })).status, 401);
      assert.equal((await api('GET', '/api/auth/me', { token: changed.body.token })).body.account.must_change_password, false);
      assert.equal(liveLogins(), 1);
      assert.equal(endReason(study), null);
      at(61);
      assert.equal((await login()).status, 401); // the old password no longer works
      assert.equal((await login({ password: 'a brand new one', takeover: true })).status, 200);
    });
  });

  describe('common passwords', () => {
    it('a new password on change must not be common; a passphrase is fine', async () => {
      await start();
      const { token } = (await signup()).body;
      for (const next of ['password', 'Password1', '12345678']) {
        const res = await api('POST', '/api/auth/password', { token, body: { current: PASSWORD, next } });
        assert.equal(res.status, 400, next);
        assert.equal(res.body.error.code, 'password_too_common', next);
        assert.equal(res.body.error.message, 'That password is too common. Try a longer phrase.');
      }
      assert.equal((await api('POST', '/api/auth/password', { token, body: { current: PASSWORD, next: 'blue-river-lamp-42' } })).status, 200);
    });

    it('login is not blocked: an account that already has a weak password still signs in', async () => {
      await start();
      await signup();
      t.db.prepare('UPDATE accounts SET password_hash = ?').run(await hashPassword('password'));
      assert.equal((await login({ password: 'password', takeover: true })).status, 200);
    });
  });

  describe('session timeout setting', () => {
    it('PUT /api/settings writes an admin_events row; 20 seconds is 400', async () => {
      await start();
      const ok = await t.call('PUT', '/api/settings', { pin: TEST_PIN, body: { session_timeout_seconds: 45 } });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.session_timeout_seconds, 45);
      assert.equal(ok.body.allow_signups, true);
      const rows = t.db.prepare("SELECT detail FROM admin_events WHERE type = 'setting_changed' AND detail LIKE 'session_timeout_seconds=%'").all();
      assert.deepEqual(rows.map((r) => r.detail), ['session_timeout_seconds=45']);

      for (const bad of [20, 1801, 45.5]) {
        assert.equal((await t.call('PUT', '/api/settings', { pin: TEST_PIN, body: { session_timeout_seconds: bad } })).status, 400, String(bad));
      }
      assert.equal((await t.call('GET', '/api/settings', { pin: TEST_PIN })).body.session_timeout_seconds, 45);
    });

    it('a stored value outside 30 to 1800 falls back to 60', async () => {
      await start();
      t.db.prepare("INSERT INTO settings (key, value) VALUES ('session_timeout_seconds', '5')").run();
      assert.equal((await t.call('GET', '/api/settings', { pin: TEST_PIN })).body.session_timeout_seconds, 60);
    });
  });
});
