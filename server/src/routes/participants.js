import { Router } from 'express';
import { findParticipant, normalizeCode, UNKNOWN_CODE } from '../participants/codes.js';
import { HttpError } from '../middleware/errors.js';

const MAX_TRIES = 5;
const LOCK_MS = 60_000;

// The code screen's only call: is this typed code on the list? There is deliberately no way to list or create codes
// here; the researcher adds them in admin. Like the admin PIN, after MAX_TRIES unknown codes from one address that
// address waits LOCK_MS (429), so the list can't be walked by guessing. `clock` is () => ms (tests pass a fake).
export function participantsRouter({ db, clock = Date.now }) {
  const router = Router();
  const failures = new Map(); // address -> { count, lockedUntil }

  router.get('/participants/:code', (req, res) => {
    const who = req.ip ?? 'unknown';
    const now = clock();
    const record = failures.get(who);
    if (record?.lockedUntil > now) {
      const seconds = Math.ceil((record.lockedUntil - now) / 1000);
      throw new HttpError(429, `Too many wrong codes. Try again in ${seconds} s.`, { code: 'participant_locked' });
    }
    if (!normalizeCode(req.params.code)) throw new HttpError(400, 'Codes look like P01.');
    const participant = findParticipant(db, req.params.code);
    if (!participant) {
      const count = (record && !(record.lockedUntil > 0) ? record.count : 0) + 1;
      failures.set(who, count >= MAX_TRIES ? { count: 0, lockedUntil: now + LOCK_MS } : { count, lockedUntil: 0 });
      throw new HttpError(404, UNKNOWN_CODE, { code: 'participant_unknown' });
    }
    failures.delete(who);
    res.json({ participant: { code: participant.code } });
  });

  return router;
}
