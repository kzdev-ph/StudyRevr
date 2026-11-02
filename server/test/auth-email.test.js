import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http, { ServerResponse } from 'node:http';
import os from 'node:os';
import { fakeMailer, linkToken, startStudyApp, TEST_PIN } from './helpers.js';

const START = '2026-10-05T04:00:00.000Z';
const BASE = 'https://study.example.test';
const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'purple tractor sunrise';
const EMAIL = 'ana@example.com';
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const JUNK = 'x'.repeat(43); // the right shape, never issued
const LINK_INVALID = 'link_invalid';

// Sign-up, sign-in, verify, resend, forgot and reset with email on. No real mail: fakeMailer keeps each message.
describe('auth by email', () => {
  let t;
  let mailer;
  afterEach(() => t?.close());

  const start = async ({ mail = fakeMailer(), ...rest } = {}) => {
    mailer = mail;
    t = await startStudyApp({ now: START, mailer: mail, publicUrl: BASE, ...rest });
  };
  const at = (ms) => (t.now = new Date(Date.parse(START) + ms).toISOString());

  const api = async (method, path, { token, body, headers: extra } = {}) => {
    const headers = { ...extra };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await globalThis.fetch(`${t.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, text, body: text ? JSON.parse(text) : null };
  };
  const signup = (email = EMAIL, password = PASSWORD) => api('POST', '/api/auth/signup', { body: { email, password } });
  const login = (password = PASSWORD, email = EMAIL) => api('POST', '/api/auth/login', { body: { email, password } });
  const verify = (token) => api('POST', '/api/auth/verify', { body: { token } });
  const resend = (email = EMAIL, headers) => api('POST', '/api/auth/verify/resend', { body: { email }, headers });
  const forgot = (email = EMAIL, headers) => api('POST', '/api/auth/forgot', { body: { email }, headers });
  const check = (token) => api('POST', '/api/auth/reset/check', { body: { token } });
  const reset = (token, password = NEW_PASSWORD) => api('POST', '/api/auth/reset', { body: { token, password } });
  const stats = (token) => api('GET', '/api/stats', { token });
  const startStudy = (token) => api('POST', '/api/sessions', { token, body: { lesson_id: null, activity: 'reading' } });
  const account = () => t.db.prepare('SELECT email_verified, must_change_password, failed_logins, lockouts, locked_until FROM accounts').get();
  const tokens = () => JSON.stringify(t.db.prepare('SELECT token_hash FROM email_tokens ORDER BY id').all());
  const liveLogins =() => t.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL').get().n;

  // forgot and resend do not wait for the mail: look until the message is kept
  const mailArrived = async (count) => {
    for (let i = 0; i < 100 && mailer.sent.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(mailer.sent.length, count);
  };
  // when nothing should be sent: give a stray send the same chance to show up
  const nothingMore = async (count) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(mailer.sent.length, count);
  };
  const assertLinkInvalid = (res) => {
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, LINK_INVALID);
  };

  // sign up (one mail) and open its link
  const verifiedAccount = async () => {
    assert.equal((await signup()).status, 201);
    assert.equal((await verify(linkToken(mailer, 'verify'))).status, 200);
  };
  // asks for a reset link and returns its token
  const resetToken = async () => {
    const before = mailer.sent.length;
    assert.equal((await forgot()).status, 202);
    await mailArrived(before + 1);
    return linkToken(mailer, 'reset');
  };

  describe('sign up with email on', () => {
    it('answers 201 verify_email, opens no session, and emails one link', async () => {
      await start();
      const res = await signup();
      assert.equal(res.status, 201);
      assert.deepEqual(res.body, { verify_email: true, email_sent: true });
      assert.equal('token' in res.body, false);
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, 0);
      assert.equal(account().email_verified, 0);

      assert.equal(mailer.sent.length, 1);
      const [mail] = mailer.sent;
      assert.equal(mail.to, EMAIL);
      assert.ok(linkToken(mailer, 'verify'));
      assert.match(mail.text, new RegExp(`${BASE}/#/verify/[A-Za-z0-9_-]{43}`));
      // no study ID anywhere in the mail apart from the link (a random token could hold "P01" by chance)
      const outsideLink = `${mail.subject}\n${mail.text}`.replace(/\S*\/#\/verify\/\S+/, '');
      assert.doesNotMatch(outsideLink, /P\d/);
    });

    it('stores the link only as a hash', async () => {
      await start();
      await signup();
      const token = linkToken(mailer, 'verify');
      assert.ok(!JSON.stringify(t.db.prepare('SELECT * FROM email_tokens').all()).includes(token));
    });

    it('a failing mail server still makes the account and says email_sent false', async () => {
      await start({ mail: fakeMailer({ fail: true }) });
      const res = await signup();
      assert.equal(res.status, 201);
      assert.deepEqual(res.body, { verify_email: true, email_sent: false });
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 1);
      assert.equal(account().email_verified, 0);
    });
  });

  describe('sign in before verifying', () => {
    it('the right password is 403 email_unverified with no session; a wrong one is 401 login_failed', async () => {
      await start();
      await signup();
      const right = await login();
      assert.equal(right.status, 403);
      assert.equal(right.body.error.code, 'email_unverified');
      assert.equal('token' in right.body, false);
      const wrong = await login('not the password');
      assert.equal(wrong.status, 401);
      assert.equal(wrong.body.error.code, 'login_failed');
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, 0);
    });
  });

  describe('verify', () => {
    it('opens the account: 200, then sign-in works', async () => {
      await start();
      await signup();
      const res = await verify(linkToken(mailer, 'verify'));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
      assert.equal(account().email_verified, 1);
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, 0, 'verifying signs nobody in');
      const signedIn = await login();
      assert.equal(signedIn.status, 200);
      assert.ok(signedIn.body.token);
    });

    it('a used, unknown, malformed or 24 h old link all give the identical 400 link_invalid', async () => {
      await start();
      await signup();
      const token = linkToken(mailer, 'verify');
      assert.equal((await verify(token)).status, 200);
      const used = await verify(token);
      const unknown = await verify(JUNK);
      const malformed = await verify('not-a-token');
      const missing = await api('POST', '/api/auth/verify', { body: {} });

      await signup('ben@example.com');
      const old = linkToken(mailer, 'verify');
      at(24 * HOUR + SECOND);
      const expired = await verify(old);

      for (const res of [used, unknown, malformed, missing, expired]) assertLinkInvalid(res);
      for (const res of [unknown, malformed, missing, expired]) assert.deepEqual(res.body, used.body);
      assert.equal(t.db.prepare("SELECT email_verified FROM accounts WHERE email = 'ben@example.com'").get().email_verified, 0);
    });

    it('a reset link is not accepted as a verify link', async () => {
      await start();
      await signup();
      const token = await resetToken();
      assertLinkInvalid(await verify(token));
      assert.equal(account().email_verified, 0);
    });
  });

  describe('resend', () => {
    it('answers the identical 202 for an unknown, a verified and an unverified email; only the unverified gets mail', async () => {
      await start();
      await signup('ben@example.com');
      await verify(linkToken(mailer, 'verify')); // ben is verified
      await signup('cara@example.com'); // cara is not
      assert.equal(mailer.sent.length, 2);

      const unknown = await resend('nobody@example.com');
      const verified = await resend('ben@example.com');
      await nothingMore(2);
      const unverified = await resend('cara@example.com');
      await mailArrived(3);

      for (const res of [unknown, verified, unverified]) {
        assert.equal(res.status, 202);
        assert.deepEqual(res.body, { ok: true });
        assert.equal(res.text, unknown.text);
      }
      assert.equal(mailer.sent.at(-1).to, 'cara@example.com');
      assert.equal(mailer.sent.filter((m) => m.to === 'nobody@example.com' || m.to === 'ben@example.com').length, 1, "only ben's first sign-up mail");
    });

    it('a newer link makes the older one 400', async () => {
      await start();
      await signup();
      const older = linkToken(mailer, 'verify');
      assert.equal((await resend()).status, 202);
      await mailArrived(2);
      const newer = linkToken(mailer, 'verify');
      assert.notEqual(newer, older);
      assertLinkInvalid(await verify(older));
      assert.equal((await verify(newer)).status, 200);
    });

    // The sign-up mail counts as the first of 3 per account per 15 minutes (routes/auth.js), so the 3rd and later
    // resends send nothing while still answering 202.
    it('after 3 emails in 15 minutes (the sign-up mail counts) sends nothing more but still answers 202', async () => {
      await start();
      await signup();
      for (const expected of [2, 3]) {
        assert.equal((await resend()).status, 202);
        await mailArrived(expected);
      }
      for (let i = 0; i < 2; i++) {
        const res = await resend();
        assert.equal(res.status, 202);
        assert.deepEqual(res.body, { ok: true });
      }
      await nothingMore(3);
      // the window slides: later it sends again
      at(15 * MINUTE + SECOND);
      assert.equal((await resend()).status, 202);
      await mailArrived(4);
    });

    it('the 11th request from one IP in 15 minutes is 429; another client IP has its own bucket', async () => {
      await start();
      for (let i = 0; i < 10; i++) assert.equal((await resend(`nobody${i}@example.com`)).status, 202, `request ${i + 1}`);
      const limited = await resend('nobody10@example.com');
      assert.equal(limited.status, 429);
      assert.equal(limited.body.error.code, 'email_rate_limited');
      // the request comes from 127.0.0.1 (a trusted proxy), so X-Forwarded-For names the real client
      const other = await resend('nobody11@example.com', { 'x-forwarded-for': '203.0.113.9' });
      assert.equal(other.status, 202);
      // forgot shares the same per-IP bucket
      assert.equal((await forgot('nobody12@example.com')).status, 429);
      assert.equal((await forgot('nobody12@example.com', { 'x-forwarded-for': '203.0.113.9' })).status, 202);
    });

    it('a bad email is 400', async () => {
      await start();
      assert.equal((await resend('not an email')).status, 400);
      assert.equal((await api('POST', '/api/auth/verify/resend', { body: {} })).status, 400);
    });
  });

  describe('email off (no mailer)', () => {
    it('sign-up answers token and account, the account is verified, and forgot and resend are 503 email_off', async () => {
      t = await startStudyApp({ now: START }); // no mailer: createApp builds the real one, which sends nothing without SMTP settings
      const res = await signup();
      assert.equal(res.status, 201);
      assert.deepEqual(res.body.account, { email: EMAIL, must_change_password: false });
      assert.ok(res.body.token);
      assert.equal('verify_email' in res.body, false);
      assert.equal(account().email_verified, 1);
      assert.equal((await stats(res.body.token)).status, 200);
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM email_tokens').get().n, 0);

      for (const call of [() => forgot(), () => resend()]) {
        const off = await call();
        assert.equal(off.status, 503);
        assert.equal(off.body.error.code, 'email_off');
      }
      // sign-up opened a live login, so a second device is asked first (409), and may take over
      assert.equal((await login()).body.error.code, 'active_elsewhere');
      assert.equal((await api('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD, takeover: true } })).status, 200);
    });
  });

  describe('forgot password', () => {
    it('answers the same status and body for a known and an unknown email; only the known gets a /#/reset/ link', async () => {
      await start();
      await verifiedAccount();
      assert.equal(mailer.sent.length, 1);
      const known = await forgot();
      const unknown = await forgot('nobody@example.com');
      await mailArrived(2);
      await nothingMore(2);

      assert.equal(known.status, 202);
      assert.deepEqual(known.body, { ok: true });
      assert.equal(unknown.status, known.status);
      assert.equal(unknown.text, known.text);
      const mail = mailer.sent.at(-1);
      assert.equal(mail.to, EMAIL);
      assert.match(mail.text, new RegExp(`${BASE}/#/reset/[A-Za-z0-9_-]{43}`));
      assert.ok(!mailer.sent.some((m) => m.to === 'nobody@example.com'));
    });

    it('a bad email is 400', async () => {
      await start();
      assert.equal((await forgot('nope')).status, 400);
    });
  });

  describe('reset check', () => {
    it('gives the email for a live link and does not use it up', async () => {
      await start();
      await verifiedAccount();
      const token = await resetToken();
      for (let i = 0; i < 2; i++) {
        const res = await check(token);
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { email: EMAIL });
      }
    });

    it('is 400 link_invalid for junk, after 30 minutes and a second, and after the link was used', async () => {
      await start();
      await verifiedAccount();
      const expiring = await resetToken();
      at(30 * MINUTE - SECOND);
      assert.equal((await check(expiring)).status, 200, 'still live just under 30 minutes');
      at(30 * MINUTE + SECOND);
      const expired = await check(expiring);
      assertLinkInvalid(expired);

      const used = await resetToken();
      assert.equal((await reset(used)).status, 200);
      const afterUse = await check(used);
      assertLinkInvalid(afterUse);

      for (const junk of [JUNK, 'not-a-token', '', 123, null]) {
        const res = await check(junk);
        assertLinkInvalid(res);
        assert.deepEqual(res.body, expired.body);
      }
      assert.deepEqual(afterUse.body, expired.body);
      assertLinkInvalid(await api('POST', '/api/auth/reset/check', { body: {} }));
    });

    it('a verify link is not a reset link', async () => {
      await start();
      await signup();
      assertLinkInvalid(await check(linkToken(mailer, 'verify')));
    });
  });

  describe('reset', () => {
    it('a short or a common password is 400 and leaves the link usable; then it works', async () => {
      await start();
      await verifiedAccount();
      const token = await resetToken();

      const short = await reset(token, 'short');
      assert.equal(short.status, 400);
      const common = await reset(token, 'password123');
      assert.equal(common.status, 400);
      assert.equal(common.body.error.code, 'password_too_common');
      assert.equal((await check(token)).status, 200, 'the link is still live');
      assert.equal((await login(PASSWORD)).status, 200, 'the password has not changed');

      assert.equal((await reset(token)).status, 200);
    });

    it('a bad link is told so before the password is looked at', async () => {
      await start();
      assertLinkInvalid(await reset(JUNK, 'short'));
      assertLinkInvalid(await api('POST', '/api/auth/reset', { body: { password: NEW_PASSWORD } }));
    });

    it('the old password is 401 and the new one signs in', async () => {
      await start();
      await verifiedAccount();
      const res = await reset(await resetToken());
      assert.deepEqual(res.body, { ok: true });
      const old = await login(PASSWORD);
      assert.equal(old.status, 401);
      assert.equal(old.body.error.code, 'login_failed');
      assert.equal((await login(NEW_PASSWORD)).status, 200);
    });

    it('a second use of the link is 400 link_invalid', async () => {
      await start();
      await verifiedAccount();
      const token = await resetToken();
      assert.equal((await reset(token)).status, 200);
      assertLinkInvalid(await reset(token, 'another long phrase here'));
      assert.equal((await login(NEW_PASSWORD)).status, 200, 'the second try changed nothing');
    });

    it('a newer reset link makes the older one 400', async () => {
      await start();
      await verifiedAccount();
      const older = await resetToken();
      const newer = await resetToken();
      assert.notEqual(older, newer);
      assertLinkInvalid(await reset(older));
      assert.equal((await reset(newer)).status, 200);
    });

    it('unlocks a locked account', async () => {
      await start();
      await verifiedAccount();
      for (let i = 0; i < 5; i += 1) await login('not the password');
      assert.equal((await login(PASSWORD)).status, 429);
      assert.ok(account().locked_until);

      assert.equal((await reset(await resetToken())).status, 200);
      assert.deepEqual([account().failed_logins, account().lockouts, account().locked_until], [0, 0, null]);
      assert.equal((await login(NEW_PASSWORD)).status, 200);
    });

    it('clears must_change_password', async () => {
      await start();
      await verifiedAccount();
      t.db.prepare('UPDATE accounts SET must_change_password = 1').run();
      assert.equal((await reset(await resetToken())).status, 200);
      assert.equal(account().must_change_password, 0);
      const signedIn = await login(NEW_PASSWORD);
      assert.equal(signedIn.body.account.must_change_password, false);
      assert.equal((await stats(signedIn.body.token)).status, 200);
    });

    it('ends the previous login: its token is 401 password_reset and its study session is signed_out', async () => {
      await start();
      await verifiedAccount();
      const old = (await login()).body.token;
      const study = await startStudy(old);
      assert.equal(study.status, 201);
      const sessionId = t.db.prepare('SELECT id FROM study_sessions').get().id;
      assert.equal(t.db.prepare('SELECT end_reason FROM study_sessions WHERE id = ?').get(sessionId).end_reason, null);

      assert.equal((await reset(await resetToken())).status, 200);
      const dead = await stats(old);
      assert.equal(dead.status, 401);
      assert.equal(dead.body.error.code, 'password_reset');
      assert.equal(t.db.prepare('SELECT end_reason FROM study_sessions WHERE id = ?').get(sessionId).end_reason, 'signed_out');
      assert.equal(liveLogins(), 0);
    });

    it('an unverified account becomes verified, and no verify link is left', async () => {
      await start();
      await signup();
      assert.equal(account().email_verified, 0);
      assert.equal((await login()).status, 403);
      assert.equal((await reset(await resetToken())).status, 200);
      assert.equal(account().email_verified, 1);
      assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM email_tokens WHERE purpose = 'verify'").get().n, 0);
      assert.equal((await login(NEW_PASSWORD)).status, 200);
    });

    it('does not touch another account', async () => {
      await start();
      await verifiedAccount();
      await signup('ben@example.com');
      await verify(linkToken(mailer, 'verify'));
      assert.equal((await reset(await resetToken())).status, 200);
      assert.equal((await login(PASSWORD, 'ben@example.com')).status, 200);
    });
  });

  describe('the answer goes out before any mail work', () => {
    // What the mailer and the token table hold at the moment the server finishes answering `path`. The client cannot see
    // this itself: setImmediate has already run by the time it reads the reply.
    const whenAnswered = async (path, call) => {
      const seen = [];
      const original = ServerResponse.prototype.end;
      ServerResponse.prototype.end = function end(...args) {
        if (this.req?.originalUrl === path) seen.push({ mails: mailer.sent.length, tokens: tokens() });
        return original.apply(this, args);
      };
      try {
        await call();
      } finally {
        ServerResponse.prototype.end = original;
      }
      return seen;
    };

    it('forgot: for a known email no mail is sent and no token is written until after the 202', async () => {
      await start();
      await verifiedAccount();
      const before = { mails: mailer.sent.length, tokens: tokens() };
      let res;
      const seen = await whenAnswered('/api/auth/forgot', async () => { res = await forgot(); });
      assert.equal(res.status, 202);
      assert.deepEqual(seen, [before]);
      await mailArrived(before.mails + 1);
      assert.notEqual(tokens(), before.tokens, 'the token was written afterwards');
    });

    it('resend: for a known unverified email no mail is sent and no token is written until after the 202', async () => {
      await start();
      await signup();
      const before = { mails: mailer.sent.length, tokens: tokens() };
      let res;
      const seen = await whenAnswered('/api/auth/verify/resend', async () => { res = await resend(); });
      assert.equal(res.status, 202);
      assert.deepEqual(seen, [before]);
      await mailArrived(before.mails + 1);
      assert.notEqual(tokens(), before.tokens, 'the token was written afterwards');
    });
  });

  describe('an emailed reset link dies when the password changes another way', () => {
    it('changing the password while signed in', async () => {
      await start();
      await verifiedAccount();
      const link = await resetToken();
      const signedIn = (await login()).body.token;
      const changed = await api('POST', '/api/auth/password', { token: signedIn, body: { current: PASSWORD, next: NEW_PASSWORD } });
      assert.equal(changed.status, 200);
      assertLinkInvalid(await check(link));
      assertLinkInvalid(await reset(link, 'another long phrase here'));
      assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM email_tokens WHERE purpose = 'reset'").get().n, 0);
      const again = await api('POST', '/api/auth/login', { body: { email: EMAIL, password: NEW_PASSWORD, takeover: true } });
      assert.equal(again.status, 200, 'the password is the one that was chosen');
    });
  });

  describe('email off lets an unverified account in', () => {
    it('an account with email_verified = 0 signs in and uses the API when no mail server is set up', async () => {
      t = await startStudyApp({ now: START });
      await signup();
      t.db.prepare('UPDATE accounts SET email_verified = 0').run();
      const res = await api('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD, takeover: true } });
      assert.equal(res.status, 200);
      assert.equal((await stats(res.body.token)).status, 200);
      assert.equal((await startStudy(res.body.token)).status, 201);
    });

    it('with email on the same account is still refused at sign-in and on the API', async () => {
      await start();
      await verifiedAccount();
      const token = (await login()).body.token;
      t.db.prepare('UPDATE accounts SET email_verified = 0').run();
      assert.equal((await login()).body.error.code, 'email_unverified');
      const blocked = await stats(token);
      assert.equal(blocked.status, 403);
      assert.equal(blocked.body.error.code, 'email_unverified');
    });
  });

  describe('health', () => {
    it('says whether email is set up, as a boolean', async () => {
      await start();
      assert.deepEqual((await api('GET', '/api/health')).body, { ok: true, admin: true, email: true });
      await t.close();
      t = await startStudyApp({ now: START });
      assert.deepEqual((await api('GET', '/api/health')).body, { ok: true, admin: true, email: false });
    });
  });

  describe('limits on who can trigger mail', () => {
    const resendAsAdmin = () => api('POST', '/api/admin/accounts/P01/resend-verification', { headers: { 'x-admin-pin': TEST_PIN } });

    it('no more than 60 emails an hour across the server; one log line per refusal; it frees up after an hour', async () => {
      await start();
      await signup(); // 1 mail, and it counts
      const warnings = [];
      const warn = console.warn;
      console.warn = (line) => warnings.push(line);
      try {
        for (let i = 2; i <= 60; i++) assert.equal((await resendAsAdmin()).body.sent, true, `mail ${i}`);
        assert.equal(mailer.sent.length, 60);
        assert.deepEqual(warnings, []);
        const tokensBefore = tokens();

        assert.equal((await resendAsAdmin()).body.sent, false);
        assert.deepEqual(warnings, ['[mail] hourly send cap reached']);
        // forgot and the sign-up mail are under the same cap
        assert.equal((await forgot()).status, 202);
        assert.equal((await signup('ben@example.com')).body.email_sent, false);
        await nothingMore(60);
        assert.equal(tokens(), tokensBefore, 'no token is written when over the cap');

        at(HOUR + SECOND);
        assert.equal((await resendAsAdmin()).body.sent, true);
        assert.equal(mailer.sent.length, 61);
      } finally {
        console.warn = warn;
      }
    });

    it('an IPv6 client is limited by its /64: other addresses in it share the bucket, another /64 does not', async () => {
      await start();
      for (let i = 0; i < 10; i++) {
        assert.equal((await resend(`nobody${i}@example.com`, { 'x-forwarded-for': `2001:db8:1:2:${i}::${i + 1}` })).status, 202, `request ${i + 1}`);
      }
      const same = await resend('nobody10@example.com', { 'x-forwarded-for': '2001:db8:1:2:ffff:eeee:dddd:cccc' });
      assert.equal(same.status, 429);
      assert.equal((await resend('nobody11@example.com', { 'x-forwarded-for': '2001:db8:1:3::1' })).status, 202);
      // an IPv4 address is still its own bucket
      assert.equal((await resend('nobody12@example.com', { 'x-forwarded-for': '203.0.113.9' })).status, 202);
    });
  });

  describe('X-Forwarded-For', () => {
    it('is believed only from a loopback connection (the tunnel)', async () => {
      await start();
      const trusted = t.app.get('trust proxy fn');
      for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(trusted(ip, 0), true, ip);
      for (const ip of ['203.0.113.5', '192.168.1.20', '10.0.0.4', '2001:db8::1']) assert.equal(trusted(ip, 0), false, ip);
    });

    it('a direct (non-loopback) client cannot dodge the limiter by sending its own X-Forwarded-For', async (ctx) => {
      await start();
      const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal);
      if (!lan) return ctx.skip('no non-loopback address on this computer');
      const server = await new Promise((resolve) => { const s = t.app.listen(0, '0.0.0.0', () => resolve(s)); });
      try {
        // node:http, not fetch: setup.js blocks fetch to anything but 127.0.0.1, and this is this computer's own address
        const direct = (email, ip) => new Promise((resolve, reject) => {
          const req = http.request(
            { host: lan.address, port: server.address().port, path: '/api/auth/verify/resend', method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip } },
            (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); },
          );
          req.on('error', reject);
          req.end(JSON.stringify({ email }));
        });
        for (let i = 0; i < 10; i++) assert.equal((await direct(`nobody${i}@example.com`, `198.51.100.${i + 1}`)).status, 202, `request ${i + 1}`);
        assert.equal((await direct('nobody10@example.com', '198.51.100.99')).status, 429, 'a new made-up address did not give a new bucket');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});
