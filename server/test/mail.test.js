import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { fallbackBase, linkTo, parsePublicUrl } from '../src/mail/links.js';
import { createMailer } from '../src/mail/mailer.js';
import { resetMessage, verifyMessage } from '../src/mail/messages.js';

const parse = (raw) => {
  const warnings = [];
  const value = parsePublicUrl(raw, (m) => warnings.push(m));
  return { value, warnings };
};

describe('parsePublicUrl', () => {
  it('empty gives empty with no warning', () => {
    assert.deepEqual(parse(''), { value: '', warnings: [] });
    assert.deepEqual(parse(undefined), { value: '', warnings: [] });
  });

  it('drops the trailing slash and keeps the port', () => {
    assert.equal(parse('https://x.trycloudflare.com/').value, 'https://x.trycloudflare.com');
    assert.equal(parse('http://192.168.1.5:3001').value, 'http://192.168.1.5:3001');
  });

  it('ignores anything that is not a plain http(s) address, with one warning that does not echo the value', () => {
    for (const raw of ['javascript:x', 'https://u:secretpw@x', 'https://x/?a=1', 'https://x/#y', 'not a url']) {
      const { value, warnings } = parse(raw);
      assert.equal(value, '', raw);
      assert.equal(warnings.length, 1, raw);
      assert.match(warnings[0], /^\[config\] PUBLIC_URL ignored/);
      assert.ok(!warnings[0].includes('secretpw'));
    }
  });

  it('loadConfig reads PUBLIC_URL and the SMTP keys (app password spaces removed, port 465 by default)', () => {
    const c = loadConfig({ PUBLIC_URL: 'https://x.example/', SMTP_HOST: ' smtp.gmail.com ', SMTP_USER: 'a@b.c', SMTP_PASS: 'abcd efgh ijkl mnop' });
    assert.equal(c.publicUrl, 'https://x.example');
    assert.deepEqual(c.mail, { host: 'smtp.gmail.com', port: 465, user: 'a@b.c', pass: 'abcdefghijklmnop', from: '' });
    assert.equal(loadConfig({ SMTP_PORT: '587' }).mail.port, 587);
  });
});

describe('fallbackBase', () => {
  const nic = (address, internal = false) => ({ family: 'IPv4', address, internal });

  it('uses the first non-internal IPv4 address', () => {
    const ifaces = {
      lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      wifi: [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '192.168.1.7', internal: false }],
    };
    assert.equal(fallbackBase(3001, ifaces), 'http://192.168.1.7:3001');
  });

  it('prefers 192.168.x.x, then 10.x.x.x, then 172.16-31.x.x, then any other, over adapter order', () => {
    const pick = (...addresses) => fallbackBase(3001, { all: addresses.map((a) => nic(a)) });
    // a WSL / Hyper-V adapter listed before the Wi-Fi
    assert.equal(pick('172.24.80.1', '192.168.1.7'), 'http://192.168.1.7:3001');
    assert.equal(pick('172.24.80.1', '10.0.0.5', '192.168.1.7'), 'http://192.168.1.7:3001');
    assert.equal(pick('203.0.113.4', '172.17.0.1', '10.1.2.3'), 'http://10.1.2.3:3001');
    assert.equal(pick('203.0.113.4', '172.31.0.1'), 'http://172.31.0.1:3001');
    assert.equal(pick('203.0.113.4', '172.32.0.1'), 'http://203.0.113.4:3001', '172.32 is not a private range');
    assert.equal(pick('192.168.1.7', '192.168.56.1'), 'http://192.168.1.7:3001', 'the first of equals');
    assert.equal(pick('169.254.1.1', '203.0.113.4'), 'http://169.254.1.1:3001', 'any: the first');
  });

  it('falls back to localhost when there is only an internal address', () => {
    assert.equal(fallbackBase(3001, { lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] }), 'http://localhost:3001');
  });

  it('linkTo puts the token after the #', () => {
    assert.equal(linkTo('https://x.example', 'verify', 'abc'), 'https://x.example/#/verify/abc');
  });
});

describe('createMailer', () => {
  const full = { host: 'smtp.example.com', port: 465, user: 'sender@example.com', pass: 'hunter2pass' };

  it('is off when host, user or pass is missing', async () => {
    for (const missing of ['host', 'user', 'pass']) {
      const mailer = createMailer({ ...full, [missing]: '' }, { transport: { sendMail: async () => { throw new Error('must not be called'); } } });
      assert.equal(mailer.configured, false, missing);
      assert.equal(await mailer.send({ to: 'x@y.z', subject: 's', text: 't' }), false);
    }
    assert.equal(createMailer().configured, false);
  });

  it('sends through the transport and returns true', async () => {
    const sent = [];
    const mailer = createMailer(full, { transport: { sendMail: async (m) => { sent.push(m); return {}; } } });
    assert.equal(mailer.configured, true);
    assert.equal(await mailer.send({ to: 'x@y.z', subject: 'Hi', text: 'body' }), true);
    assert.deepEqual(sent, [{ from: 'StudyRevr <sender@example.com>', to: 'x@y.z', subject: 'Hi', text: 'body' }]);
  });

  it('a failing transport returns false and the log line holds no password, account name or recipient', async () => {
    const lines = [];
    // the server's own words repeat the recipient and the from address, as real SMTP errors do
    const err = Object.assign(new Error('Invalid login for sender@example.com with hunter2pass; rejected recipient student@school.edu from StudyRevr <sender@example.com>'), { code: 'EAUTH', responseCode: 535 });
    const mailer = createMailer(full, { transport: { sendMail: async () => { throw err; } }, log: (l) => lines.push(l) });
    assert.equal(await mailer.send({ to: 'student@school.edu', subject: 'Subj', text: 't' }), false);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[mail\] could not send "Subj": EAUTH 535 /);
    assert.ok(lines[0].includes('[redacted]'));
    for (const secret of ['hunter2pass', 'sender@example.com', 'student@school.edu', 'StudyRevr <']) assert.ok(!lines[0].includes(secret), secret);
  });

  it('a custom from address is also kept out of the log line', async () => {
    const lines = [];
    const from = 'Study Team <noreply@school.edu>';
    const err = new Error('550 rejected student@school.edu sent as Study Team <noreply@school.edu> (noreply@school.edu)');
    const mailer = createMailer({ ...full, from }, { transport: { sendMail: async () => { throw err; } }, log: (l) => lines.push(l) });
    assert.equal(await mailer.send({ to: 'student@school.edu', subject: 'Subj', text: 't' }), false);
    assert.equal(lines.length, 1);
    for (const secret of ['student@school.edu', 'noreply@school.edu', 'Study Team']) assert.ok(!lines[0].includes(secret), secret);
  });
});

describe('messages', () => {
  const link = 'https://x.example/#/verify/tok123';

  it('verify: the link, 24 hours, plain text', () => {
    const { subject, text } = verifyMessage(link);
    assert.equal(subject, 'Verify your email for StudyRevr');
    assert.ok(text.includes(link) && text.includes('24 hours') && text.includes('Verify my email'));
    assert.ok(!/<[a-z]/i.test(text));
    assert.ok(!/\bP\d{1,3}\b/.test(text.replace(link, '')));
  });

  it('reset: the link, 30 minutes, plain text', () => {
    const { subject, text } = resetMessage(link);
    assert.equal(subject, 'Reset your StudyRevr password');
    assert.ok(text.includes(link) && text.includes('30 minutes'));
    assert.ok(!/<[a-z]/i.test(text));
    assert.ok(!/\bP\d{1,3}\b/.test(text.replace(link, '')));
  });
});
