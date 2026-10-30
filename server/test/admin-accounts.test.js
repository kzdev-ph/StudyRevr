import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { startStudyApp, TEST_PIN } from './helpers.js';

const START = '2026-10-05T04:00:00.000Z';
const PASSWORD = 'correct horse battery';

describe('admin accounts', () => {
  let t;
  afterEach(() => t?.close());

  // t.call signs in through tokenFor; the sign-in flow is tested with the tokens the routes themselves hand out
  const api = async (method, path, { token, body, pin } = {}) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (pin) headers['x-admin-pin'] = pin;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await globalThis.fetch(`${t.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, text, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null };
  };
  const admin = (method, path, body) => api(method, path, { pin: TEST_PIN, body });
  const signup = (email = 'ana@example.com') => api('POST', '/api/auth/signup', { body: { email, password: PASSWORD } });
  const login = (email, password) => api('POST', '/api/auth/login', { body: { email, password } });
  const stats = (token) => api('GET', '/api/stats', { token });
  const startStudy = (token) => api('POST', '/api/sessions', { token, body: { lesson_id: null, activity: 'reading' } });
  const events = () => t.db.prepare('SELECT type, detail FROM admin_events ORDER BY id').all();
  const lockState = () => t.db.prepare('SELECT failed_logins, lockouts, locked_until FROM accounts').get();

  const start = async () => {
    t = await startStudyApp({ now: START });
  };

  it('every account route needs the PIN', async () => {
    await start();
    await signup();
    for (const [method, path, body] of [
      ['GET', '/api/admin/accounts'],
      ['POST', '/api/admin/accounts/P01/reset-password', {}],
      ['POST', '/api/admin/accounts/P01/sign-out', {}],
      ['PUT', '/api/admin/accounts/test-login', { email: 'me@example.com', password: PASSWORD }],
    ]) {
      for (const pin of [undefined, 'wrong-pin']) {
        t.now = new Date(Date.parse(t.now) + 2 * 60_000).toISOString(); // past any PIN lockout
        const res = await api(method, path, { pin, body });
        assert.equal(res.status, 401, `${method} ${path} pin=${pin}`);
      }
    }
    assert.equal(events().length, 0);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL').get().n, 1, 'nobody was signed out');
  });

  it('lists each account with its email and study ID, and who is signed in', async () => {
    await start();
    await signup('ana@example.com');
    await signup('ben@example.com');
    await admin('POST', '/api/admin/accounts/P02/sign-out');
    const list = await admin('GET', '/api/admin/accounts');
    assert.equal(list.status, 200);
    assert.equal(list.body.timeout_s, 60);
    assert.deepEqual(
      list.body.accounts.map((a) => [a.code, a.email, a.test, a.signed_in]),
      [
        ['P01', 'ana@example.com', false, true],
        ['P02', 'ben@example.com', false, false],
      ],
    );
    assert.equal(list.body.accounts[0].active_now, true);
    assert.equal(list.body.accounts[0].must_change_password, false);
    assert.equal(list.body.accounts[0].locked_until, null);
    assert.ok(!list.text.includes('password_hash'));
    // silent for longer than the timeout: still signed in, no longer active now
    t.now = new Date(Date.parse(START) + 120_000).toISOString();
    const later = await admin('GET', '/api/admin/accounts');
    assert.deepEqual([later.body.accounts[0].signed_in, later.body.accounts[0].active_now], [true, false]);
  });

  it('the account list and a temporary password are never cached', async () => {
    await start();
    await signup();
    const list = await globalThis.fetch(`${t.base}/api/admin/accounts`, { headers: { 'x-admin-pin': TEST_PIN } });
    assert.equal(list.status, 200);
    assert.equal(list.headers.get('cache-control'), 'no-store');
    const reset = await globalThis.fetch(`${t.base}/api/admin/accounts/P01/reset-password`, { method: 'POST', headers: { 'x-admin-pin': TEST_PIN } });
    assert.equal(reset.status, 200);
    assert.equal(reset.headers.get('cache-control'), 'no-store');
  });

  it('reset password: the old token stops, the temporary password works once and forces a change', async () => {
    await start();
    const old = (await signup()).body.token;
    assert.equal((await stats(old)).status, 200);

    const reset = await admin('POST', '/api/admin/accounts/P01/reset-password');
    assert.equal(reset.status, 200);
    assert.equal(reset.body.temporary_password.length, 10);
    const temporary = reset.body.temporary_password;

    const dead = await stats(old);
    assert.equal(dead.status, 401);
    assert.equal(dead.body.error.code, 'password_reset');

    // the old password no longer works; the temporary one signs in but cannot reach study routes yet
    assert.equal((await login('ana@example.com', PASSWORD)).status, 401);
    const temp = await login('ana@example.com', temporary);
    assert.equal(temp.status, 200);
    assert.equal(temp.body.account.must_change_password, true);
    const blocked = await stats(temp.body.token);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'password_change_required');

    const changed = await api('POST', '/api/auth/password', { token: temp.body.token, body: { current: temporary, next: 'a brand new password' } });
    assert.equal(changed.status, 200);
    assert.equal((await stats(changed.body.token)).status, 200);
    // a one-off: once changed, the temporary password no longer signs in
    assert.equal((await login('ana@example.com', temporary)).status, 401);

    // logged by study ID only; the password is neither stored nor logged
    assert.deepEqual(events(), [{ type: 'password_reset', detail: 'P01' }]);
    const stored = JSON.stringify(t.db.prepare('SELECT * FROM admin_events').all()) + JSON.stringify(t.db.prepare('SELECT * FROM settings').all());
    assert.ok(!stored.includes(temporary));
  });

  it('reset password and sign out clear failed attempts and a lockout', async () => {
    await start();
    await signup();
    for (let i = 0; i < 5; i += 1) await login('ana@example.com', 'not the password');
    assert.equal((await login('ana@example.com', PASSWORD)).status, 429);
    const locked = await admin('GET', '/api/admin/accounts');
    assert.ok(locked.body.accounts[0].locked_until);
    assert.equal(lockState().lockouts, 1);

    assert.equal((await admin('POST', '/api/admin/accounts/P01/sign-out')).status, 200);
    assert.deepEqual(lockState(), { failed_logins: 0, lockouts: 0, locked_until: null });
    assert.equal((await login('ana@example.com', PASSWORD)).status, 200);

    // 4 wrong passwords, then a lockout from a second round
    for (let i = 0; i < 5; i += 1) await login('ana@example.com', 'not the password');
    t.db.prepare('UPDATE accounts SET failed_logins = 3').run();
    const reset = await admin('POST', '/api/admin/accounts/P01/reset-password');
    assert.deepEqual(lockState(), { failed_logins: 0, lockouts: 0, locked_until: null });
    assert.equal((await login('ana@example.com', reset.body.temporary_password)).status, 200);
  });

  it('sign out: the study session ends signed_out_by_admin and the token says so', async () => {
    await start();
    const token = (await signup()).body.token;
    assert.equal((await startStudy(token)).status, 201);
    const res = await admin('POST', '/api/admin/accounts/p01/sign-out');
    assert.deepEqual(res.body, { signed_out: 1 });
    const after = await stats(token);
    assert.equal(after.status, 401);
    assert.equal(after.body.error.code, 'signed_out_by_admin');
    assert.equal(t.db.prepare('SELECT end_reason FROM study_sessions').get().end_reason, 'signed_out_by_admin');
    assert.deepEqual((await admin('POST', '/api/admin/accounts/P01/sign-out')).body, { signed_out: 0 });
    assert.deepEqual(events().map((e) => e.type), ['signed_out_by_admin', 'signed_out_by_admin']);
  });

  it('an unknown study ID is 404', async () => {
    await start();
    for (const action of ['reset-password', 'sign-out']) {
      const res = await admin('POST', `/api/admin/accounts/P77/${action}`);
      assert.equal(res.status, 404);
      assert.equal(res.body.error.message, 'No account with that study ID.');
    }
    assert.equal(events().length, 0);
  });

  it('the P00 test login: set by admin, signs in, replaced later, its records stay out of the export', async () => {
    await start();
    await signup('ana@example.com');
    assert.equal((await admin('PUT', '/api/admin/accounts/test-login', { email: 'nope', password: PASSWORD })).status, 400);
    assert.equal((await admin('PUT', '/api/admin/accounts/test-login', { email: 'tester@example.com', password: 'short' })).status, 400);
    assert.equal((await admin('PUT', '/api/admin/accounts/test-login', { email: 'ana@example.com', password: PASSWORD })).status, 409);

    assert.equal((await admin('PUT', '/api/admin/accounts/test-login', { email: ' Tester@Example.com ', password: PASSWORD })).status, 200);
    const first = await login('tester@example.com', PASSWORD);
    assert.equal(first.status, 200);
    assert.equal((await stats(first.body.token)).status, 200);
    const listed = (await admin('GET', '/api/admin/accounts')).body.accounts.find((a) => a.test);
    assert.deepEqual([listed.code, listed.email, listed.signed_in], ['P00', 'tester@example.com', true]);

    // replacing it signs the old login out and the new password works
    assert.equal((await admin('PUT', '/api/admin/accounts/test-login', { email: 'tester@example.com', password: 'another password 1' })).status, 200);
    assert.equal((await stats(first.body.token)).status, 401);
    assert.equal((await login('tester@example.com', PASSWORD)).status, 401);
    const second = await login('tester@example.com', 'another password 1');
    assert.equal(second.status, 200);
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM accounts a JOIN participants p ON p.id = a.participant_id WHERE p.code = 'P00'").get().n, 1);
    assert.deepEqual(events().map((e) => e.type), ['test_login_set', 'test_login_set']);
    assert.ok(!JSON.stringify(events()).includes('another password'));

    // P00's study records are left out of the export unless asked for
    assert.equal((await startStudy(second.body.token)).status, 201);
    const sessions = (q) => admin('GET', `/api/admin/export/sessions.csv${q}`).then((r) => r.text);
    assert.doesNotMatch(await sessions(''), /P00/);
    assert.match(await sessions('?include_p00=1'), /P00/);
  });

  it('emails are only in the account list: never in the export or in what a student gets back', async () => {
    await start();
    const token = (await signup('ana@example.com')).body.token;
    await admin('PUT', '/api/admin/accounts/test-login', { email: 'tester@example.com', password: PASSWORD });
    await startStudy(token);
    const texts = [];
    for (const file of ['summary', 'sessions', 'flashcard_reviews', 'due_reviews', 'quiz_attempts', 'quiz_answers', 'events', 'lesson_events', 'setting_events', 'ai_calls', 'lessons']) {
      const res = await admin('GET', `/api/admin/export/${file}.csv?include_p00=1`);
      assert.equal(res.status, 200, file);
      texts.push(res.text);
    }
    const zip = await globalThis.fetch(`${t.base}/api/admin/export.zip?include_p00=1`, { headers: { 'x-admin-pin': TEST_PIN } });
    assert.equal(zip.status, 200);
    // unzip first: the entries are compressed, so the raw bytes would not show an email even if one were in there
    const archive = await JSZip.loadAsync(Buffer.from(await zip.arrayBuffer()));
    const entries = Object.values(archive.files).filter((f) => !f.dir);
    assert.ok(entries.some((f) => f.name.endsWith('.csv')), 'the archive has CSV files');
    for (const entry of entries) texts.push(await entry.async('string'));
    texts.push((await admin('GET', '/api/admin/participants')).text);
    texts.push((await admin('GET', '/api/admin/participants/P01/stats')).text);
    const mine = await stats(token);
    texts.push(mine.text);
    for (const text of texts) assert.doesNotMatch(text, /@example\.com|@test\.invalid/);
    assert.doesNotMatch(mine.text, /P\d/); // and the student's own answers carry no study ID
    assert.match((await admin('GET', '/api/admin/accounts')).text, /ana@example\.com/);
  });
});
