import { Router } from 'express';
import { requireParticipant } from '../middleware/participant.js';
import { uploadStatus } from '../services/student-upload.js';

// What the library shows a student about uploading: { allowed, per_day, used_today, left_today, max_mb }.
// `allowed` is admin's switch ("Allow students to upload lessons"); the upload button exists only while it is on.
export function myUploadsRouter({ db, config, clock = () => new Date() }) {
  const router = Router();
  router.get('/my-uploads', (req, res) => {
    const participant = requireParticipant(db, req);
    res.json(uploadStatus(db, participant, clock(), config.maxUploadBytes));
  });
  return router;
}
