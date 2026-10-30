import { Router } from 'express';
import { z } from 'zod';
import { assertNotLocked, clearFailedLogins, createAccount, findAccountByEmail, lockedError, lockedMs, recordFailedLogin, setPassword } from '../auth/accounts.js';
import { isCommonPassword } from '../auth/common-passwords.js';
import { hashPassword, PASSWORD_MAX, PASSWORD_MIN, verifyDummy, verifyPassword } from '../auth/passwords.js';
import { activeSession, createAuthSession, replaceSession, revokeSessions } from '../auth/sessions.js';
import { HttpError } from '../middleware/errors.js';
import { sessionOf } from '../middleware/participant.js';
import { sessionTimeoutSeconds, signupsAllowed } from '../services/settings.js';

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const signupBody = z.strictObject({ email, password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX) });
const loginBody = z.strictObject({ email, password: z.string().min(1).max(PASSWORD_MAX), takeover: z.boolean().optional() });
const passwordBody = z.strictObject({ current: z.string().min(1).max(PASSWORD_MAX), next: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX) });

// The limit is per req.ip. Behind a reverse proxy without `trust proxy` every student shares one IP, so they share this
// limit too (10 sign-ups per 10 minutes for the whole class). Sign-ups also use up study numbers, which are never
// reused: switch them off in Admin once everyone is enrolled.
const SIGNUPS_PER_WINDOW = 10;
const SIGNUP_WINDOW_MS = 10 * 60_000;

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
export function authRouter({ db, clock = () => new Date() }) {
  const router = Router();
  const signups = new Map(); // ip -> times of its recent sign-up attempts (in memory; a restart clears it)

  // The signed-in login session, or a 401 when the request carries no token.
  const requireSession = (req) => {
    const session = sessionOf(db, req);
    if (!session) throw new HttpError(401, 'Sign in first.', { code: 'auth_required' });
    return session;
  };

  const rateLimited = (ip, now) => {
    const recent = (signups.get(ip) ?? []).filter((at) => now - at < SIGNUP_WINDOW_MS);
    if (recent.length >= SIGNUPS_PER_WINDOW) {
      signups.set(ip, recent);
      return true;
    }
    signups.set(ip, [...recent, now]);
    if (signups.size > 1000) for (const [key, times] of signups) if (times.every((at) => now - at >= SIGNUP_WINDOW_MS)) signups.delete(key);
    return false;
  };

  router.post('/auth/signup', async (req, res) => {
    if (!signupsAllowed(db)) throw new HttpError(403, 'Sign-ups are closed. Ask your teacher.', { code: 'signups_off' });
    const now = clock();
    if (rateLimited(req.ip, now.getTime())) throw new HttpError(429, 'Too many sign-ups from here. Try again in a few minutes.', { code: 'signup_rate_limited' });
    const body = parseBody(signupBody, req.body, `Enter a valid email and a password of ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`);
    assertNotCommon(body.password, body.email);
    const { accountId } = createAccount(db, { email: body.email, passwordHash: await hashPassword(body.password), now });
    const token = createAuthSession(db, accountId, now);
    res.status(201).json({ token, account: { email: body.email, must_change_password: false } });
  });

  router.post('/auth/login', async (req, res) => {
    const body = parseBody(loginBody, req.body, 'Enter your email and password.');
    const account = findAccountByEmail(db, body.email);
    if (!account) {
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
      const { lockedMs: wait } = recordFailedLogin(db, account, clock());
      if (wait > 0) throw lockedError(wait);
      throw new HttpError(401, 'Email or password is wrong.', { code: 'login_failed' });
    }
    clearFailedLogins(db, account.id);

    // One live login per account: a device that was seen within the timeout is asked about first.
    const token = db.transaction(() => {
      const now = clock();
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
      return fresh;
    })();
    res.json({ token, account: accountOf({ email: session.email, must_change_password: 0 }) });
  });

  return router;
}
