import { Router } from 'express';
import { z } from 'zod';
import { clearFailedLogins, findAccountByCode, listAccounts, setPassword, setTestLogin } from '../auth/accounts.js';
import { hashPassword, PASSWORD_MAX, PASSWORD_MIN, temporaryPassword } from '../auth/passwords.js';
import { revokeSessions } from '../auth/sessions.js';
import { HttpError } from '../middleware/errors.js';
import { logAdminEvent } from '../services/backup.js';
import { sessionTimeoutSeconds } from '../services/settings.js';

const testLoginBody = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
});

const NO_ACCOUNT = 'No account with that study ID.';

// The researcher's account list (Admin > Accounts), behind the PIN. Mounted at /api/admin. Emails and study IDs are
// shown together here and nowhere else; a temporary password is returned once and never logged or stored in plain text.
export function adminAccountsRouter({ db, clock = () => new Date(), requireAdmin }) {
  const router = Router();
  router.use(requireAdmin);

  const accountOr404 = (code) => {
    const account = findAccountByCode(db, code);
    if (!account) throw new HttpError(404, NO_ACCOUNT);
    return account;
  };

  router.get('/accounts', (_req, res) => {
    const timeout = sessionTimeoutSeconds(db);
    // emails: never kept by a browser or proxy cache
    res.set('cache-control', 'no-store').json({ timeout_s: timeout, accounts: listAccounts(db, clock(), timeout * 1000) });
  });

  // A temporary password: they are signed out, any lockout is lifted, and they choose a new password at the next sign-in.
  router.post('/accounts/:code/reset-password', async (req, res) => {
    const account = accountOr404(req.params.code);
    const temporary = temporaryPassword();
    const hash = await hashPassword(temporary);
    // hashing takes a while: the account may be gone by now, so look again before writing or logging anything
    accountOr404(req.params.code);
    db.transaction(() => {
      const now = clock();
      setPassword(db, account.id, hash, { mustChange: true, now });
      clearFailedLogins(db, account.id);
      revokeSessions(db, { accountId: account.id, participantId: account.participant_id, reason: 'password_reset', now });
      logAdminEvent(db, 'password_reset', account.code, now);
    })();
    res.set('cache-control', 'no-store').json({ temporary_password: temporary });
  });

  router.post('/accounts/:code/sign-out', (req, res) => {
    const account = accountOr404(req.params.code);
    const signedOut = db.transaction(() => {
      const now = clock();
      clearFailedLogins(db, account.id);
      const n = revokeSessions(db, { accountId: account.id, participantId: account.participant_id, reason: 'signed_out_by_admin', now });
      logAdminEvent(db, 'signed_out_by_admin', account.code, now);
      return n;
    })();
    res.json({ signed_out: signedOut });
  });

  // P00's own email and password, to try the app as a student without a study ID. Its records stay out of the export.
  router.put('/accounts/test-login', async (req, res) => {
    const parsed = testLoginBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new HttpError(400, `Enter a valid email and a password of ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`);
    const hash = await hashPassword(parsed.data.password);
    db.transaction(() => {
      const now = clock();
      const { accountId, participantId } = setTestLogin(db, { email: parsed.data.email, passwordHash: hash, now });
      revokeSessions(db, { accountId, participantId, reason: 'signed_out_by_admin', now });
      logAdminEvent(db, 'test_login_set', 'P00', now);
    })();
    res.json({ ok: true });
  });

  return router;
}
