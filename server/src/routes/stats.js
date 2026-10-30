import { Router } from 'express';
import { loadSchedulerConfig } from '../flashcards/config.js';
import { requireParticipant } from '../middleware/participant.js';
import { participantStats } from '../stats/participant.js';

// The Stats tab for the signed-in participant. Viewing it is logged by the app (a stats_view event), not here,
// so the admin can look at someone's stats without counting as their view.
export function statsRouter({ db, clock = () => new Date() }) {
  const router = Router();
  router.get('/stats', (req, res) => {
    const participant = requireParticipant(db, req);
    // Students never see their study ID (the P-code); the admin's view of the same numbers (routes/admin.js) keeps it.
    const { participant: _code, ...stats } = participantStats(db, participant, { now: clock(), config: loadSchedulerConfig(db) });
    res.json(stats);
  });
  return router;
}
