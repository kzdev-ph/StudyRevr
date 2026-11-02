import nodemailer from 'nodemailer';

const SEND_TIMEOUT_MS = 15_000;

// The one place that sends email. send() never throws and never logs the password, the account name, the sender or the recipient.
// Pass { transport } in tests so no real mail goes out.
export function createMailer(mail = {}, { transport, log = console.warn } = {}) {
  const configured = Boolean(mail.host && mail.user && mail.pass);
  if (!configured) return { configured: false, async send() { return false; } };

  transport ??= nodemailer.createTransport({
    host: mail.host,
    port: mail.port,
    secure: mail.port === 465,
    requireTLS: mail.port !== 465,
    auth: { user: mail.user, pass: mail.pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  const from = mail.from || `StudyRevr <${mail.user}>`;

  // The address inside "Name <address>", or the text itself
  const bare = (s) => /<([^>]+)>/.exec(s)?.[1] ?? s;
  // Hides the password, the account name, the sender and this message's recipient, longest first so a whole "Name <address>" goes before its parts
  const redact = (s, to) => {
    const secrets = [mail.pass, mail.user, from, bare(from), ...[].concat(to ?? [])].filter(Boolean).map(String).sort((a, b) => b.length - a.length);
    return secrets.reduce((out, secret) => out.split(secret).join('[redacted]'), String(s));
  };

  return {
    configured: true,
    async send({ to, subject, text }) {
      let timer;
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timed out')), SEND_TIMEOUT_MS);
        });
        await Promise.race([transport.sendMail({ from, to, subject, text }), timeout]);
        return true;
      } catch (err) {
        const message = redact(err?.message || '', to).slice(0, 200);
        log(`[mail] could not send "${subject}": ${redact(err?.code ?? '', to)} ${redact(err?.responseCode ?? '', to)} ${message}`);
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
