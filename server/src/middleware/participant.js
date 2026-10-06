import { findParticipant, UNKNOWN_CODE } from '../participants/codes.js';
import { HttpError } from './errors.js';

export const PARTICIPANT_HEADER = 'x-participant';

// The participant making the request, from the X-Participant header ({ id, code }), or null when none was sent.
// A code that was sent but isn't on the list is a 401 with code 'participant_unknown', so the app shows the code
// screen again (e.g. after a withdrawal deleted it).
export function participantOf(db, req) {
  const raw = req.get(PARTICIPANT_HEADER);
  if (!raw) return null;
  const participant = findParticipant(db, raw);
  if (!participant) throw new HttpError(401, UNKNOWN_CODE, { code: 'participant_unknown' });
  return participant;
}

// Same, but a participant is required. -> { id, code }
export function requireParticipant(db, req) {
  const participant = participantOf(db, req);
  if (!participant) throw new HttpError(401, 'Type your participant code first.', { code: 'participant_required' });
  return participant;
}
