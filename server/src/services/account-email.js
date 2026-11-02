import { createLimiter } from '../auth/limiter.js';
import { issueEmailToken } from '../auth/email-tokens.js';
import { linkTo } from '../mail/links.js';
import { resetMessage, verifyMessage } from '../mail/messages.js';

const SENDS_PER_HOUR = 60;

// One cap on the emails the whole server sends (verification and reset, whoever asks). Made once in app.js and shared.
export const createSendCap = () => createLimiter({ max: SENDS_PER_HOUR, windowMs: 60 * 60_000 });

// Makes a new one-time link for the account and emails it. -> true when the mail was handed to the mail server, false
// when email is off, the hourly cap is reached or the send failed (the caller decides what to tell the person). With
// email off, or over the cap, no token is made.
async function sendLink({ db, mailer, linkBase, account, now, sendCap }, purpose, message) {
  if (!mailer.configured) return false;
  if (sendCap?.limited('mail', now.getTime())) {
    console.warn('[mail] hourly send cap reached');
    return false;
  }
  const token = issueEmailToken(db, { accountId: account.id, purpose, now });
  return mailer.send({ to: account.email, ...message(linkTo(linkBase, purpose, token)) });
}

export const sendVerifyEmail = (args) => sendLink(args, 'verify', verifyMessage);
export const sendResetEmail = (args) => sendLink(args, 'reset', resetMessage);
