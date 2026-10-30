import { findByToken, touch } from '../auth/sessions.js';
import { HttpError } from './errors.js';

const SIGN_IN_AGAIN = 'Please sign in again.';
// What a revoked login session says, by revoked_reason. 'signed_out' (and anything unexpected) reads as an unknown session.
const REVOKED = {
  signed_out_elsewhere: 'You were signed out because your account was opened on another device.',
  signed_out_by_admin: 'Your teacher signed you out. Sign in again.',
  password_reset: 'Your teacher reset your password. Sign in with the new one.',
};

const memo = new WeakMap(); // req -> the participant already worked out for it

const bearerOf = (req) => /^Bearer\s+(\S+)\s*$/i.exec(req.get('authorization') ?? '')?.[1] ?? null;

// The login session behind the request's Bearer token, or null when no token was sent. 401 for a token that is
// unknown or revoked. Does not look at must_change_password.
function bearerSession(db, req) {
  const token = bearerOf(req);
  if (!token) return null;
  const session = findByToken(db, token);
  if (!session) throw new HttpError(401, SIGN_IN_AGAIN, { code: 'session_unknown' });
  if (session.revoked_at) {
    const reason = session.revoked_reason;
    if (REVOKED[reason]) throw new HttpError(401, REVOKED[reason], { code: reason });
    throw new HttpError(401, SIGN_IN_AGAIN, { code: 'session_unknown' });
  }
  return session;
}

const nowOf = (req) => req.app.get('clock')?.() ?? new Date();

// Same Bearer lookup and 401s, without the must-change-password gate (for the /auth routes). null when no token was sent.
export function sessionOf(db, req) {
  const session = bearerSession(db, req);
  if (session) touch(db, session, nowOf(req));
  return session;
}

// The participant making the request ({ id, code, accountId, sessionId }), or null when the request says nobody.
// Checked once per request.
export function participantOf(db, req) {
  if (memo.has(req)) return memo.get(req);
  const participant = resolve(db, req);
  memo.set(req, participant);
  return participant;
}

function resolve(db, req) {
  const session = bearerSession(db, req);
  if (session) {
    if (session.must_change_password) throw new HttpError(403, 'Choose a new password first.', { code: 'password_change_required' });
    touch(db, session, nowOf(req));
    return { id: session.participant_id, code: session.code, accountId: session.account_id, sessionId: session.id };
  }

  return null;
}

// Same, but a participant is required.
export function requireParticipant(db, req) {
  const participant = participantOf(db, req);
  if (!participant) throw new HttpError(401, 'Sign in first.', { code: 'auth_required' });
  return participant;
}
