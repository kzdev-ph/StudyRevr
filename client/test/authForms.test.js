import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EMAIL_SHAPE, PASSWORD_MAX, PASSWORD_MIN, emailIsOn, forgotFooter, inboxName, isGmail, newPasswordProblem } from '../src/lib/authForms.js';

describe('forgotFooter', () => {
  it('shows nothing until the health call answers', () => {
    assert.equal(forgotFooter(undefined), 'wait');
  });
  it('shows the link when email is on', () => {
    assert.equal(forgotFooter({ ok: true, email: true }), 'link');
  });
  it('shows the teacher line when email is off, missing, or the call failed', () => {
    for (const answer of [{ ok: true, email: false }, { ok: true }, null]) assert.equal(forgotFooter(answer), 'teacher');
  });
});

describe('inboxName', () => {
  it('says your Gmail inbox for gmail.com and googlemail.com, in any letter case', () => {
    for (const email of ['a@gmail.com', 'A@Gmail.COM', ' a@googlemail.com ']) {
      assert.equal(isGmail(email), true, email);
      assert.equal(inboxName(email), 'your Gmail inbox', email);
    }
  });
  it('says your inbox for any other domain or no address', () => {
    for (const email of ['a@school.edu.ph', 'a@yahoo.com', 'a@notgmail.com', 'a@gmail.com.ph', '', undefined]) {
      assert.equal(isGmail(email), false, String(email));
      assert.equal(inboxName(email), 'your inbox', String(email));
    }
  });
});

describe('emailIsOn', () => {
  it('is on only when the server says so', () => {
    assert.equal(emailIsOn({ ok: true, admin: true, email: true }), true);
    assert.equal(emailIsOn({ ok: true, admin: true, email: false }), false);
  });
  it('is off when the field is missing or the call failed', () => {
    for (const health of [{ ok: true }, { email: 'yes' }, null, undefined]) assert.equal(emailIsOn(health), false);
  });
});

describe('newPasswordProblem', () => {
  it('asks for both boxes', () => {
    assert.equal(newPasswordProblem('', ''), 'Enter the new password twice.');
    assert.equal(newPasswordProblem('longenough', ''), 'Enter the new password twice.');
    assert.equal(newPasswordProblem('', 'longenough'), 'Enter the new password twice.');
  });
  it('checks the length', () => {
    assert.match(newPasswordProblem('x'.repeat(PASSWORD_MIN - 1), 'x'.repeat(PASSWORD_MIN - 1)), /at least 8/);
    assert.match(newPasswordProblem('x'.repeat(PASSWORD_MAX + 1), 'x'.repeat(PASSWORD_MAX + 1)), /at most 200/);
    assert.equal(newPasswordProblem('x'.repeat(PASSWORD_MIN), 'x'.repeat(PASSWORD_MIN)), null);
    assert.equal(newPasswordProblem('x'.repeat(PASSWORD_MAX), 'x'.repeat(PASSWORD_MAX)), null);
  });
  it('needs the two to match', () => {
    assert.equal(newPasswordProblem('password1', 'password2'), 'The two passwords are not the same. Type them again.');
    assert.equal(newPasswordProblem('password1', 'password1'), null);
  });
});

describe('EMAIL_SHAPE', () => {
  it('accepts an address and rejects obvious non-addresses', () => {
    assert.equal(EMAIL_SHAPE.test('a@b.co'), true);
    for (const bad of ['', 'a@b', 'a b@c.co', '@b.co']) assert.equal(EMAIL_SHAPE.test(bad), false, bad);
  });
});
