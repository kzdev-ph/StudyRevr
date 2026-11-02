import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fakeMailer, linkToken, startStudyApp } from './helpers.js';

const OLD = 'correct horse battery';
const NEW = 'purple tractor sunrise';

// A short end-to-end pass over sign-up, verify, forgot password and reset. No real mail: fakeMailer keeps each message.
describe('reset by email (smoke)', () => {
  let t;
  afterEach(() => t?.close());

  const api = async (method, path, body) => {
    const res = await globalThis.fetch(`${t.base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const login = (password) => api('POST', '/api/auth/login', { email: 'ana@example.com', password });
  // /auth/forgot does not wait for the mail: look until the message is kept
  const mailArrived = async (mailer, count) => {
    for (let i = 0; i < 100 && mailer.sent.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(mailer.sent.length, count);
  };

  it('signs up, verifies, resets with the emailed link, and the link works once', async () => {
    const mailer = fakeMailer();
    t = await startStudyApp({ mailer, publicUrl: 'https://study.example' });

    const signup = await api('POST', '/api/auth/signup', { email: 'ana@example.com', password: OLD });
    assert.equal(signup.status, 201);
    assert.equal(signup.body.verify_email, true);
    assert.equal((await api('POST', '/api/auth/verify', { token: linkToken(mailer, 'verify') })).status, 200);
    assert.equal((await login(OLD)).status, 200);

    assert.deepEqual((await api('POST', '/api/auth/forgot', { email: 'ana@example.com' })).body, { ok: true });
    await mailArrived(mailer, 2);
    const token = linkToken(mailer, 'reset');
    assert.ok(token);

    const check = await api('POST', '/api/auth/reset/check', { token });
    assert.equal(check.status, 200);
    assert.deepEqual(check.body, { email: 'ana@example.com' });

    assert.equal((await api('POST', '/api/auth/reset', { token, password: NEW })).status, 200);
    assert.equal((await login(NEW)).status, 200);
    assert.equal((await login(OLD)).status, 401);

    const again = await api('POST', '/api/auth/reset', { token, password: 'another long phrase here' });
    assert.equal(again.status, 400);
    assert.equal(again.body.error.code, 'link_invalid');
    assert.equal((await api('POST', '/api/auth/reset/check', { token })).status, 400);
  });
});
