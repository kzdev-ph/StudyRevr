import { Router } from 'express';
import { findParticipant, normalizeCode, UNKNOWN_CODE } from '../participants/codes.js';
import { HttpError } from '../middleware/errors.js';

// The code screen's only call: is this typed code on the list? There is deliberately no way to list or create codes
// here; the researcher adds them in admin.
export function participantsRouter({ db }) {
  const router = Router();

  router.get('/participants/:code', (req, res) => {
    if (!normalizeCode(req.params.code)) throw new HttpError(400, 'Codes look like P01.');
    const participant = findParticipant(db, req.params.code);
    if (!participant) throw new HttpError(404, UNKNOWN_CODE, { code: 'participant_unknown' });
    res.json({ participant: { code: participant.code } });
  });

  return router;
}
