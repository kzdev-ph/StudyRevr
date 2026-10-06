import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import { EXPORT_FILES, exportCsv, exportZip } from '../export/research.js';
import { loadSchedulerConfig } from '../flashcards/config.js';
import { HttpError } from '../middleware/errors.js';
import { lastBackup, logAdminEvent, makeBackup, removeTemp } from '../services/backup.js';
import { addParticipants, findParticipant, parseCodeList, UNKNOWN_CODE } from '../participants/codes.js';
import { deleteAllStudentKeys } from '../services/student-ai.js';
import { participantStats, summaryTable } from '../stats/participant.js';

const addBody = z.object({ codes: z.string().max(2000) });

// The researcher's admin area. Every route here sits behind requireAdmin (ADMIN_PIN). Mounted at /api/admin.
export function adminRouter({ db, clock = () => new Date(), requireAdmin }) {
  const router = Router();
  router.use(requireAdmin);
  const opts = (req) => ({ now: clock(), config: loadSchedulerConfig(db), includeP00: ['1', 'true', 'yes'].includes(String(req.query.include_p00 ?? '')) });
  const stamp = () => clock().toISOString().slice(0, 16).replace(/[-:T]/g, '');

  // Lets the app check a PIN before showing the admin screen.
  router.post('/unlock', (_req, res) => res.status(204).end());

  // Every participant (P00 too, marked) with their summary columns, for the admin table.
  router.get('/participants', (req, res) => {
    const { columns, lessons, rows } = summaryTable(db, { ...opts(req), includeP00: true });
    res.json({ columns, lessons, participants: rows });
  });

  // Adds codes: { codes: "P01-P10, P12" }. Codes that already exist are skipped.
  router.post('/participants', (req, res) => {
    const body = addBody.safeParse(req.body ?? {});
    if (!body.success) throw new HttpError(400, 'Send codes, e.g. "P01-P10" or "P01, P02".');
    res.status(201).json(addParticipants(db, parseCodeList(body.data.codes), clock()));
  });

  router.get('/participants/:code/stats', (req, res) => {
    const participant = findParticipant(db, req.params.code);
    if (!participant) throw new HttpError(404, UNKNOWN_CODE);
    res.json(participantStats(db, participant, opts(req)));
  });

  router.get('/export.zip', async (req, res, next) => {
    try {
      const zip = await exportZip(db, opts(req));
      res.set({ 'content-type': 'application/zip', 'content-disposition': `attachment; filename="studyrevr-export-${stamp()}.zip"`, 'cache-control': 'no-store' });
      res.send(zip);
    } catch (e) {
      next(e);
    }
  });

  router.get('/export/:file', (req, res) => {
    const name = String(req.params.file).replace(/\.csv$/, '');
    if (!EXPORT_FILES.includes(name)) throw new HttpError(404, `No such export. Files: ${EXPORT_FILES.map((f) => `${f}.csv`).join(', ')}.`);
    res.set({ 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}.csv"`, 'cache-control': 'no-store' });
    // a byte-order mark so Excel reads the UTF-8 (Filipino text, curly quotes) correctly
    res.send(`﻿${exportCsv(db, name, opts(req))}`);
  });

  // A copy of the whole database without any API key (see services/backup.js), made while the app runs.
  router.get('/backup', async (_req, res, next) => {
    let made;
    try {
      made = await makeBackup(db, { now: clock() });
      const data = fs.readFileSync(made.file);
      logAdminEvent(db, 'backup', made.name, clock());
      res.set({ 'content-type': 'application/vnd.sqlite3', 'content-disposition': `attachment; filename="${made.name}"`, 'cache-control': 'no-store' });
      res.send(data);
    } catch (e) {
      next(e);
    } finally {
      if (made) removeTemp(made.file);
    }
  });

  // After the study: removes every student's saved AI key. The keys are overwritten in the file (secure_delete).
  router.delete('/student-keys', (_req, res) => {
    const deleted = deleteAllStudentKeys(db);
    logAdminEvent(db, 'student_keys_deleted', String(deleted), clock());
    res.json({ deleted });
  });

  // When the last backup was downloaded: { last: { file, created_at } | null }
  router.get('/backup/last', (_req, res) => res.json({ last: lastBackup(db) }));

  return router;
}
