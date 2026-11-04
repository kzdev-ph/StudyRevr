import { Router } from 'express';
import { z } from 'zod';
import { assertNotLocked, clearFailedLogins, createAccount, findAccountByEmail, lockedError, lockedMs, recordFailedLogin, setPassword } from '../auth/accounts.js';
import { isCommonPassword } from '../auth/common-passwords.js';
import { consumeEmailToken, findEmailToken, markVerified, TOKEN_SHAPE } from '../auth/email-tokens.js';
import { createLimiter, limiterKey } from '../auth/limiter.js';
import { hashPassword, PASSWORD_MAX, PASSWORD_MIN, verifyDummy, verifyPassword } from '../auth/passwords.js';
import { activeSession, createAuthSession, replaceSession, revokeSessions } from '../auth/sessions.js';
import { HttpError } from '../middleware/errors.js';
import { sessionOf } from '../middleware/participant.js';
import { sendResetEmail, sendVerifyEmail } from '../services/account-email.js';
import { sessionTimeoutSeconds, signupsAllowed } from '../services/settings.js';

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const signupBody = z.strictObject({ email, password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX) });
const loginBody = z.strictObject({ email, password: z.string().min(1).max(PASSWORD_MAX), takeover: z.boolean().optional() });
const passwordBody = z.strictObject({ current: z.string().min(1).max(PASSWORD_MAX), next: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX) });
const emailBody = z.strictObject({ email });
const tokenBody = z.strictObject({ token: z.string().regex(TOKEN_SHAPE) });
const resetBody = z.strictObject({ token: z.string().regex(TOKEN_SHAPE), password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX) });

const UNVERIFIED = 'Verify your email first. Open the link we sent to your Gmail inbox, then sign in.';
const VERIFY_LINK_BAD = 'This link has expired or was already used. If your email still needs verifying, go to sign in to get a new link.';
const TOO_MANY = 'Too many requests from here. Try again in a few minutes.';
const RESET_LINK_BAD = 'This reset link has expired or was already used. Ask for a new one with "Forgot password?".';
const RESET_OFF = 'Password reset by email is not available here. Ask your teacher to reset your password.';
const linkBad = () => new HttpError(400, RESET_LINK_BAD, { code: 'link_invalid' });

// The limit is per req.ip (an IPv6 /64 counts as one, limiterKey). Behind the tunnel, `trust proxy` (app.js) gives each student their own IP, so each has their own
// limit (10 sign-ups per 10 minutes). Sign-ups also use up study numbers, which are never reused: switch them off in
// Admin once everyone is enrolled.
const SIGNUPS_PER_WINDOW = 10;
const SIGNUP_WINDOW_MS = 10 * 60_000;
// Wrong sign-ins (unknown email or wrong password) per IP: one address can't run scrypt without end or walk through
// accounts locking them; a class behind one address still has room.
const LOGIN_FAILS_PER_WINDOW = 30;
const LOGIN_FAIL_WINDOW_MS = 15 * 60_000;

// Only for a password someone chooses (sign-up, change); never for sign-in or a teacher's temporary password.
function assertNotCommon(password, email) {
  if (isCommonPassword(password, email)) throw new HttpError(400, 'That password is too common. Try a longer phrase.', { code: 'password_too_common' });
}

function parseBody(schema, body, message) {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new HttpError(400, message);
  return parsed.data;
}

const accountOf = (row) => ({ email: row.email, must_change_password: Boolean(row.must_change_password) });

// Sign-up, sign-in, sign-out and the signed-in account's own details. Mounted at /api. The response never carries the
// study ID (the P-code), and neither passwords nor tokens are logged.
export function authRouter({ db, clock = () => new Date(), mailer = { configured: false, send: async () => false }, linkBase = '', emailOn = mailer.configured, sendCap }) {
  const router = Router();
  const signups = createLimiter({ max: SIGNUPS_PER_WINDOW, windowMs: SIGNUP_WINDOW_MS }); // sign-up attempts per IP
  const loginFails = createLimiter({ max: LOGIN_FAILS_PER_WINDOW, windowMs: LOGIN_FAIL_WINDOW_MS }); // wrong sign-ins per IP
  const emailIps = createLimiter({ max: 10, windowMs: 15 * 60_000 }); // verification-email requests per IP
  const emailAccounts = createLimiter({ max: 3, windowMs: 15 * 60_000 }); // verification emails per account

  // The signed-in login session, or a 401 when the request carries no token.
  const requireSession = (req) => {
    const session = sessionOf(db, req);
    if (!session) throw new HttpError(401, 'Sign in first.', { code: 'auth_required' });
    return session;
  };

  router.post('/auth/signup', async (req, res) => {
    if (!signupsAllowed(db)) throw new HttpError(403, 'Sign-ups are closed. Ask your teacher.', { code: 'signups_off' });
    const now = clock();
    if (signups.limited(limiterKey(req.ip), now.getTime())) throw new HttpError(429, 'Too many sign-ups from here. Try again in a few minutes.', { code: 'signup_rate_limited' });
    const body = parseBody(signupBody, req.body, `Enter a valid email and a password of ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`);
    assertNotCommon(body.password, body.email);
    const verified = !mailer.configured;
    const { accountId } = createAccount(db, { email: body.email, passwordHash: await hashPassword(body.password), now, verified });
    if (!verified) {
      // No sign-in yet: the person opens the emailed link first. The first email counts against the account's limit.
      emailAccounts.limited(`verify:${accountId}`, now.getTime());
      const sent = await sendVerifyEmail({ db, mailer, linkBase, account: { id: accountId, email: body.email }, now, sendCap });
      res.status(201).json({ verify_email: true, email_sent: sent });
      return;
    }
    const token = createAuthSession(db, accountId, now);
    res.status(201).json({ token, account: { email: body.email, must_change_password: false } });
  });

  router.post('/auth/login', async (req, res) => {
    const body = parseBody(loginBody, req.body, 'Enter your email and password.');
    const ipKey = limiterKey(req.ip);
    if (loginFails.over(ipKey, clock().getTime())) throw new HttpError(429, TOO_MANY, { code: 'login_rate_limited' });
    const account = findAccountByEmail(db, body.email);
    if (!account) {
      loginFails.limited(ipKey, clock().getTime());
      await verifyDummy(body.password);
      throw new HttpError(401, 'Email or password is wrong.', { code: 'login_failed' });
    }
    const locked = lockedMs(account, clock());
    if (locked > 0) throw lockedError(locked);

    const correct = await verifyPassword(body.password, account.password_hash);
    // Parallel guesses all passed the check above before scrypt finished: look again, so those that started before the
    // lock was set answer 429 without counting, and sign nobody in even with the right password.
    assertNotLocked(db, account.id, clock());
    if (!correct) {
      loginFails.limited(ipKey, clock().getTime());
      const { lockedMs: wait } = recordFailedLogin(db, account, clock());
      if (wait > 0) throw lockedError(wait);
      throw new HttpError(401, 'Email or password is wrong.', { code: 'login_failed' });
    }
    clearFailedLogins(db, account.id);
    if (emailOn && !account.email_verified) throw new HttpError(403, UNVERIFIED, { code: 'email_unverified' });

    // One live login per account: a device that was seen within the timeout is asked about first.
    const token = db.transaction(() => {
      const now = clock();
      // the password was checked against the hash read before scrypt: a reset that landed meanwhile wins
      const current = db.prepare('SELECT password_hash FROM accounts WHERE id = ?').get(account.id);
      if (current?.password_hash !== account.password_hash) throw new HttpError(401, 'Email or password is wrong.', { code: 'login_failed' });
      const active = activeSession(db, account.id);
      if (active) {
        const busy = now.getTime() - Date.parse(active.last_seen_at) < sessionTimeoutSeconds(db) * 1000;
        if (busy && !body.takeover) {
          throw new HttpError(409, 'This account is active on another device. Continue here?', { code: 'active_elsewhere' });
        }
        revokeSessions(db, { accountId: account.id, participantId: account.participant_id, reason: 'signed_out_elsewhere', now });
      }
      return createAuthSession(db, account.id, now);
    })();
    res.json({ token, account: accountOf(account) });
  });

  // The link in the verification email. Opens no login session: the person signs in afterwards.
  router.post('/auth/verify', (req, res) => {
    const parsed = tokenBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new HttpError(400, VERIFY_LINK_BAD, { code: 'link_invalid' });
    db.transaction(() => {
      const row = findEmailToken(db, { token: parsed.data.token, purpose: 'verify', now: clock() });
      if (!row || !consumeEmailToken(db, row.id)) throw new HttpError(400, VERIFY_LINK_BAD, { code: 'link_invalid' });
      markVerified(db, row.account_id);
    })();
    res.json({ ok: true });
  });

  // Same answer and timing whether or not the email belongs to an account that needs a link: the answer goes out first,
  // and the token write and the send happen after it.
  router.post('/auth/verify/resend', (req, res) => {
    if (!mailer.configured) throw new HttpError(503, 'Email is not set up here. Ask your teacher to verify your account.', { code: 'email_off' });
    const body = parseBody(emailBody, req.body, 'Enter a valid email.');
    const now = clock();
    if (emailIps.limited(limiterKey(req.ip), now.getTime())) throw new HttpError(429, TOO_MANY, { code: 'email_rate_limited' });
    const account = findAccountByEmail(db, body.email);
    const send = account && !account.email_verified && !emailAccounts.limited(`verify:${account.id}`, now.getTime());
    res.status(202).json({ ok: true });
    if (send) setImmediate(() => sendVerifyEmail({ db, mailer, linkBase, account: { id: account.id, email: account.email }, now, sendCap }).catch(() => {}));
  });

  // Always the same answer, whether or not the email has an account: the answer goes out first, and the token write and
  // the send happen after it. An unverified account gets a reset link too (it proves the inbox).
  router.post('/auth/forgot', (req, res) => {
    if (!mailer.configured) throw new HttpError(503, RESET_OFF, { code: 'email_off' });
    const body = parseBody(emailBody, req.body, 'Enter a valid email.');
    const now = clock();
    if (emailIps.limited(limiterKey(req.ip), now.getTime())) throw new HttpError(429, TOO_MANY, { code: 'email_rate_limited' });
    const account = findAccountByEmail(db, body.email);
    const send = account && !emailAccounts.limited(`reset:${account.id}`, now.getTime());
    res.status(202).json({ ok: true });
    if (send) setImmediate(() => sendResetEmail({ db, mailer, linkBase, account: { id: account.id, email: account.email }, now, sendCap }).catch(() => {}));
  });

  // Read-only: lets the reset page show which account the link is for before a password is typed.
  router.post('/auth/reset/check', (req, res) => {
    const parsed = tokenBody.safeParse(req.body ?? {});
    const link = parsed.success ? findEmailToken(db, { token: parsed.data.token, purpose: 'reset', now: clock() }) : null;
    if (!link) throw linkBad();
    res.set('cache-control', 'no-store').json({ email: link.email });
  });

  // The link is looked at before the password so a bad link is told so first; a too-short or common password leaves the
  // link usable. Every login session ends: the new password is the only way back in.
  router.post('/auth/reset', async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const link = findEmailToken(db, { token, purpose: 'reset', now: clock() });
    if (!link) throw linkBad();
    const body = parseBody(resetBody, req.body, `Choose a password of ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`);
    assertNotCommon(body.password, link.email);
    const hash = await hashPassword(body.password);
    db.transaction(() => {
      const now = clock();
      const live = findEmailToken(db, { token, purpose: 'reset', now }); // scrypt took a while: look again
      if (!live || !consumeEmailToken(db, live.id)) throw linkBad();
      setPassword(db, live.account_id, hash, { mustChange: false, now });
      clearFailedLogins(db, live.account_id);
      markVerified(db, live.account_id); // they proved they read this inbox
      db.prepare("DELETE FROM email_tokens WHERE account_id = ? AND purpose = 'reset'").run(live.account_id);
      revokeSessions(db, { accountId: live.account_id, participantId: live.participant_id, reason: 'password_reset', studyEndReason: 'signed_out', now });
    })();
    res.json({ ok: true });
  });

  router.post('/auth/logout', (req, res) => {
    const session = requireSession(req);
    revokeSessions(db, { accountId: session.account_id, participantId: session.participant_id, reason: 'signed_out', now: clock(), sessionId: session.id });
    res.status(204).end();
  });

  // Also the presence ping: sessionOf notes that this device is still here.
  router.get('/auth/me', (req, res) => {
    res.json({ account: accountOf(requireSession(req)) });
  });

  router.post('/auth/password', async (req, res) => {
    const session = requireSession(req);
    const body = parseBody(passwordBody, req.body, `Enter your current password and a new one of ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`);
    if (body.next === body.current) throw new HttpError(400, 'Choose a new password that is different from the current one.', { code: 'same_password' });
    assertNotCommon(body.next, session.email);
    // The same lock and counter as sign-in: a stolen token must not be a way to guess the password.
    const account = db.prepare('SELECT id, password_hash, locked_until FROM accounts WHERE id = ?').get(session.account_id);
    const locked = lockedMs(account, clock());
    if (locked > 0) throw lockedError(locked);
    const correct = await verifyPassword(body.current, account.password_hash);
    assertNotLocked(db, account.id, clock());
    if (!correct) {
      const { lockedMs: wait } = recordFailedLogin(db, account, clock());
      if (wait > 0) throw lockedError(wait);
      throw new HttpError(401, "That isn't your current password.", { code: 'wrong_password' });
    }
    const hash = await hashPassword(body.next);

    // The password changes and the login session is swapped for a new token; the open study session carries on.
    const token = db.transaction(() => {
      const now = clock();
      const fresh = replaceSession(db, { accountId: account.id, sessionId: session.id, now });
      if (!fresh) throw new HttpError(401, 'Sign in first.', { code: 'auth_required' });
      setPassword(db, account.id, hash, { mustChange: false, now });
      clearFailedLogins(db, account.id);
      db.prepare("DELETE FROM email_tokens WHERE account_id = ? AND purpose = 'reset'").run(account.id); // an emailed reset link dies too
      return fresh;
    })();
    res.json({ token, account: accountOf({ email: session.email, must_change_password: 0 }) });
  });

  return router;
}
