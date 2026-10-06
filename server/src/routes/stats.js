import { Router } from 'express';
import { loadSchedulerConfig } from '../flashcards/config.js';
import { requireParticipant } from '../middleware/participant.js';
import { participantStats } from '../stats/participant.js';

// The Stats tab for the participant in X-Participant. Viewing it is logged by the app (a stats_view event), not here,
// so the admin can look at someone's stats without counting as their view.
export function statsRouter({ db, clock = () => new Date() }) {
  const router = Router();
  router.get('/stats', (req, res) => {
    const participant = requireParticipant(db, req);
    res.json(participantStats(db, participant, { now: clock(), config: loadSchedulerConfig(db) }));
  });
  return router;
}
